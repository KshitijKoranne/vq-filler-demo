import { ensureTursoSchema, getTursoClient } from './turso';
import { embedText, getEmbeddingModel } from './ai';
import { buildQmdQuery } from './qmd';
import { VECTOR_DIMENSIONS } from './turso';
import type { KnowledgeChunk, KnowledgeSourceSummary, KnowledgeSourceType } from './types';

function cosineSimilarity(a: number[], b: number[]) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);

  if (length === 0 || a.length !== b.length) return 0;

  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function safeParseEmbedding(value: unknown): number[] | null {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'number')) return null;
    return parsed;
  } catch {
    return null;
  }
}

function keywords(text: string) {
  const stop = new Set(['the', 'and', 'for', 'with', 'your', 'have', 'does', 'what', 'this', 'that', 'from', 'into', 'are', 'is', 'of', 'to', 'in', 'a', 'an', 'you', 'company']);
  return Array.from(new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((word) => word.length > 2 && !stop.has(word))));
}

function lexicalScore(query: string, sourceName: string, chunkText: string) {
  const queryWords = keywords(query);
  if (queryWords.length === 0) return 0;

  const haystack = `${sourceName} ${chunkText}`.toLowerCase();
  const hits = queryWords.filter((word) => haystack.includes(word)).length;
  return Math.min(1, hits / Math.max(4, queryWords.length));
}

function sourceTypeWeight(sourceType: KnowledgeSourceType) {
  if (sourceType === 'standard_answer') return 1;
  if (sourceType === 'previous_questionnaire') return 0.85;
  if (sourceType === 'procedure') return 0.7;
  if (sourceType === 'policy') return 0.6;
  return 0.4;
}

function vectorJson(embedding: number[]) {
  if (embedding.length !== VECTOR_DIMENSIONS) {
    throw new Error(`Expected ${VECTOR_DIMENSIONS}-dimension embedding, received ${embedding.length}. Check NVIDIA_EMBEDDING_MODEL before ingesting.`);
  }
  return JSON.stringify(embedding);
}

function minRetrievalSimilarity() {
  return Number(process.env.MIN_RETRIEVAL_SIMILARITY || '0.35');
}

export type SaveKnowledgeChunksResult = {
  inserted: number;
  duplicate: boolean;
};

export async function saveKnowledgeChunks(input: {
  sourceName: string;
  sourceType: KnowledgeSourceType;
  chunks: string[];
  sourceFingerprint?: string;
  onProgress?: (progress: { inserted: number; total: number }) => void;
}): Promise<SaveKnowledgeChunksResult> {
  await ensureTursoSchema();
  const db = getTursoClient();
  let inserted = 0;
  const embeddingModel = getEmbeddingModel();

  if (input.sourceFingerprint) {
    const existing = await db.execute({
      sql: 'select count(*) as count from knowledge_chunks where source_type = ? and source_fingerprint = ?',
      args: [input.sourceType, input.sourceFingerprint],
    });
    if (Number(existing.rows[0]?.count || 0) > 0) {
      return { inserted: 0, duplicate: true };
    }
  }

  for (const [index, chunk] of input.chunks.entries()) {
    const embedding = await embedText(chunk, 'passage');
    const embeddingJson = vectorJson(embedding);
    const chunkId = input.sourceFingerprint ? `${input.sourceType}:${input.sourceFingerprint}:${index}` : null;
    const result = await db.execute({
      sql: `insert or ignore into knowledge_chunks (
        source_name,
        source_type,
        chunk_text,
        embedding_json,
        embedding,
        embedding_model,
        embedding_dimensions,
        source_fingerprint,
        chunk_index,
        chunk_id
      ) values (?, ?, ?, ?, vector32(?), ?, ?, ?, ?, ?)`,
      args: [
        input.sourceName,
        input.sourceType,
        chunk,
        embeddingJson,
        embeddingJson,
        embeddingModel,
        VECTOR_DIMENSIONS,
        input.sourceFingerprint || null,
        index,
        chunkId,
      ],
    });
    inserted += Number(result.rowsAffected || 0);
    input.onProgress?.({ inserted, total: input.chunks.length });
  }

  return { inserted, duplicate: inserted === 0 && input.chunks.length > 0 };
}

export async function listKnowledgeSources(): Promise<KnowledgeSourceSummary[]> {
  await ensureTursoSchema();
  const db = getTursoClient();
  const result = await db.execute(`
    select
      source_name,
      source_type,
      count(*) as chunks,
      max(created_at) as latest_ingested_at
    from knowledge_chunks
    group by source_name, source_type
    order by latest_ingested_at desc, source_name asc
  `);

  return result.rows.map((row) => ({
    sourceName: String(row.source_name),
    sourceType: row.source_type as KnowledgeSourceType,
    chunks: Number(row.chunks || 0),
    latestIngestedAt: String(row.latest_ingested_at || ''),
  }));
}

export async function getRecentKnowledgeChunks(limit = 300): Promise<KnowledgeChunk[]> {
  await ensureTursoSchema();
  const db = getTursoClient();
  const result = await db.execute({
    sql: 'select id, source_name, source_type, chunk_text from knowledge_chunks order by created_at desc limit ?',
    args: [limit],
  });

  return result.rows.map((row) => ({
    id: String(row.id),
    source_name: String(row.source_name),
    source_type: row.source_type as KnowledgeSourceType,
    chunk_text: String(row.chunk_text),
  }));
}

export async function deleteKnowledgeSource(sourceName: string, sourceType: KnowledgeSourceType) {
  await ensureTursoSchema();
  const db = getTursoClient();
  const result = await db.execute({
    sql: 'delete from knowledge_chunks where source_name = ? and source_type = ?',
    args: [sourceName, sourceType],
  });

  return Number(result.rowsAffected || 0);
}

export async function backfillKnowledgeVectors(limit = 250) {
  await ensureTursoSchema();
  const db = getTursoClient();
  const result = await db.execute({
    sql: 'select id, chunk_text, embedding_json from knowledge_chunks where embedding is null order by created_at asc limit ?',
    args: [limit],
  });
  let updated = 0;
  const embeddingModel = getEmbeddingModel();

  for (const row of result.rows) {
    const id = String(row.id);
    const parsed = safeParseEmbedding(row.embedding_json);
    const embedding = parsed?.length === VECTOR_DIMENSIONS ? parsed : await embedText(String(row.chunk_text), 'passage');
    const embeddingJson = vectorJson(embedding);

    await db.execute({
      sql: 'update knowledge_chunks set embedding = vector32(?), embedding_json = ?, embedding_model = ?, embedding_dimensions = ? where id = ?',
      args: [embeddingJson, embeddingJson, embeddingModel, VECTOR_DIMENSIONS, id],
    });
    updated++;
  }

  return updated;
}

async function retrieveVectorCandidates(queryEmbedding: number[], limit: number): Promise<KnowledgeChunk[]> {
  const db = getTursoClient();
  const queryJson = vectorJson(queryEmbedding);
  const candidateLimit = Math.max(limit * 8, 40);
  const result = await db.execute({
    sql: `
      select
        kc.id,
        kc.source_name,
        kc.source_type,
        kc.chunk_text,
        vector_distance_cos(kc.embedding, vector32(?)) as distance
      from vector_top_k('idx_knowledge_chunks_embedding', vector32(?), ?) vector_matches
      join knowledge_chunks kc on kc.id = vector_matches.id
      where kc.embedding is not null
    `,
    args: [queryJson, queryJson, candidateLimit],
  });

  return result.rows.map((row) => {
    const distance = Number(row.distance);
    return {
      id: String(row.id),
      source_name: String(row.source_name),
      source_type: row.source_type as KnowledgeSourceType,
      chunk_text: String(row.chunk_text),
      similarity: Number.isFinite(distance) ? 1 - distance : 0,
    };
  });
}

async function retrieveJsonFallbackCandidates(queryEmbedding: number[], limit: number) {
  const db = getTursoClient();
  const result = await db.execute({
    sql: 'select id, source_name, source_type, chunk_text, embedding_json from knowledge_chunks order by created_at desc limit ?',
    args: [Math.max(limit * 40, 1500)],
  });

  return result.rows.map((row) => {
    const embedding = safeParseEmbedding(row.embedding_json);
    const semanticScore = embedding ? cosineSimilarity(queryEmbedding, embedding) : 0;
    return {
      id: String(row.id),
      source_name: String(row.source_name),
      source_type: row.source_type as KnowledgeSourceType,
      chunk_text: String(row.chunk_text),
      similarity: semanticScore,
    } satisfies KnowledgeChunk;
  });
}

function rerankCandidates(question: string, qmdQuery: string, chunks: KnowledgeChunk[], limit: number) {
  const minSimilarity = minRetrievalSimilarity();

  return chunks
    .map((chunk) => {
      const lexical = Math.max(lexicalScore(question, chunk.source_name, chunk.chunk_text), lexicalScore(qmdQuery, chunk.source_name, chunk.chunk_text));
      const semantic = chunk.similarity || 0;
      const weightedScore = semantic * 0.75 + lexical * 0.2 + sourceTypeWeight(chunk.source_type) * 0.05;

      return {
        ...chunk,
        similarity: weightedScore,
      };
    })
    .filter((chunk) => (chunk.similarity || 0) >= minSimilarity)
    .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
    .slice(0, limit);
}

export async function retrieveContext(question: string, limit = 12): Promise<KnowledgeChunk[]> {
  await ensureTursoSchema();
  const qmdQuery = buildQmdQuery(question);
  const queryEmbedding = await embedText(qmdQuery, 'query');
  await backfillKnowledgeVectors();

  try {
    const vectorCandidates = await retrieveVectorCandidates(queryEmbedding, limit);
    return rerankCandidates(question, qmdQuery, vectorCandidates, limit);
  } catch (error) {
    if (process.env.FILL_DEBUG === 'true') {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[VQ_RETRIEVAL_FALLBACK]', message);
    }
    const fallbackCandidates = await retrieveJsonFallbackCandidates(queryEmbedding, limit);
    return rerankCandidates(question, qmdQuery, fallbackCandidates, limit);
  }
}
