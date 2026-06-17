import mammoth from 'mammoth';
import { createHash } from 'crypto';
import { z } from 'zod';
import { saveKnowledgeChunks } from '@/lib/rag';
import { exceedsContentLength, MAX_KNOWLEDGE_FILE_BYTES, MAX_KNOWLEDGE_FILES, MAX_KNOWLEDGE_REQUEST_BYTES } from '@/lib/security';
import { chunkText } from '@/lib/text';
import { getTrialStatus, trialInactiveResponse } from '@/lib/trial';
import type { KnowledgeSourceType } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

const SourceTypeSchema = z.enum(['policy', 'procedure', 'previous_questionnaire', 'standard_answer', 'other']);

type IngestedSource = {
  fileName: string;
  chunks: number;
};

type SkippedSource = {
  fileName: string;
  reason: string;
};

type StreamEvent =
  | { type: 'progress'; phase: string; progress: number; fileName?: string; insertedChunks?: number; totalChunks?: number }
  | { type: 'complete'; progress: number; totalChunks: number; sources: IngestedSource[]; skipped: SkippedSource[] }
  | { type: 'error'; error: string; skipped?: SkippedSource[] };

function isDocxBuffer(buffer: Buffer) {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

function explainExtractionError(fileName: string, error: unknown) {
  const rawMessage = error instanceof Error ? error.message : String(error || 'Unknown extraction error');
  const lower = rawMessage.toLowerCase();

  if (lower.includes('corrupted zip') || lower.includes('end of data') || lower.includes('central directory') || lower.includes('invalid zip')) {
    return `${fileName} could not be read as DOCX. It may be an old .doc file, password-protected, empty, corrupted, or incorrectly renamed as .docx. Open it in Word/Google Docs and export/save again as a fresh .docx.`;
  }

  if (/too large|only docx and txt|old \.doc|empty|valid docx/i.test(rawMessage)) {
    return `${fileName} could not be processed: ${rawMessage}`;
  }

  return `${fileName} could not be processed. Check that it is a readable DOCX or TXT file.`;
}

function sendEvent(controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder, event: StreamEvent) {
  controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
}

function fingerprintText(text: string) {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');
}

async function extractText(file: File) {
  if (file.size > MAX_KNOWLEDGE_FILE_BYTES) {
    throw new Error(`The file is too large. Maximum supported file size is ${Math.round(MAX_KNOWLEDGE_FILE_BYTES / 1024 / 1024)} MB.`);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const fileName = file.name.toLowerCase();

  if (buffer.length === 0) {
    throw new Error('The file is empty.');
  }

  if (fileName.endsWith('.doc')) {
    throw new Error('Old .doc files are not supported yet. Open the file and save/export it as .docx.');
  }

  if (fileName.endsWith('.docx')) {
    if (!isDocxBuffer(buffer)) {
      throw new Error('This file does not look like a valid DOCX zip package. Open it and save/export it again as .docx.');
    }
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (file.type.startsWith('text/') || fileName.endsWith('.txt')) {
    return buffer.toString('utf-8');
  }

  throw new Error('Only DOCX and TXT knowledge files are supported in this MVP.');
}

export async function POST(request: Request) {
  const encoder = new TextEncoder();
  const trialStatus = getTrialStatus();
  if (!trialStatus.active) return trialInactiveResponse(trialStatus);

  if (exceedsContentLength(request, MAX_KNOWLEDGE_REQUEST_BYTES)) {
    return Response.json({ error: `Upload is too large. Maximum request size is ${Math.round(MAX_KNOWLEDGE_REQUEST_BYTES / 1024 / 1024)} MB.` }, { status: 413 });
  }

  return new Response(new ReadableStream({
    async start(controller) {
      const emit = (event: StreamEvent) => sendEvent(controller, encoder, event);

      try {
        const formData = await request.formData();
        const files = formData.getAll('files').filter((item): item is File => item instanceof File);
        const sourceType = SourceTypeSchema.parse(formData.get('sourceType') || 'other') as KnowledgeSourceType;

        if (files.length === 0) {
          emit({ type: 'error', error: 'Upload at least one knowledge file.' });
          controller.close();
          return;
        }

        if (files.length > MAX_KNOWLEDGE_FILES) {
          emit({ type: 'error', error: `Upload ${MAX_KNOWLEDGE_FILES} files or fewer at a time.` });
          controller.close();
          return;
        }

        let totalChunks = 0;
        let processedFiles = 0;
        const sources: IngestedSource[] = [];
        const skipped: SkippedSource[] = [];

        emit({ type: 'progress', phase: 'Reading files', progress: 2 });

        for (const file of files) {
          try {
            emit({ type: 'progress', phase: `Reading ${file.name}`, progress: Math.round((processedFiles / files.length) * 10), fileName: file.name });
            const text = await extractText(file);
            const chunks = chunkText(text);
            const sourceFingerprint = fingerprintText(text);

            if (chunks.length === 0) {
              skipped.push({ fileName: file.name, reason: 'No readable text was found in this file.' });
              processedFiles++;
              continue;
            }

            const inserted = await saveKnowledgeChunks({
              sourceName: file.name,
              sourceType,
              chunks,
              sourceFingerprint,
              onProgress: ({ inserted, total }) => {
                const fileShare = 1 / files.length;
                const fileStart = processedFiles / files.length;
                const chunkProgress = total > 0 ? inserted / total : 1;
                const progress = Math.max(5, Math.min(99, Math.round((fileStart + chunkProgress * fileShare) * 100)));
                emit({
                  type: 'progress',
                  phase: `Embedding ${file.name}`,
                  progress,
                  fileName: file.name,
                  insertedChunks: inserted,
                  totalChunks: total,
                });
              },
            });

            if (inserted.duplicate) {
              skipped.push({ fileName: file.name, reason: 'This file content is already ingested for this source type.' });
              processedFiles++;
              continue;
            }

            totalChunks += inserted.inserted;
            sources.push({ fileName: file.name, chunks: inserted.inserted });
            processedFiles++;
          } catch (error) {
            skipped.push({ fileName: file.name, reason: explainExtractionError(file.name, error) });
            processedFiles++;
            emit({
              type: 'progress',
              phase: `Skipped ${file.name}`,
              progress: Math.max(5, Math.min(99, Math.round((processedFiles / files.length) * 100))),
              fileName: file.name,
            });
          }
        }

        if (sources.length === 0) {
          emit({ type: 'error', error: 'No files were ingested.', skipped });
          controller.close();
          return;
        }

        emit({ type: 'complete', progress: 100, totalChunks, sources, skipped });
        controller.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Knowledge ingestion failed.';
        emit({ type: 'error', error: message });
        controller.close();
      }
    },
  }), {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
