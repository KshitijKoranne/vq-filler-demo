import { getEmbeddingModel } from '@/lib/ai';
import { authorizedByOptionalBearerToken } from '@/lib/security';
import { getTrialStatus } from '@/lib/trial';
import { ensureTursoSchema, getTursoClient, VECTOR_DIMENSIONS } from '@/lib/turso';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(request: Request) {
  if (!authorizedByOptionalBearerToken(request, process.env.ADMIN_HEALTH_TOKEN)) {
    return Response.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
  }

  try {
    await ensureTursoSchema();
    const db = getTursoClient();
    const [chunks, vectorRows, indexRows] = await Promise.all([
      db.execute('select count(*) as count from knowledge_chunks'),
      db.execute('select count(*) as count from knowledge_chunks where embedding is not null'),
      db.execute({
        sql: "select name from sqlite_master where type = 'index' and name = ?",
        args: ['idx_knowledge_chunks_embedding'],
      }),
    ]);

    return Response.json({
      ok: true,
      database: 'connected',
      embeddingModel: getEmbeddingModel(),
      embeddingDimensions: VECTOR_DIMENSIONS,
      trial: getTrialStatus(),
      chunks: Number(chunks.rows[0]?.count || 0),
      vectorizedChunks: Number(vectorRows.rows[0]?.count || 0),
      vectorIndexReady: indexRows.rows.length > 0,
    });
  } catch (error) {
    console.error('[VQ_HEALTH_ERROR]', error instanceof Error ? error.message : error);
    return Response.json({ ok: false, error: 'Health check failed.' }, { status: 500 });
  }
}
