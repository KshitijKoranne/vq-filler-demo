import { createClient } from '@libsql/client';

function readVectorDimensions() {
  const dimensions = Number(process.env.EMBEDDING_DIMENSIONS || '2048');
  return Number.isFinite(dimensions) && dimensions > 0 ? dimensions : 2048;
}

export const VECTOR_DIMENSIONS = readVectorDimensions();

async function executeOptional(sql: string) {
  const db = getTursoClient();
  try {
    await db.execute(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/duplicate column|already exists/i.test(message)) return;
    throw error;
  }
}

export function getTursoClient() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url || !authToken) {
    throw new Error('Turso environment variables are missing in this runtime. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env.local for localhost, or in your deployment provider for production.');
  }

  return createClient({ url, authToken });
}

export async function ensureTursoSchema() {
  const db = getTursoClient();

  await db.batch([
    {
      sql: `create table if not exists knowledge_chunks (
        id integer primary key autoincrement,
        source_name text not null,
        source_type text not null check (source_type in ('policy', 'procedure', 'previous_questionnaire', 'standard_answer', 'other')),
        chunk_text text not null,
        embedding_json text not null,
        embedding F32_BLOB(${VECTOR_DIMENSIONS}),
        embedding_model text,
        embedding_dimensions integer,
        source_fingerprint text,
        chunk_index integer,
        chunk_id text,
        created_at text not null default (datetime('now'))
      )`,
      args: [],
    },
    {
      sql: `create table if not exists answer_feedback (
        id integer primary key autoincrement,
        question_id text not null,
        question text not null,
        answer text not null,
        vote text not null check (vote in ('up', 'down')),
        reason text,
        created_at text not null default (datetime('now'))
      )`,
      args: [],
    },
    {
      sql: 'create index if not exists idx_knowledge_chunks_created_at on knowledge_chunks(created_at)',
      args: [],
    },
    {
      sql: 'create index if not exists idx_knowledge_chunks_source_type on knowledge_chunks(source_type)',
      args: [],
    },
    {
      sql: 'create index if not exists idx_knowledge_chunks_source_name on knowledge_chunks(source_name)',
      args: [],
    },
    {
      sql: 'create index if not exists idx_answer_feedback_vote on answer_feedback(vote)',
      args: [],
    },
    {
      sql: 'create index if not exists idx_answer_feedback_created_at on answer_feedback(created_at)',
      args: [],
    },
  ]);

  await executeOptional(`alter table knowledge_chunks add column embedding F32_BLOB(${VECTOR_DIMENSIONS})`);
  await executeOptional('alter table knowledge_chunks add column embedding_model text');
  await executeOptional('alter table knowledge_chunks add column embedding_dimensions integer');
  await executeOptional('alter table knowledge_chunks add column source_fingerprint text');
  await executeOptional('alter table knowledge_chunks add column chunk_index integer');
  await executeOptional('alter table knowledge_chunks add column chunk_id text');

  await db.batch([
    {
      sql: 'create index if not exists idx_knowledge_chunks_source_fingerprint on knowledge_chunks(source_fingerprint)',
      args: [],
    },
    {
      sql: 'create index if not exists idx_knowledge_chunks_chunk_id on knowledge_chunks(chunk_id) where chunk_id is not null',
      args: [],
    },
    {
      sql: 'create index if not exists idx_knowledge_chunks_fingerprint_chunk on knowledge_chunks(source_type, source_fingerprint, chunk_index) where source_fingerprint is not null and chunk_index is not null',
      args: [],
    },
    {
      sql: 'create index if not exists idx_knowledge_chunks_embedding on knowledge_chunks(libsql_vector_idx(embedding)) where embedding is not null',
      args: [],
    },
  ]);
}
