export const MAX_KNOWLEDGE_FILES = 10;
export const MAX_KNOWLEDGE_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_KNOWLEDGE_REQUEST_BYTES = 60 * 1024 * 1024;
export const MAX_QUESTIONNAIRE_BYTES = 15 * 1024 * 1024;
export const MAX_FILL_REQUEST_BYTES = 25 * 1024 * 1024;
export const MAX_FINALIZE_ANSWERS = 500;

export function requestContentLength(request: Request) {
  const raw = request.headers.get('content-length');
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function exceedsContentLength(request: Request, maxBytes: number) {
  const length = requestContentLength(request);
  return length !== null && length > maxBytes;
}

export function publicError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export function authorizedByOptionalBearerToken(request: Request, token: string | undefined) {
  if (!token) return true;
  const expected = `Bearer ${token}`;
  return request.headers.get('authorization') === expected;
}

