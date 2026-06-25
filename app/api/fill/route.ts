import { NextResponse } from 'next/server';
import { extractQuestionsFromDocx } from '@/lib/docx';
import { retrieveContext } from '@/lib/rag';
import { answerQuestion } from '@/lib/ai';
import { buildQmdQuery } from '@/lib/qmd';
import { exceedsContentLength, MAX_FILL_REQUEST_BYTES, MAX_QUESTIONNAIRE_BYTES } from '@/lib/security';
import { getTrialStatus, trialInactiveResponse } from '@/lib/trial';
import type { GeneratedAnswer, KnowledgeChunk } from '@/lib/types';

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
    const action = String(formData.get('action') || 'extract');

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

    if (action !== 'extract') {
      return NextResponse.json({ error: 'Unsupported action.' }, { status: 400 });
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
    const questions = await extractQuestionsFromDocx(buffer);
    return NextResponse.json({ ok: true, action: 'extract', totalQuestions: questions.length, questions });
  } catch (error) {
    console.error('[VQ_FILL_ERROR]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Could not prepare answers. Check the uploaded DOCX and try again.' }, { status: 500 });
  }
}
