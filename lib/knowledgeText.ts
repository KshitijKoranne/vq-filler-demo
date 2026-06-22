import { createHash } from 'crypto';
import { tmpdir } from 'os';
import path from 'path';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { createWorker, OEM, PSM } from 'tesseract.js';

const MIN_TEXT_CHARS = 40;
const DEFAULT_OCR_RENDER_WIDTH = 1800;
const DEFAULT_MAX_OCR_PAGES = 80;

export type KnowledgeExtractionProgress = {
  phase: string;
};

export type ExtractedKnowledgeText = {
  text: string;
  fingerprint: string;
  method: 'docx-mammoth' | 'docx-xml-fallback' | 'pdf-text' | 'pdf-text-ocr' | 'pdf-ocr' | 'txt';
  warnings: string[];
};

type KnowledgeExtractionOptions = {
  onProgress?: (progress: KnowledgeExtractionProgress) => void;
};

function cleanExtractedText(text: string) {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

function textFingerprint(text: string) {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');
}

function hasEnoughText(text: string) {
  return cleanExtractedText(text).replace(/\s/g, '').length >= MIN_TEXT_CHARS;
}

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function isDocxBuffer(buffer: Buffer) {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

function isPdfBuffer(buffer: Buffer) {
  return buffer.length > 4 && buffer.subarray(0, 4).toString('ascii') === '%PDF';
}

function isPasswordOrEncryptedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /password|encrypted|protected|invalid password|no password/i.test(message);
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name] || '');
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function resolveEnglishOcrLangPath() {
  return path.join(process.cwd(), 'node_modules', '@tesseract.js-data', 'eng', '4.0.0');
}

function xmlText(xml: string) {
  return cleanExtractedText(
    xml
      .replace(/<w:tab\b[^>]*\/>/g, ' ')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g, (_match, text) => `${decodeXml(String(text))} `)
      .replace(/<[^>]+>/g, ' '),
  );
}

async function extractDocxXmlFallback(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const fileNames = Object.keys(zip.files)
    .filter((name) => /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/i.test(name))
    .sort((a, b) => {
      if (a === 'word/document.xml') return -1;
      if (b === 'word/document.xml') return 1;
      return a.localeCompare(b);
    });

  const parts: string[] = [];
  for (const name of fileNames) {
    const file = zip.file(name);
    if (!file) continue;
    const text = xmlText(await file.async('string'));
    if (hasEnoughText(text)) parts.push(text);
  }

  return cleanExtractedText(parts.join('\n\n'));
}

async function extractDocxKnowledgeText(buffer: Buffer): Promise<ExtractedKnowledgeText> {
  if (!isDocxBuffer(buffer)) {
    throw new Error('This file does not look like a valid DOCX zip package. Open it and save/export it again as .docx.');
  }

  const warnings: string[] = [];
  try {
    const result = await mammoth.extractRawText({ buffer });
    const text = cleanExtractedText(result.value || '');

    if (result.messages.length > 0) {
      warnings.push('DOCX was readable, but some formatting elements were ignored during text extraction.');
    }

    if (hasEnoughText(text)) {
      return { text, fingerprint: textFingerprint(text), method: 'docx-mammoth', warnings };
    }

    warnings.push('Primary DOCX text extraction found too little text; used XML fallback.');
  } catch (error) {
    if (isPasswordOrEncryptedError(error)) {
      throw new Error('This DOCX appears to be password-protected. Remove protection and upload a readable copy.');
    }
    warnings.push('Primary DOCX text extraction failed; used XML fallback.');
  }

  const fallbackText = await extractDocxXmlFallback(buffer);
  if (hasEnoughText(fallbackText)) {
    return { text: fallbackText, fingerprint: textFingerprint(fallbackText), method: 'docx-xml-fallback', warnings };
  }

  throw new Error('No readable text was found in this DOCX. It may contain only scanned images or unsupported embedded objects.');
}

async function createOcrWorker() {
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    cachePath: path.join(tmpdir(), 'vq-filler-tesseract-cache'),
    langPath: resolveEnglishOcrLangPath(),
  });
  await worker.setParameters({
    preserve_interword_spaces: '1',
    tessedit_pageseg_mode: PSM.AUTO,
  });
  return worker;
}

async function ocrPdfPages(parser: PDFParse, pageNumbers: number[], options: KnowledgeExtractionOptions) {
  if (pageNumbers.length === 0) return [];

  const renderWidth = readPositiveIntegerEnv('OCR_RENDER_WIDTH', DEFAULT_OCR_RENDER_WIDTH);
  const worker = await createOcrWorker();
  const pages: Array<{ page: number; text: string; confidence: number }> = [];

  try {
    for (const [index, pageNumber] of pageNumbers.entries()) {
      options.onProgress?.({ phase: `OCR page ${index + 1} of ${pageNumbers.length}` });
      const screenshot = await parser.getScreenshot({
        partial: [pageNumber],
        desiredWidth: renderWidth,
        imageBuffer: true,
        imageDataUrl: false,
      });
      const image = screenshot.pages[0]?.data;
      if (!image) continue;

      const result = await worker.recognize(Buffer.from(image));
      const text = cleanExtractedText(result.data.text || '');
      if (hasEnoughText(text)) {
        pages.push({
          page: pageNumber,
          text,
          confidence: Number.isFinite(result.data.confidence) ? result.data.confidence : 0,
        });
      }
    }
  } finally {
    await worker.terminate();
  }

  return pages;
}

async function extractPdfKnowledgeText(buffer: Buffer, options: KnowledgeExtractionOptions): Promise<ExtractedKnowledgeText> {
  if (!isPdfBuffer(buffer)) {
    throw new Error('This file does not look like a valid PDF. Open it and export/save it again as PDF.');
  }

  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    options.onProgress?.({ phase: 'Reading PDF text' });
    const result = await parser.getText();
    const textPages = result.pages.map((page) => ({ page: page.num, text: cleanExtractedText(page.text || '') }));
    const usableTextPages = textPages.filter((page) => hasEnoughText(page.text));
    const totalPages = result.total || result.pages.length;
    const missingTextPages = textPages.filter((page) => !hasEnoughText(page.text)).map((page) => page.page);
    const warnings: string[] = [];

    let ocrPages: Array<{ page: number; text: string; confidence: number }> = [];
    if (missingTextPages.length > 0) {
      const maxOcrPages = readPositiveIntegerEnv('MAX_OCR_PAGES_PER_PDF', DEFAULT_MAX_OCR_PAGES);
      const pagesToOcr = missingTextPages.slice(0, maxOcrPages);
      if (missingTextPages.length > maxOcrPages) {
        warnings.push(`OCR was limited to ${maxOcrPages} of ${missingTextPages.length} pages without extractable text. Split the PDF or increase MAX_OCR_PAGES_PER_PDF to process all pages.`);
      }
      options.onProgress?.({ phase: pagesToOcr.length === totalPages ? 'Running OCR' : 'Running OCR for image pages' });
      ocrPages = await ocrPdfPages(parser, pagesToOcr, options);
    }

    const pageTextByNumber = new Map<number, string>();
    for (const page of usableTextPages) pageTextByNumber.set(page.page, page.text);
    for (const page of ocrPages) pageTextByNumber.set(page.page, page.text);

    if (pageTextByNumber.size === 0) {
      throw new Error('No readable text was found in this PDF after text extraction and OCR. It may be password-protected, very low resolution, handwritten, or otherwise unreadable.');
    }

    if (ocrPages.length > 0) {
      const lowConfidence = ocrPages.filter((page) => page.confidence > 0 && page.confidence < 55);
      warnings.push(`OCR was used for ${ocrPages.length} PDF page${ocrPages.length === 1 ? '' : 's'}. Review extracted knowledge if the scan quality is poor.`);
      if (lowConfidence.length > 0) {
        warnings.push(`${lowConfidence.length} OCR page${lowConfidence.length === 1 ? '' : 's'} had low recognition confidence.`);
      }
    }

    if (totalPages > 0 && pageTextByNumber.size < totalPages) {
      warnings.push(`${totalPages - pageTextByNumber.size} PDF page${totalPages - pageTextByNumber.size === 1 ? '' : 's'} still had no readable text after OCR.`);
    }

    const text = cleanExtractedText(
      Array.from(pageTextByNumber.entries())
        .sort(([a], [b]) => a - b)
        .map(([page, pageText]) => `Page ${page}\n${pageText}`)
        .join('\n\n'),
    );
    const method = usableTextPages.length > 0 && ocrPages.length > 0 ? 'pdf-text-ocr' : ocrPages.length > 0 ? 'pdf-ocr' : 'pdf-text';

    return { text, fingerprint: textFingerprint(text), method, warnings };
  } catch (error) {
    if (isPasswordOrEncryptedError(error)) {
      throw new Error('This PDF appears to be password-protected or encrypted. Remove protection and upload a readable copy.');
    }
    throw error;
  } finally {
    await parser.destroy();
  }
}

function extractTxtKnowledgeText(buffer: Buffer): ExtractedKnowledgeText {
  const text = cleanExtractedText(buffer.toString('utf-8'));
  if (!hasEnoughText(text)) {
    throw new Error('No readable text was found in this text file.');
  }
  return { text, fingerprint: textFingerprint(text), method: 'txt', warnings: [] };
}

export async function extractKnowledgeText(file: File, options: KnowledgeExtractionOptions = {}): Promise<ExtractedKnowledgeText> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const fileName = file.name.toLowerCase();

  if (buffer.length === 0) {
    throw new Error('The file is empty.');
  }

  if (fileName.endsWith('.doc')) {
    throw new Error('Old .doc files are not supported. Open the file and save/export it as .docx.');
  }

  if (fileName.endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return extractDocxKnowledgeText(buffer);
  }

  if (fileName.endsWith('.pdf') || file.type === 'application/pdf') {
    return extractPdfKnowledgeText(buffer, options);
  }

  if (file.type.startsWith('text/') || fileName.endsWith('.txt')) {
    return extractTxtKnowledgeText(buffer);
  }

  throw new Error('Only DOCX, PDF, and TXT knowledge files are supported.');
}
