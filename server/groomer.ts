/*
 * Idea grooming — turns a rough idea into one or more well-structured task
 * prompts by running a short, read-only Claude session inside the repo.
 *
 * This file is the single source of truth for that flow's moving parts:
 *   - `metaPrompt(idea)`     — the prompt-engineer instructions sent to the
 *     grooming session (see runner.groom),
 *   - `parseQuestions(text)` — recovers the clarifying questions the session may
 *     ask back when the idea is genuinely ambiguous (see below), and
 *   - `parseResult(text)`    — the parser that turns the session's final answer
 *     back into an array of { title, prompt, ready } task specs,
 *   - `answersPrompt(...)`   — the follow-up prompt that feeds the developer's
 *     answers back into the paused session so it can finish grooming.
 *
 * The grooming session can end a turn in one of two ways, each emitted as a
 * single JSON object between the same two unique sentinels so we can extract it
 * verbatim even when the groomed prompts themselves contain markdown, braces, or
 * code fences:
 *   - `{ "questions": [ … ] }` — it needs the developer to clarify something
 *     before it can write a good spec (Sr. Popo surfaces these, collects the
 *     answers, and resumes the session), or
 *   - `{ "tasks": [ … ] }`     — it has finished and is proposing task specs.
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

// One clarifying question the grooming session asks back when the idea is too
// ambiguous to spec confidently. `options` are suggested answers the developer
// can pick (empty when the question is open-ended); `allowText` says whether a
// free-text answer is also accepted — always true when there are no options, so
// every question stays answerable (mirrors Claude Desktop's ask-with-choices).
export interface GroomQuestion {
  question: string;
  options: string[];
  allowText: boolean;
}

// The prompt-engineer brief handed to the read-only grooming session. It is
// grounded in the repo (the session explores it) and must end with either the
// questions JSON or the spec JSON between the sentinels so the parsers can
// recover it reliably.
function metaPrompt(idea: unknown, memory?: string): string {
  const lines = [
    'You are an expert prompt engineer and staff-level software lead working inside a git repository.',
    'A developer has a rough idea for a change they want to make in THIS codebase, but it is not yet',
    'specified well enough to hand to a coding agent.',
    '',
    'Your job: think the idea through and turn it into one or more clear, self-contained task prompts',
    'that other coding agents could each execute end-to-end without further clarification.',
    '',
    'Do this:',
    '1. Explore the repository as needed to ground the work in reality — read the relevant files,',
    '   conventions, and existing patterns. This is READ-ONLY research: do not modify any files.',
    '2. Resolve small ambiguities yourself with the most reasonable interpretation given the codebase,',
    '   and state those assumptions in the prompt. But when a genuine decision would change what gets',
    '   built — scope, product behavior, a fork in the approach, missing context only the developer has —',
    '   do NOT guess. Ask the developer to clarify first (see "Asking to clarify" below). Prefer asking',
    '   a few sharp questions up front over shipping a confidently wrong spec.',
    '3. Once the intent is clear, decide how many tasks the idea really is. Prefer ONE task; split it only',
    '   when the idea clearly contains independent pieces of work that should be built and reviewed',
    "   separately (they must not depend on each other's uncommitted changes). Never pad the list — a",
    '   single well-scoped task beats an artificial breakdown.',
    '4. Write each task prompt in clear markdown: what to build, where in the codebase it likely lives,',
    '   the constraints/conventions to respect, and how to verify it (tests, lint). Keep it focused and',
    '   free of gold-plating.',
    '',
    "The developer's rough idea:",
    '"""',
    String(idea || '').trim(),
    '"""',
  ];

  if (memory && memory.trim()) {
    lines.push(
      '',
      'What Sr. Popo remembers about this project (accumulated from past sessions; treat as helpful',
      'context, verify against the code when it matters):',
      '"""',
      memory.trim(),
      '"""',
    );
  }

  lines.push(
    '',
    'Asking to clarify (only when it genuinely matters):',
    'If — and only if — you cannot write a confident spec without a decision the developer needs to make,',
    'end your turn by asking them. Output a single JSON object between the two markers below with a',
    '"questions" array, and NOTHING after it. Each question has:',
    '  - "question": the question, phrased so a short answer resolves it.',
    '  - "options": an array of 2–5 suggested answers the developer can pick from, most-likely first.',
    '    Use [] when the question is genuinely open-ended.',
    '  - "allowText": true if a free-text answer also makes sense (so the developer can type their own).',
    'Ask at most a handful of questions, only the ones that actually change the work. Do not ask about',
    'trivia you can reasonably assume. Once the developer answers, you will be resumed to finish.',
    '',
    'Finishing (when the intent is clear):',
    'Output your final answer as a single JSON object between the two markers below, with valid JSON in',
    'between and NOTHING after it. Use a "tasks" array, one entry per task, each with:',
    '  - "title": a short, imperative task title (max 60 characters).',
    '  - "prompt": the full task prompt as a markdown string, self-contained and ready to hand to a',
    '    coding agent.',
    '  - "ready": true when the prompt is unambiguous and safe to dispatch without a human reviewing',
    '    it first; false when the developer should look it over.',
    '',
    'Emit exactly ONE JSON object this turn — either the "questions" shape or the "tasks" shape — between',
    'these markers:',
    SPEC_START,
    '{ "tasks": [ { "title": "…", "prompt": "…", "ready": true } ] }',
    SPEC_END,
  );
  return lines.join('\n');
}

// The follow-up prompt that resumes a paused grooming session once the developer
// has answered its clarifying questions. Pairs each question with its answer and
// re-states the output contract so the resumed turn either finishes with a spec
// or (rarely) asks once more if something is still genuinely blocking.
function answersPrompt(questions: GroomQuestion[], answers: string[]): string {
  const qa = questions
    .map((q, i) => {
      const answer = (answers[i] || '').trim() || '(no answer given — use your best judgment)';
      return `${i + 1}. ${q.question}\n   Answer: ${answer}`;
    })
    .join('\n');
  return [
    'The developer answered your clarifying questions:',
    '',
    qa,
    '',
    'Use these answers to finalize the work. If everything is now clear, output the task spec(s) as the',
    '"tasks" JSON between the SPEC markers. Only ask again if something critical is still genuinely',
    'blocking — otherwise proceed with reasonable assumptions and finish. Emit exactly one JSON object',
    `between the ${SPEC_START} / ${SPEC_END} markers, as instructed before.`,
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

// Recover the single JSON payload the session emits at the end of a turn.
// Prefers the sentinel-delimited span; falls back to a ```json fence, then to a
// bare {…} span. Shared by parseResult and parseQuestions. Returns null when no
// candidate span is present.
function extractSpecJson(text: unknown): string | null {
  if (typeof text !== 'string' || !text) return null;
  const start = text.lastIndexOf(SPEC_START);
  const end = text.lastIndexOf(SPEC_END);
  if (start !== -1 && end > start) return text.slice(start + SPEC_START.length, end).trim();
  const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (fences.length) return fences[fences.length - 1][1].trim();
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s !== -1 && e > s) return text.slice(s, e + 1);
  return null;
}

// Parse the extracted span into an object, tolerating parse failures.
function parseSpecObject(text: unknown): Record<string, unknown> | null {
  const json = extractSpecJson(text);
  if (!json) return null;
  try {
    const obj = JSON.parse(json);
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
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

// Normalize one raw question entry; null when it has no usable question text.
function normalizeQuestion(obj: unknown): GroomQuestion | null {
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  const question = typeof rec.question === 'string' ? rec.question.trim() : '';
  if (!question) return null;
  const options = Array.isArray(rec.options)
    ? rec.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 6)
    : [];
  // A question with no options must accept free text, or it can't be answered.
  const allowText = options.length === 0 ? true : rec.allowText === true;
  return { question, options, allowText };
}

// Recover the clarifying questions the session asked, if any. Returns the parsed
// questions when the payload carries a non-empty "questions" array, else null
// (in which case the caller should try parseResult for a finished task spec).
function parseQuestions(text: unknown): GroomQuestion[] | null {
  const obj = parseSpecObject(text);
  if (!obj || !Array.isArray(obj.questions)) return null;
  const questions = obj.questions
    .map(normalizeQuestion)
    .filter((q: GroomQuestion | null): q is GroomQuestion => !!q);
  return questions.length ? questions : null;
}

// Recover the task specs from the grooming session's final text. Accepts both
// the { tasks: […] } shape and the legacy single { title, prompt } object.
// Returns null when no usable spec can be parsed (e.g. the payload was a
// questions turn, or had no prompt).
function parseResult(text: unknown): GroomSpec[] | null {
  const obj = parseSpecObject(text);
  if (!obj) return null;
  const raw = Array.isArray(obj.tasks) ? obj.tasks : [obj];
  const specs = raw.map(normalizeSpec).filter((s: GroomSpec | null): s is GroomSpec => !!s);
  return specs.length ? specs : null;
}

export { metaPrompt, answersPrompt, parseResult, parseQuestions, deriveTitle, SPEC_START, SPEC_END };
