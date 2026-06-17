import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deleteKnowledgeSource, listKnowledgeSources } from '@/lib/rag';
import { getTrialStatus, trialInactiveResponse } from '@/lib/trial';
import type { KnowledgeSourceType } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 30;

const DeleteSchema = z.object({
  sourceName: z.string().min(1).max(300),
  sourceType: z.enum(['policy', 'procedure', 'previous_questionnaire', 'standard_answer', 'other']),
});

export async function GET() {
  try {
    const trialStatus = getTrialStatus();
    if (!trialStatus.active) return trialInactiveResponse(trialStatus);

    const sources = await listKnowledgeSources();
    return NextResponse.json({ ok: true, sources });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list knowledge sources.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const trialStatus = getTrialStatus();
    if (!trialStatus.active) return trialInactiveResponse(trialStatus);

    const body = DeleteSchema.parse(await request.json());
    const deletedChunks = await deleteKnowledgeSource(body.sourceName, body.sourceType as KnowledgeSourceType);
    return NextResponse.json({ ok: true, deletedChunks });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete knowledge source.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
