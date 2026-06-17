import { NextResponse } from 'next/server';
import { z } from 'zod';
import { embedText, getEmbeddingModel } from '@/lib/ai';
import { getTrialStatus, trialInactiveResponse } from '@/lib/trial';
import { ensureTursoSchema, getTursoClient, VECTOR_DIMENSIONS } from '@/lib/turso';

export const runtime = 'nodejs';
export const maxDuration = 60;

const ReingestSchema = z.object({
  sourceName: z.string().min(1).max(300),
  sourceType: z.enum(['policy', 'procedure', 'previous_questionnaire', 'standard_answer', 'other']),
  offset: z.number().int().min(0).optional().default(0),
  limit: z.number().int().min(1).max(1).optional().default(1),
});

function vectorJson(embedding: number[]) {
  if (embedding.length !== VECTOR_DIMENSIONS) {
    throw new Error(`Expected ${VECTOR_DIMENSIONS}-dimension embedding, received ${embedding.length}. Check NVIDIA_EMBEDDING_MODEL and EMBEDDING_DIMENSIONS.`);
  }
  return JSON.stringify(embedding);
}

export async function POST(request: Request) {
  try {
    const trialStatus = getTrialStatus();
    if (!trialStatus.active) return trialInactiveResponse(trialStatus);

    const body = ReingestSchema.parse(await request.json());
    await ensureTursoSchema();

    const db = getTursoClient();
    const totalResult = await db.execute({
      sql: 'select count(*) as total from knowledge_chunks where source_name = ? and source_type = ?',
      args: [body.sourceName, body.sourceType],
    });
    const totalChunks = Number(totalResult.rows[0]?.total || 0);

    if (totalChunks === 0) {
      return NextResponse.json({ error: 'Knowledge source not found.' }, { status: 404 });
    }

    const chunks = await db.execute({
      sql: `select id, chunk_text
            from knowledge_chunks
            where source_name = ? and source_type = ?
            order by coalesce(chunk_index, id), id
            limit 1 offset ?`,
      args: [body.sourceName, body.sourceType, body.offset],
    });

    const embeddingModel = getEmbeddingModel();
    let updatedChunks = 0;

    for (const row of chunks.rows) {
      const id = String(row.id);
      const embedding = await embedText(String(row.chunk_text), 'passage');
      const embeddingJson = vectorJson(embedding);

      await db.execute({
        sql: `update knowledge_chunks
              set embedding = vector32(?), embedding_json = ?, embedding_model = ?, embedding_dimensions = ?
              where id = ?`,
        args: [embeddingJson, embeddingJson, embeddingModel, VECTOR_DIMENSIONS, id],
      });
      updatedChunks++;
    }

    const nextOffset = body.offset + updatedChunks;
    const complete = nextOffset >= totalChunks || updatedChunks === 0;

    return NextResponse.json({
      ok: true,
      sourceName: body.sourceName,
      sourceType: body.sourceType,
      updatedChunks,
      totalChunks,
      nextOffset,
      complete,
      embeddingModel,
      embeddingDimensions: VECTOR_DIMENSIONS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to re-ingest this knowledge source.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
