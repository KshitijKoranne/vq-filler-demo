import { NextResponse } from 'next/server';
import { extractQuestionsFromDocx, fillDocx } from '@/lib/docx';
import { retrieveContext } from '@/lib/rag';
import { answerQuestion } from '@/lib/ai';
import { buildQmdQuery } from '@/lib/qmd';
import { exceedsContentLength, MAX_FILL_REQUEST_BYTES, MAX_FINALIZE_ANSWERS, MAX_QUESTIONNAIRE_BYTES } from '@/lib/security';
import { getTrialStatus, trialInactiveResponse } from '@/lib/trial';
import type { FillResult, GeneratedAnswer, KnowledgeChunk } from '@/lib/types';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 60;

function fillDebugEnabled() {
  return process.env.FILL_DEBUG === 'true';
}

function logFillDebug(event: string, payload: Record<string, unknown>) {
  if (!fillDebugEnabled()) return;
  console.log(`[VQ_FILL_DEBUG] ${event}`, JSON.stringify(payload));
}

function mergeContext(chunks: KnowledgeChunk[], limit = 6) {
  const seen = new Set<string>();
  const merged: KnowledgeChunk[] = [];

  for (const chunk of chunks.sort((a, b) => (b.similarity || 0) - (a.similarity || 0))) {
    const key = chunk.id || `${chunk.source_name}-${chunk.chunk_text.slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(chunk);
    if (merged.length >= limit) break;
  }

  return merged;
}

function buildQuestionIntent(question: string) {
  return buildQmdQuery(question);
}

const FinalizeAnswerSchema = z.object({
  questionId: z.string().max(120),
  question: z.string().max(1200),
  answer: z.string().max(3000),
  status: z.enum(['answered', 'blank', 'review']),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(1000),
  evidence: z.array(z.object({
    sourceName: z.string().max(300),
    excerpt: z.string().max(1200),
  })).max(8),
});

function parseAnswers(value: FormDataEntryValue | null): GeneratedAnswer[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  const parsed = JSON.parse(value);
  return z.array(FinalizeAnswerSchema).max(MAX_FINALIZE_ANSWERS).parse(parsed) as GeneratedAnswer[];
}

function buildResult(fileName: string, answers: GeneratedAnswer[], outputBase64: string): FillResult {
  return {
    fileName: fileName.replace(/\.docx$/i, '') + '-filled.docx',
    totalQuestions: answers.length,
    answered: answers.filter((a) => a.status === 'answered').length,
    needsReview: answers.filter((a) => a.status === 'review').length,
    blank: answers.filter((a) => a.status === 'blank').length,
    answers,
    outputBase64,
  };
}

function isRateLimitError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|rate limit|too many requests|quota|resource_exhausted/i.test(message);
}

function buildRateLimitSkippedAnswer(questionId: string, question: string): GeneratedAnswer {
  return {
    questionId,
    question,
    answer: '',
    status: 'review',
    confidence: 0,
    reason: 'Skipped due to NVIDIA rate limit. Retry this question later.',
    evidence: [],
  };
}

async function generateAnswer(questionId: string, questionText: string) {
  const startedAt = Date.now();
  const intent = buildQuestionIntent(questionText);
  const context = mergeContext(await retrieveContext(intent, 6), 6);
  const generated = await answerQuestion(questionId, questionText, context, intent);

  logFillDebug('question-done', {
    id: questionId,
    question: questionText.slice(0, 220),
    retrievedChunks: context.length,
    topMatches: context.slice(0, 3).map((chunk) => ({
      sourceName: chunk.source_name,
      sourceType: chunk.source_type,
      similarity: Number((chunk.similarity || 0).toFixed(3)),
      excerpt: chunk.chunk_text.slice(0, 180),
    })),
    answerStatus: generated.status,
    confidence: generated.confidence,
    answerPreview: generated.answer.slice(0, 180),
    reason: generated.reason,
    ms: Date.now() - startedAt,
  });

  return generated;
}

export async function POST(request: Request) {
  try {
    const trialStatus = getTrialStatus();
    if (!trialStatus.active) return trialInactiveResponse(trialStatus);

    if (exceedsContentLength(request, MAX_FILL_REQUEST_BYTES)) {
      return NextResponse.json({ error: `Upload is too large. Maximum request size is ${Math.round(MAX_FILL_REQUEST_BYTES / 1024 / 1024)} MB.` }, { status: 413 });
    }

    const formData = await request.formData();
    const action = String(formData.get('action') || 'batch');

    if (action === 'answer') {
      const questionId = String(formData.get('questionId') || '').trim();
      const question = String(formData.get('question') || '').trim();

      if (!questionId || !question) {
        return NextResponse.json({ error: 'questionId and question are required.' }, { status: 400 });
      }

      try {
        const answer = await generateAnswer(questionId, question);
        return NextResponse.json({ ok: true, action: 'answer', answer });
      } catch (error) {
        if (!isRateLimitError(error)) throw error;

        const answer = buildRateLimitSkippedAnswer(questionId, question);
        logFillDebug('question-skipped-rate-limit', {
          id: questionId,
          question: question.slice(0, 220),
          reason: answer.reason,
        });
        return NextResponse.json({ ok: true, action: 'answer', skipped: true, answer });
      }
    }

    const file = formData.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Upload a DOCX questionnaire.' }, { status: 400 });
    }

    if (!file.name.toLowerCase().endsWith('.docx')) {
      return NextResponse.json({ error: 'Only DOCX questionnaires are supported.' }, { status: 400 });
    }

    if (file.size > MAX_QUESTIONNAIRE_BYTES) {
      return NextResponse.json({ error: `Questionnaire is too large. Maximum supported file size is ${Math.round(MAX_QUESTIONNAIRE_BYTES / 1024 / 1024)} MB.` }, { status: 413 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    if (action === 'extract') {
      const questions = await extractQuestionsFromDocx(buffer);
      return NextResponse.json({ ok: true, action: 'extract', totalQuestions: questions.length, questions });
    }

    if (action === 'finalize') {
      const answers = parseAnswers(formData.get('answers'));
      const output = await fillDocx(buffer, answers);
      return NextResponse.json(buildResult(file.name, answers, output.toString('base64')));
    }

    const questions = await extractQuestionsFromDocx(buffer);
    const start = Math.max(0, Number(formData.get('start') || '0'));
    const batchSize = Math.min(10, Math.max(1, Number(formData.get('batchSize') || '10')));
    const selectedQuestions = questions.slice(start, start + batchSize);
    const answers: GeneratedAnswer[] = [];

    for (const question of selectedQuestions) {
      answers.push(await generateAnswer(question.id, question.question));
    }

    const nextStart = start + selectedQuestions.length;
    return NextResponse.json({
      ok: true,
      action: 'batch',
      totalQuestions: questions.length,
      start,
      processed: selectedQuestions.length,
      nextStart: nextStart < questions.length ? nextStart : null,
      answers,
    });
  } catch (error) {
    console.error('[VQ_FILL_ERROR]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Questionnaire filling failed. Check the uploaded DOCX and try again.' }, { status: 500 });
  }
}
