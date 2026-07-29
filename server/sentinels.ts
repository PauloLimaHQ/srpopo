/*
 * Tolerant recovery of the single JSON payload a read-only session emits at the
 * end of a turn, delimited by a pair of unique sentinels.
 *
 * Both the grooming flow (server/groomer.ts) and the hive orchestrator
 * (server/queen.ts) end every turn the same way: one JSON object between two
 * markers, chosen so the payload survives the markdown, braces and code fences
 * the session's own prose contains. The extraction is deliberately forgiving —
 * a model that drops the markers but still fences its JSON should not cost the
 * user a whole session — so it falls back to the last ```json fence and then to
 * the widest {…} span before giving up.
 */

// Recover the raw JSON span for one turn. Prefers the sentinel-delimited span
// (the last pair, so an echoed instruction earlier in the transcript loses to
// the real answer); falls back to a ```json fence, then to a bare {…} span.
// Returns null when no candidate span is present at all.
function extractJson(text: unknown, start: string, end: string): string | null {
  if (typeof text !== 'string' || !text) return null;
  const s = text.lastIndexOf(start);
  const e = text.lastIndexOf(end);
  if (s !== -1 && e > s) return text.slice(s + start.length, e).trim();
  const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (fences.length) return fences[fences.length - 1][1].trim();
  const open = text.indexOf('{');
  const close = text.lastIndexOf('}');
  if (open !== -1 && close > open) return text.slice(open, close + 1);
  return null;
}

// Parse the extracted span into a plain object, tolerating parse failures (a
// half-written or non-object payload is simply "no status this turn").
function parseObject(text: unknown, start: string, end: string): Record<string, unknown> | null {
  const json = extractJson(text, start, end);
  if (!json) return null;
  try {
    const obj = JSON.parse(json);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export { extractJson, parseObject };
