import { z } from 'zod';
import { saveKnowledgeChunks } from '@/lib/rag';
import { getTrialStatus, trialInactiveResponse } from '@/lib/trial';
import { ensureTursoSchema, getTursoClient } from '@/lib/turso';

export const runtime = 'nodejs';
export const maxDuration = 60;

const FeedbackSchema = z.object({
  questionId: z.string().min(1).max(120),
  question: z.string().min(1).max(1200),
  answer: z.string().min(1).max(3000),
  vote: z.enum(['up', 'down']),
  reason: z.string().max(1000).optional(),
});

function buildStandardAnswerText(question: string, answer: string) {
  return `Question: ${question.trim()}\nApproved answer: ${answer.trim()}`;
}

export async function POST(request: Request) {
  try {
    const trialStatus = getTrialStatus();
    if (!trialStatus.active) return trialInactiveResponse(trialStatus);

    const input = FeedbackSchema.parse(await request.json());
    await ensureTursoSchema();
    const db = getTursoClient();

    await db.execute({
      sql: 'insert into answer_feedback (question_id, question, answer, vote, reason) values (?, ?, ?, ?, ?)',
      args: [input.questionId, input.question, input.answer, input.vote, input.reason || null],
    });

    if (input.vote === 'up') {
      await saveKnowledgeChunks({
        sourceName: `Approved answer - ${input.questionId}`,
        sourceType: 'standard_answer',
        chunks: [buildStandardAnswerText(input.question, input.answer)],
      });
    }

    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not save feedback.';
    return Response.json({ error: message }, { status: 400 });
  }
}
