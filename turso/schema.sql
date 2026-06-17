create table if not exists knowledge_chunks (
  id integer primary key autoincrement,
  source_name text not null,
  source_type text not null check (source_type in ('policy', 'procedure', 'previous_questionnaire', 'standard_answer', 'other')),
  chunk_text text not null,
  embedding_json text not null,
  embedding F32_BLOB(2048),
  embedding_model text,
  embedding_dimensions integer,
  source_fingerprint text,
  chunk_index integer,
  chunk_id text,
  created_at text not null default (datetime('now'))
);

create index if not exists idx_knowledge_chunks_created_at on knowledge_chunks(created_at);
create index if not exists idx_knowledge_chunks_source_type on knowledge_chunks(source_type);
create index if not exists idx_knowledge_chunks_source_name on knowledge_chunks(source_name);
create index if not exists idx_knowledge_chunks_source_fingerprint on knowledge_chunks(source_fingerprint);
create index if not exists idx_knowledge_chunks_chunk_id on knowledge_chunks(chunk_id) where chunk_id is not null;
create index if not exists idx_knowledge_chunks_fingerprint_chunk on knowledge_chunks(source_type, source_fingerprint, chunk_index) where source_fingerprint is not null and chunk_index is not null;
create index if not exists idx_knowledge_chunks_embedding on knowledge_chunks(libsql_vector_idx(embedding)) where embedding is not null;
