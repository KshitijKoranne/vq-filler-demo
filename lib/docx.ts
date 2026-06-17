import JSZip from 'jszip';
import { v4 as uuidv4 } from 'uuid';
import type { GeneratedAnswer, QuestionCandidate } from './types';
import { looksLikeQuestion, normalizeQuestion } from './text';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const HIGHLIGHT_FILL = 'FFF2CC';
const CHECKED_BOX = '☒';
const EMPTY_BOX = '☐';

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cleanText(value: string) {
  return decodeXml(value)
    .replace(/<w:tab\b[^>]*\/>/g, ' ')
    .replace(/<w:br\b[^>]*\/>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[|_]+/g, ' ')
    .replace(/[☐☒]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getCellText(cellXml: string) {
  const matches = [...cellXml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)];
  return cleanText(matches.length ? matches.map((m) => m[1]).join(' ') : cellXml);
}

function splitRows(documentXml: string) {
  const rowRegex = /<w:tr\b[\s\S]*?<\/w:tr>/g;
  return [...documentXml.matchAll(rowRegex)].map((m) => m[0]);
}

function splitCells(rowXml: string) {
  const cellRegex = /<w:tc\b[\s\S]*?<\/w:tc>/g;
  return [...rowXml.matchAll(cellRegex)].map((m) => m[0]);
}

function replaceCellText(cellXml: string, text: string) {
  const safe = escapeXml(text);
  const paragraph = `<w:p><w:r><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
  if (/<w:p\b[\s\S]*?<\/w:p>/.test(cellXml)) {
    return cellXml.replace(/<w:p\b[\s\S]*?<\/w:p>/, paragraph);
  }
  return cellXml.replace('</w:tc>', `${paragraph}</w:tc>`);
}

function shadeCell(cellXml: string) {
  if (/<w:tcPr\b[\s\S]*?>/.test(cellXml)) {
    if (/<w:shd\b[^>]*\/>/.test(cellXml)) {
      return cellXml.replace(/<w:shd\b[^>]*\/>/, `<w:shd w:fill="${HIGHLIGHT_FILL}"/>`);
    }
    return cellXml.replace(/<w:tcPr([^>]*)>/, `<w:tcPr$1><w:shd w:fill="${HIGHLIGHT_FILL}"/>`);
  }
  return cellXml.replace(/<w:tc\b([^>]*)>/, `<w:tc$1><w:tcPr><w:shd w:fill="${HIGHLIGHT_FILL}"/></w:tcPr>`);
}

function clearShade(cellXml: string) {
  return cellXml.replace(/<w:shd\b[^>]*\/>/g, '');
}

function isLikelyAnswerHeader(text: string) {
  return /\b(answer|response|reply|remarks|comments|details|status|explanations?)\b/i.test(text);
}

function isHeaderRow(texts: string[]) {
  const joined = texts.join(' ').toLowerCase();
  return /\b(criteria|kriter|question|requirement)\b/.test(joined) && /\b(yes|evet|no|hayır|hayir|na|u\.y|explanations?|açıklamalar|aciklamalar)\b/.test(joined);
}

function isProfileFieldLabel(text: string) {
  return /\b(date|tarih|company name|firma ismi|name of company|address|adres|headquarters|contact person|kontak kişi|department|departman|phone|telefon|e-?mail|email)\b/i.test(text)
    && text.length <= 120;
}

function findQuestionCell(texts: string[]) {
  let bestIndex = -1;
  let bestScore = 0;

  texts.forEach((text, index) => {
    const normalized = normalizeQuestion(text);
    let score = 0;
    if (looksLikeQuestion(normalized)) score += 5;
    if (/\?/.test(normalized)) score += 2;
    if (/\b(do you|does your|is there|are there|please|describe|provide|confirm|whether|what|who|how|list|specify|attach)\b/i.test(normalized)) score += 2;
    if (/\b(yes|no|na|evet|hayır|hayir|u\.y|assessment|değerlendirme|biofarma)\b/i.test(normalized)) score -= 3;
    if (normalized.length > 20) score += 1;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  if (bestScore >= 5) return bestIndex;
  const profileIndex = texts.findIndex(isProfileFieldLabel);
  return profileIndex;
}

function detectStructuredTargets(cells: string[], qIndex: number) {
  const texts = cells.map(getCellText);
  const afterQuestion = texts.slice(qIndex + 1);
  const likelyStructured = cells.length >= 5 && afterQuestion.filter((text) => text.length <= 20).length >= 3;

  if (!likelyStructured) return null;

  const yesCellIndex = qIndex + 1;
  const noCellIndex = qIndex + 2 < cells.length ? qIndex + 2 : undefined;
  const naCellIndex = qIndex + 3 < cells.length ? qIndex + 3 : undefined;
  const explanationCellIndex = qIndex + 4 < cells.length ? qIndex + 4 : cells.length - 1;

  return { yesCellIndex, noCellIndex, naCellIndex, explanationCellIndex };
}

function detectAnswerCell(cells: string[], qIndex: number) {
  const structured = detectStructuredTargets(cells, qIndex);
  if (structured?.explanationCellIndex !== undefined) return structured.explanationCellIndex;

  const texts = cells.map(getCellText);
  for (let i = qIndex + 1; i < texts.length; i++) {
    if (!looksLikeQuestion(texts[i]) && !isProfileFieldLabel(texts[i])) return i;
  }
  return Math.min(qIndex + 1, cells.length - 1);
}

function getAnswerChoice(answer: GeneratedAnswer) {
  const value = `${answer.answer} ${answer.reason}`.toLowerCase();
  if (answer.status !== 'answered') return null;
  if (/\b(no|not available|not applicable|n\/a|na)\b/.test(value)) return value.includes('not applicable') || /\bn\/a\b|\bna\b/.test(value) ? 'na' : 'no';
  return 'yes';
}

function shadeAnswerSideCells(cells: string[], qIndex: number) {
  return cells.map((cell, index) => (index > qIndex ? shadeCell(cell) : cell));
}

function applyStructuredAnswer(cells: string[], answer: GeneratedAnswer, qIndex: number) {
  const structured = detectStructuredTargets(cells, qIndex);
  if (!structured) return null;

  if (answer.status !== 'answered') {
    return { cells: shadeAnswerSideCells(cells, qIndex) };
  }

  const newCells = [...cells];
  const choice = getAnswerChoice(answer);
  const explanationIndex = structured.explanationCellIndex;

  if (structured.yesCellIndex !== undefined && newCells[structured.yesCellIndex]) {
    newCells[structured.yesCellIndex] = replaceCellText(clearShade(newCells[structured.yesCellIndex]), choice === 'yes' ? CHECKED_BOX : EMPTY_BOX);
  }
  if (structured.noCellIndex !== undefined && newCells[structured.noCellIndex]) {
    newCells[structured.noCellIndex] = replaceCellText(clearShade(newCells[structured.noCellIndex]), choice === 'no' ? CHECKED_BOX : EMPTY_BOX);
  }
  if (structured.naCellIndex !== undefined && newCells[structured.naCellIndex]) {
    newCells[structured.naCellIndex] = replaceCellText(clearShade(newCells[structured.naCellIndex]), choice === 'na' ? CHECKED_BOX : EMPTY_BOX);
  }

  if (explanationIndex !== undefined && newCells[explanationIndex]) {
    newCells[explanationIndex] = replaceCellText(clearShade(newCells[explanationIndex]), answer.answer);
  }

  return { cells: newCells };
}

export async function extractQuestionsFromDocx(buffer: Buffer): Promise<QuestionCandidate[]> {
  const zip = await JSZip.loadAsync(buffer);
  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (!documentXml) throw new Error('Invalid DOCX: word/document.xml not found.');

  const rows = splitRows(documentXml);
  const questions: QuestionCandidate[] = [];

  rows.forEach((row, rowIndex) => {
    const cells = splitCells(row);
    if (cells.length < 2) return;
    const texts = cells.map(getCellText);
    if (isHeaderRow(texts)) return;
    if (texts.some(isLikelyAnswerHeader) && texts.some((t) => /question|requirement/i.test(t))) return;

    const questionCellIndex = findQuestionCell(texts);
    if (questionCellIndex === -1) return;

    const question = normalizeQuestion(texts[questionCellIndex]);
    const answerCellIndex = detectAnswerCell(cells, questionCellIndex);
    const structured = detectStructuredTargets(cells, questionCellIndex);

    if (answerCellIndex === questionCellIndex) return;
    questions.push({
      id: uuidv4(),
      question,
      location: {
        kind: 'table_cell',
        rowIndex,
        questionCellIndex,
        answerCellIndex,
        ...structured,
      },
    });
  });

  return questions;
}

export async function fillDocx(buffer: Buffer, answers: GeneratedAnswer[]) {
  const zip = await JSZip.loadAsync(buffer);
  const documentFile = zip.file('word/document.xml');
  const documentXml = await documentFile?.async('string');
  if (!documentXml) throw new Error('Invalid DOCX: word/document.xml not found.');

  let updated = documentXml;
  const rows = splitRows(documentXml);
  const answerMap = new Map(answers.map((a) => [a.question, a]));

  rows.forEach((rowXml) => {
    let newRow = rowXml;
    const cells = splitCells(rowXml);
    if (cells.length < 2) return;

    const texts = cells.map(getCellText).map(normalizeQuestion);
    const questionCellIndex = findQuestionCell(texts);
    if (questionCellIndex === -1) return;

    const text = texts[questionCellIndex];
    const answer = answerMap.get(text);
    if (!answer) return;

    const structuredAnswer = applyStructuredAnswer(cells, answer, questionCellIndex);
    if (structuredAnswer) {
      let cellCursor = 0;
      newRow = newRow.replace(/<w:tc\b[\s\S]*?<\/w:tc>/g, () => structuredAnswer.cells[cellCursor++] || '');
    } else {
      const answerCellIndex = detectAnswerCell(cells, questionCellIndex);
      const originalAnswerCell = splitCells(newRow)[answerCellIndex];
      if (!originalAnswerCell) return;

      const replacement = answer.status === 'answered'
        ? replaceCellText(clearShade(originalAnswerCell), answer.answer)
        : shadeCell(replaceCellText(originalAnswerCell, ''));
      newRow = newRow.replace(originalAnswerCell, replacement);
    }

    if (newRow !== rowXml) updated = updated.replace(rowXml, newRow);
  });

  zip.file('word/document.xml', updated);
  return zip.generateAsync({ type: 'nodebuffer' });
}

export const docxInternals = { W_NS };
