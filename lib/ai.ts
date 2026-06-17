import OpenAI from 'openai';
import { z } from 'zod';
import type { GeneratedAnswer, KnowledgeChunk } from './types';

const AnswerSchema = z.object({
  answer: z.string(),
  status: z.enum(['answered', 'blank', 'review']),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

const QuestionIntentSchema = z.object({
  intent: z.string(),
  searchQueries: z.array(z.string()).min(1).max(4),
});

type AnswerData = z.infer<typeof AnswerSchema>;
type QuestionIntentData = z.infer<typeof QuestionIntentSchema>;
type NvidiaEmbeddingInputType = 'query' | 'passage';

type NvidiaEmbeddingResponse = { data?: Array<{ embedding?: number[] }> };
type NvidiaError = { status?: number; message?: string };

const FALLBACK_ANSWER: AnswerData = {
  answer: '',
  status: 'review',
  confidence: 0.2,
  reason: 'Model response could not be validated.',
};

let keyCursor = 0;

export function getEmbeddingModel() {
  return process.env.NVIDIA_EMBEDDING_MODEL || 'nvidia/llama-nemotron-embed-1b-v2';
}

function getNvidiaApiKeys() {
  const keys = (process.env.NVIDIA_API_KEYS || process.env.NVIDIA_API_KEY || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);

  if (keys.length === 0) throw new Error('NVIDIA_API_KEY or NVIDIA_API_KEYS is missing.');
  return Array.from(new Set(keys));
}

function getNextNvidiaApiKeys() {
  const keys = getNvidiaApiKeys();
  const start = keyCursor % keys.length;
  keyCursor = (keyCursor + 1) % keys.length;
  return [...keys.slice(start), ...keys.slice(0, start)];
}

function getNvidiaBaseUrl() {
  return (process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '');
}

function getNvidiaClient(apiKey: string) {
  return new OpenAI({ apiKey, baseURL: getNvidiaBaseUrl() });
}

function isRateLimitError(error: unknown) {
  const err = error as NvidiaError;
  const message = err?.message || String(error);
  return err?.status === 429 || /\b429\b|rate limit|too many requests|quota|resource_exhausted/i.test(message);
}

async function readNvidiaError(response: Response) {
  const text = await response.text();
  try {
    const data = JSON.parse(text);
    const detail = data?.error?.message || data?.detail || data?.message || text;
    return typeof detail === 'string' ? detail : JSON.stringify(detail);
  } catch {
    return text;
  }
}

export async function embedText(text: string, inputType: NvidiaEmbeddingInputType = 'passage'): Promise<number[]> {
  const model = getEmbeddingModel();
  const trimmed = text.replace(/\s+/g, ' ').trim().slice(0, 9000);
  if (!trimmed) throw new Error('Cannot generate embedding for empty text.');

  let lastError = '';
  for (const apiKey of getNextNvidiaApiKeys()) {
    const response = await fetch(`${getNvidiaBaseUrl()}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: [trimmed], model, input_type: inputType, encoding_format: 'float', truncate: 'END' }),
    });

    if (response.ok) {
      const data = (await response.json()) as NvidiaEmbeddingResponse;
      const embedding = data.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) throw new Error('NVIDIA embedding response did not include a usable embedding.');
      return embedding;
    }

    const detail = await readNvidiaError(response);
    lastError = `NVIDIA embedding failed (${response.status}): ${detail}`;
    if (response.status !== 429) throw new Error(lastError);
  }

  throw new Error(lastError || 'NVIDIA embedding failed: all API keys are rate limited.');
}

function extractJsonObject(text: string) {
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return '{}';
  return cleaned.slice(start, end + 1);
}

function parseAnswerJson(text: string): AnswerData {
  try {
    const parsed = AnswerSchema.safeParse(JSON.parse(extractJsonObject(text)));
    return parsed.success ? parsed.data : FALLBACK_ANSWER;
  } catch {
    return FALLBACK_ANSWER;
  }
}

function parseQuestionIntentJson(text: string, question: string): QuestionIntentData {
  try {
    const parsed = QuestionIntentSchema.safeParse(JSON.parse(extractJsonObject(text)));
    if (parsed.success) return parsed.data;
  } catch {}
  return { intent: question, searchQueries: [question] };
}

function safeReviewAnswer(questionId: string, question: string, reason: string, context: KnowledgeChunk[] = []): GeneratedAnswer {
  return {
    questionId,
    question,
    answer: '',
    status: 'review',
    confidence: 0,
    reason,
    evidence: context.slice(0, 5).map((c) => ({ sourceName: c.source_name, excerpt: c.chunk_text.slice(0, 500) })),
  };
}

export async function understandQuestion(question: string): Promise<QuestionIntentData> {
  const model = process.env.NVIDIA_CHAT_MODEL || 'meta/llama-3.1-70b-instruct';

  const prompt = `Understand this vendor/customer questionnaire question for a pharmaceutical manufacturing company.\n\nTask:\n- Rewrite the question as the real business/regulatory intent in English.\n- Add 2-4 English search queries that could match differently worded content in SMF, Quality Manual, SOPs, policies, or previous questionnaires.\n- Keep queries short and semantic.\n- Do not answer the question.\n\nQuestion:\n${question}\n\nReturn strict JSON only with keys: intent, searchQueries.`;

  let lastError = '';
  for (const apiKey of getNextNvidiaApiKeys()) {
    const client = getNvidiaClient(apiKey);
    try {
      const response = await client.chat.completions.create({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You understand pharmaceutical quality questionnaires. Always write intent and search queries in English. Return valid JSON only.' },
          { role: 'user', content: prompt },
        ],
      });

      const text = response.choices[0]?.message?.content || '';
      const parsed = parseQuestionIntentJson(text, question);
      return {
        intent: parsed.intent.trim() || question,
        searchQueries: Array.from(new Set([question, parsed.intent, ...parsed.searchQueries].map((item) => item.trim()).filter(Boolean))).slice(0, 5),
      };
    } catch (error) {
      const err = error as NvidiaError;
      const status = err?.status ? ` (${err.status})` : '';
      const message = err?.message || 'Unknown NVIDIA chat error';
      lastError = `NVIDIA question understanding failed${status}: ${message}`;
      if (!isRateLimitError(error)) throw new Error(lastError);
    }
  }

  throw new Error(lastError || 'NVIDIA question understanding failed: all API keys are rate limited.');
}

export async function answerQuestion(questionId: string, question: string, context: KnowledgeChunk[], intent?: string): Promise<GeneratedAnswer> {
  if (context.length === 0) {
    return { questionId, question, answer: '', status: 'blank', confidence: 0, reason: 'No knowledge snippets available.', evidence: [] };
  }

  const model = process.env.NVIDIA_CHAT_MODEL || 'meta/llama-3.1-70b-instruct';
  const minConfidence = Number(process.env.MIN_ANSWER_CONFIDENCE || '0.25');

  const prompt = `You answer pharmaceutical vendor/customer questionnaire questions using an internal company knowledge base.\n\nMandatory language rule:\n- Always write the final answer in English only, even if the question or snippets are in Turkish or any other language.\n\nAnswer style:\n- Give a useful sentence-level answer, not a one-word answer.\n- For Yes/No questions, start with Yes, No, or Not specified, then add one short supporting phrase from the snippets.\n- Prefer 1 complete sentence. Use 2 short sentences only when needed.\n- Do not over-explain.\n- Bad answer: "Yes."\n- Good answer: "Yes, the company has an independent Quality Assurance unit responsible for quality system oversight."\n\nImportant behavior:\n- The question wording may be different from the knowledge wording. Match by meaning, not exact words.\n- Use ONLY the snippets. Paraphrase only if the meaning is clearly supported.\n- Do not add meaning that is not present in the snippets.\n- If a system/procedure/process exists and snippets describe it, answer Yes with a brief supported explanation.\n- Use blank only when none of the snippets are related to the question.\n- Use review when snippets are related but not enough for a final answer.\n- Do not include citations or source names in answer text.\n- Do not invent exact dates, certificate numbers, addresses, or numeric values unless present in snippets.\n\nQuestion:\n${question}\n\nMeaning to answer:\n${intent || question}\n\nKnowledge snippets:\n${context.map((c, i) => `[${i + 1}] ${c.chunk_text}`).join('\n\n')}\n\nReturn strict JSON only, with the answer and reason in English:\n{ "answer": "...", "status": "answered|blank|review", "confidence": 0.0, "reason": "..." }`;

  let lastError = '';
  for (const apiKey of getNextNvidiaApiKeys()) {
    const client = getNvidiaClient(apiKey);
    try {
      const response = await client.chat.completions.create({
        model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a practical pharma QA questionnaire assistant. Draft one complete, short, supported answer sentence in English. Never answer with only Yes or No. Return valid JSON only.' },
          { role: 'user', content: prompt },
        ],
      });

      const text = response.choices[0]?.message?.content || '';
      const data = parseAnswerJson(text);
      const answer = data.answer.trim();
      const hasAnswer = answer.length > 0;
      const answered = hasAnswer && data.status !== 'blank' && data.confidence >= minConfidence;

      return {
        questionId,
        question,
        answer: answered ? answer : '',
        status: answered ? 'answered' : data.status === 'review' ? 'review' : 'blank',
        confidence: data.confidence,
        reason: data.reason,
        evidence: context.slice(0, 5).map((c) => ({ sourceName: c.source_name, excerpt: c.chunk_text.slice(0, 500) })),
      };
    } catch (error) {
      const err = error as NvidiaError;
      const status = err?.status ? ` (${err.status})` : '';
      const message = err?.message || 'Unknown NVIDIA chat error';
      lastError = `NVIDIA chat completion failed${status}: ${message}`;
      if (!isRateLimitError(error)) throw new Error(lastError);
    }
  }

  return safeReviewAnswer(questionId, question, 'Skipped due to NVIDIA rate limit. Retry this question later.', context);
}
