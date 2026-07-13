/*
 * Idea grooming — turns a rough, one-line idea into a well-structured task
 * prompt by running a short, read-only Claude session inside the repo.
 *
 * This file is the single source of truth for that flow's two moving parts:
 *   - `metaPrompt(brief)`  — the prompt-engineer instructions sent to the
 *     grooming session (see runner.groom), and
 *   - `parseResult(text)`  — the parser that turns the session's final answer
 *     back into a { title, prompt } task spec.
 *
 * The grooming session is asked to emit its answer as JSON between two unique
 * sentinels so we can extract it verbatim even when the groomed prompt itself
 * contains markdown, braces, or code fences.
 */

const SPEC_START = '@@SRPOPO_SPEC_START@@';
const SPEC_END = '@@SRPOPO_SPEC_END@@';

// The prompt-engineer brief handed to the read-only grooming session. It is
// grounded in the repo (the session explores it) and must end with the spec
// JSON between the sentinels so parseResult can recover it reliably.
function metaPrompt(brief: unknown): string {
  return [
    'You are an expert prompt engineer and staff-level software lead working inside a git repository.',
    'A developer has a rough idea for a change they want to make in THIS codebase, but it is not yet',
    'specified well enough to hand to a coding agent.',
    '',
    'Your job: turn the rough idea into ONE clear, self-contained task prompt that another Claude Code',
    'agent could execute end-to-end without further clarification.',
    '',
    'Do this:',
    '1. Explore the repository as needed to ground the task in reality — read the relevant files,',
    '   conventions, and existing patterns. This is READ-ONLY research: do not modify any files.',
    '2. Infer the concrete, minimal scope that satisfies the idea. Resolve ambiguity with the most',
    '   reasonable interpretation given the codebase; state explicit assumptions instead of asking',
    '   questions.',
    '3. Write the final task prompt in clear markdown: what to build, where in the codebase it likely',
    '   lives, the constraints/conventions to respect, and how to verify it (tests, lint). Keep it',
    '   focused and free of gold-plating.',
    '',
    "The developer's rough idea:",
    '"""',
    String(brief || '').trim(),
    '"""',
    '',
    'When you are done, output your final answer as a single JSON object between the two markers below,',
    'with valid JSON in between and NOTHING else after it. Use exactly these keys:',
    '  - "title": a short, imperative task title (max 60 characters).',
    '  - "prompt": the full task prompt as a markdown string, self-contained and ready to hand to a',
    '    coding agent.',
    '',
    SPEC_START,
    '{ "title": "…", "prompt": "…" }',
    SPEC_END,
  ].join('\n');
}

// A short, safe title derived straight from the raw idea. Used as the task's
// placeholder title while grooming runs, and as a fallback if grooming can't
// produce a structured title.
function deriveTitle(brief: unknown): string {
  const line = String(brief || '')
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean) || 'Groomed idea';
  return line.length > 60 ? line.slice(0, 57).trimEnd() + '…' : line;
}

// Recover the { title, prompt } spec from the grooming session's final text.
// Prefers the sentinel-delimited JSON; falls back to a ```json fence, then to a
// bare {…} span. Returns null when no usable prompt can be parsed.
function parseResult(text: unknown): { title: string; prompt: string } | null {
  if (typeof text !== 'string' || !text) return null;

  let json: string | null = null;
  const start = text.lastIndexOf(SPEC_START);
  const end = text.lastIndexOf(SPEC_END);
  if (start !== -1 && end > start) {
    json = text.slice(start + SPEC_START.length, end).trim();
  } else {
    const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
    if (fences.length) {
      json = fences[fences.length - 1][1].trim();
    } else {
      const s = text.indexOf('{');
      const e = text.lastIndexOf('}');
      if (s !== -1 && e > s) json = text.slice(s, e + 1);
    }
  }
  if (!json) return null;

  try {
    const obj = JSON.parse(json);
    const prompt = typeof obj.prompt === 'string' ? obj.prompt.trim() : '';
    if (!prompt) return null;
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    return { title, prompt };
  } catch {
    return null;
  }
}

export { metaPrompt, parseResult, deriveTitle, SPEC_START, SPEC_END };
