import type { GeneratedAnswer, KnowledgeChunk } from './types';

export type ProfileFacts = {
  companyName?: string;
  address?: string;
  phone?: string;
  email?: string;
};

function clean(value: string) {
  return value.replace(/\s+/g, ' ').replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

function pickFirstMatch(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.[1] ? clean(match[1]) : '';
    if (value && value.length >= 3 && value.length <= 180) return value;
  }
  return undefined;
}

function pickCompanyName(chunks: KnowledgeChunk[]) {
  const combined = chunks.map((chunk) => chunk.chunk_text).join('\n');

  const explicit = pickFirstMatch(combined, [
    /(?:company name|company\s*[:\-]|name of company|firma ismi|firmamız|firmamiz)\s*[:\-]?\s*([^\n.;]{3,120})/i,
    /(?:site master file|quality manual)\s+(?:of|for)\s+([^\n.;]{3,120})/i,
    /(?:prepared by|issued by)\s*[:\-]?\s*([^\n.;]{3,120})/i,
  ]);
  if (explicit) return explicit;

  const scored = new Map<string, number>();
  const companyLike = combined.match(/\b[A-Z][A-Z0-9&.,'’\- ]{2,80}\b(?:LIMITED|LTD\.?|PRIVATE LIMITED|PVT\.? LTD\.?|PHARMA(?:CEUTICALS)?|LABORATORIES|LABS|INDUSTRIES|CHEMICALS|BIO(?:TECH)?|INC\.?|LLC)\b/gi) || [];

  for (const item of companyLike) {
    const value = clean(item).replace(/\s+/g, ' ');
    if (/\b(quality manual|site master file|standard operating procedure|department|procedure)\b/i.test(value)) continue;
    scored.set(value, (scored.get(value) || 0) + 1);
  }

  return [...scored.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function extractProfileFacts(chunks: KnowledgeChunk[]): ProfileFacts {
  const combined = chunks.map((chunk) => chunk.chunk_text).join('\n');
  return {
    companyName: pickCompanyName(chunks),
    address: pickFirstMatch(combined, [
      /(?:registered office|corporate office|address|site address|plant address)\s*[:\-]?\s*([^\n]{8,180})/i,
    ]),
    phone: pickFirstMatch(combined, [
      /(?:phone|telephone|tel\.?|contact no\.?|mobile)\s*[:\-]?\s*([+()0-9\-\s]{7,30})/i,
    ]),
    email: pickFirstMatch(combined, [
      /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i,
    ]),
  };
}

function isLabelOnly(question: string, patterns: RegExp[]) {
  const compact = question.replace(/[:：\-–—_.\s]+/g, ' ').trim();
  if (compact.length > 80) return false;
  return patterns.some((pattern) => pattern.test(compact));
}

export function answerFromProfile(questionId: string, question: string, facts: ProfileFacts): GeneratedAnswer | null {
  const today = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(new Date());

  const makeAnswer = (answer: string, reason: string): GeneratedAnswer => ({
    questionId,
    question,
    answer,
    status: 'answered',
    confidence: 0.95,
    reason,
    evidence: [],
  });

  if (isLabelOnly(question, [/^(date|tarih)$/i, /^(questionnaire date|form date)$/i])) {
    return makeAnswer(today, 'Filled from current date.');
  }

  if (isLabelOnly(question, [/^(company name|firma ismi|name of company|firma adı|firma adi)$/i]) && facts.companyName) {
    return makeAnswer(facts.companyName, 'Filled from uploaded company knowledge.');
  }

  if (isLabelOnly(question, [/^(address|adres|headquarters|registered office|plant address)$/i]) && facts.address) {
    return makeAnswer(facts.address, 'Filled from uploaded company knowledge.');
  }

  if (isLabelOnly(question, [/^(e-?mail|email)$/i]) && facts.email) {
    return makeAnswer(facts.email, 'Filled from uploaded company knowledge.');
  }

  if (isLabelOnly(question, [/^(phone|telephone|telefon|tel|mobile)$/i]) && facts.phone) {
    return makeAnswer(facts.phone, 'Filled from uploaded company knowledge.');
  }

  return null;
}
