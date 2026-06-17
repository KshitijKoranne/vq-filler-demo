export function chunkText(text: string, maxChars = 1800): string[] {
  const cleaned = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!cleaned) return [];

  const paragraphs = cleaned.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if ((current + '\n\n' + paragraph).length > maxChars && current) {
      chunks.push(current.trim());
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export function normalizeQuestion(text: string) {
  return text.replace(/\s+/g, ' ').replace(/^\d+[.)-]?\s*/, '').trim();
}

export function looksLikeQuestion(text: string) {
  const value = normalizeQuestion(text).toLowerCase();
  if (value.length < 8 || value.length > 700) return false;
  if (value.endsWith('?')) return true;
  return /\b(do you|does your|is there|are there|provide|describe|confirm|whether|what is|who is|how do|how often|list|specify|mention|submit|attach)\b/.test(value);
}
