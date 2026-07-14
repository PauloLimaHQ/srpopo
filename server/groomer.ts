/*
 * Idea grooming — turns a rough idea into one or more well-structured task
 * prompts by running a short, read-only Claude session inside the repo.
 *
 * This file is the single source of truth for that flow's two moving parts:
 *   - `metaPrompt(idea)`   — the prompt-engineer instructions sent to the
 *     grooming session (see runner.groom), and
 *   - `parseResult(text)`  — the parser that turns the session's final answer
 *     back into an array of { title, prompt, ready } task specs.
 *
 * The grooming session is asked to emit its answer as JSON between two unique
 * sentinels so we can extract it verbatim even when the groomed prompts
 * themselves contain markdown, braces, or code fences.
 */

const SPEC_START = '@@SRPOPO_SPEC_START@@';
const SPEC_END = '@@SRPOPO_SPEC_END@@';

// One groomed task as the session proposes it. `ready` is the session's own
// judgment that the prompt is self-contained enough to dispatch unreviewed —
// honored only when the grooming's target is 'auto'.
export interface GroomSpec {
  title: string;
  prompt: string;
  ready: boolean;
}

// The prompt-engineer brief handed to the read-only grooming session. It is
// grounded in the repo (the session explores it) and must end with the spec
// JSON between the sentinels so parseResult can recover it reliably.
function metaPrompt(idea: unknown): string {
  return [
    'You are an expert prompt engineer and staff-level software lead working inside a git repository.',
    'A developer has a rough idea for a change they want to make in THIS codebase, but it is not yet',
    'specified well enough to hand to a coding agent.',
    '',
    'Your job: think the idea through and turn it into one or more clear, self-contained task prompts',
    'that other Claude Code agents could each execute end-to-end without further clarification.',
    '',
    'Do this:',
    '1. Explore the repository as needed to ground the work in reality — read the relevant files,',
    '   conventions, and existing patterns. This is READ-ONLY research: do not modify any files.',
    '2. Decide how many tasks the idea really is. Prefer ONE task; split it only when the idea clearly',
    '   contains independent pieces of work that should be built and reviewed separately (they must not',
    '   depend on each other\'s uncommitted changes). Never pad the list — a single well-scoped task',
    '   beats an artificial breakdown.',
    '3. Infer the concrete, minimal scope for each task. Resolve ambiguity with the most reasonable',
    '   interpretation given the codebase; state explicit assumptions instead of asking questions.',
    '4. Write each task prompt in clear markdown: what to build, where in the codebase it likely lives,',
    '   the constraints/conventions to respect, and how to verify it (tests, lint). Keep it focused and',
    '   free of gold-plating.',
    '',
    "The developer's rough idea:",
    '"""',
    String(idea || '').trim(),
    '"""',
    '',
    'When you are done, output your final answer as a single JSON object between the two markers below,',
    'with valid JSON in between and NOTHING else after it. Use exactly this shape:',
    '  - "tasks": an array with one entry per task, each with:',
    '    - "title": a short, imperative task title (max 60 characters).',
    '    - "prompt": the full task prompt as a markdown string, self-contained and ready to hand to a',
    '      coding agent.',
    '    - "ready": true when the prompt is unambiguous and safe to dispatch without a human reviewing',
    '      it first; false when the developer should look it over.',
    '',
    SPEC_START,
    '{ "tasks": [ { "title": "…", "prompt": "…", "ready": true } ] }',
    SPEC_END,
  ].join('\n');
}

// A short, safe title derived straight from the raw idea. Used as the grooming
// card's title, and as a fallback if the session can't produce a structured one.
function deriveTitle(idea: unknown): string {
  const line = String(idea || '')
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean) || 'Groomed idea';
  return line.length > 60 ? line.slice(0, 57).trimEnd() + '…' : line;
}

// Normalize one raw spec entry; null when it has no usable prompt.
function normalizeSpec(obj: unknown): GroomSpec | null {
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  const prompt = typeof rec.prompt === 'string' ? rec.prompt.trim() : '';
  if (!prompt) return null;
  const title = typeof rec.title === 'string' ? rec.title.trim() : '';
  return { title, prompt, ready: rec.ready === true };
}

// Recover the task specs from the grooming session's final text. Prefers the
// sentinel-delimited JSON; falls back to a ```json fence, then to a bare {…}
// span. Accepts both the { tasks: […] } shape and the legacy single
// { title, prompt } object. Returns null when no usable spec can be parsed.
function parseResult(text: unknown): GroomSpec[] | null {
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
    const raw = Array.isArray(obj?.tasks) ? obj.tasks : [obj];
    const specs = raw.map(normalizeSpec).filter((s: GroomSpec | null): s is GroomSpec => !!s);
    return specs.length ? specs : null;
  } catch {
    return null;
  }
}

export { metaPrompt, parseResult, deriveTitle, SPEC_START, SPEC_END };
