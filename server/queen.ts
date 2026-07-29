/*
 * Hive orchestration — the "queen" session's prompts and status parser.
 *
 * A queen is a read-only `claude -p` session that owns ONE high-level goal for
 * ONE repo. It plans the goal, spawns worker tasks onto the Kanban board through
 * Sr. Popo's own MCP server (server/mcp.ts, registered as `board` — see
 * orchestrateArgs in server/agents/claude.ts), watches what those workers do,
 * and coordinates follow-ups until the goal is met. It never edits the repo
 * itself: the workers own every mutation.
 *
 * This file is the single source of truth for that conversation, mirroring
 * server/groomer.ts's role for grooming:
 *   - `metaPrompt(...)`   — the brief that opens the session,
 *   - `statusPrompt(...)` — the update that resumes it once watched workers land,
 *   - `replyPrompt(...)`  — the developer's answer to a question it asked,
 *   - `nudgePrompt()`     — the "you asked to wait on nothing" self-heal,
 *   - `parseStatus(text)` — recovers the one status object each turn must end with.
 *
 * Every turn ends with exactly one JSON object between the HIVE sentinels, in
 * one of four states:
 *   { "state": "waiting",  "watch": [taskIds], "note": "…" }  → watch those workers
 *   { "state": "question", "note": "…" }                      → ask the developer
 *   { "state": "done",     "summary": "…" }                   → the goal is met
 *   { "state": "blocked",  "note": "…" }                      → it cannot proceed
 */
import * as sentinels from './sentinels';
import type { Orchestration, OrchestrationMode, Task } from './types';

const HIVE_START = '@@SRPOPO_HIVE_START@@';
const HIVE_END = '@@SRPOPO_HIVE_END@@';

// The four ways a queen turn can end. They map onto the orchestration's own
// lifecycle: waiting → 'waiting', question → 'awaiting', done → 'finished',
// blocked → 'failed'.
export type QueenState = 'waiting' | 'question' | 'done' | 'blocked';

export interface QueenStatus {
  state: QueenState;
  // Worker task ids to watch — only meaningful for 'waiting'.
  watch: string[];
  // What it's waiting on / the question it asks / the closing summary.
  note: string;
}

const STATES: QueenState[] = ['waiting', 'question', 'done', 'blocked'];

// How many watched task ids we accept from one turn. Generous, but bounded so a
// runaway answer can't bloat the record or the next status prompt.
const MAX_WATCH = 40;

// The shared closing contract, restated at the end of every prompt so the model
// re-reads it on each turn (a resumed session drifts otherwise).
function statusContract(mode: OrchestrationMode): string[] {
  const watchWhen = mode === 'autonomous'
    ? 'reach "done" (merged by Autonomous Mode) or "failed"'
    : 'reach "validation" (code-reviewed and waiting on a human) or "failed"';
  return [
    'HOW TO END EVERY TURN (non-negotiable):',
    'Finish each turn with exactly ONE JSON object between the two markers below, and NOTHING after it.',
    'Use one of these four shapes:',
    `  { "state": "waiting", "watch": ["taskId", …], "note": "what you are waiting for" }`,
    `      — you have work in flight. List the ids of the worker tasks whose results you need.`,
    `        Sr. Popo wakes you up again as soon as those tasks ${watchWhen}.`,
    '  { "state": "question", "note": "the question, with enough context to answer it" }',
    '      — you need a decision only the developer can make. They reply in free text and you resume.',
    '        Use this sparingly: prefer a reasonable assumption you state out loud.',
    '  { "state": "done", "summary": "what was accomplished, task by task" }',
    '      — the goal is met and no work is outstanding.',
    '  { "state": "blocked", "note": "why you cannot proceed" }',
    '      — something is genuinely wrong and no further worker task would help.',
    '',
    'Emit the object between these exact markers:',
    HIVE_START,
    '{ "state": "waiting", "watch": ["abc123"], "note": "…" }',
    HIVE_END,
  ];
}

// How the queen must create work, given how it will be executed. In autonomous
// hand-off the engine dispatches/reviews/merges (so tasks are created `ready`
// with the lifecycle add-ons); in manual mode the queen dispatches them itself.
function executionSection(mode: OrchestrationMode): string[] {
  if (mode === 'autonomous') {
    return [
      'EXECUTION MODE: autonomous hand-off.',
      'Autonomous Mode is running for this repo. It picks up every task that lands in "ready", dispatches',
      'it, review-loops it, and merges its pull request — you must NOT dispatch anything yourself.',
      'So create each worker task with:',
      '  status: "ready"',
      '  addons: ["pull_request", "code_review"]',
      '  useWorktree: true',
      'Then end the turn waiting on those task ids. A worker that reaches "done" was merged successfully;',
      'one that reaches "failed" needs your judgment (a fix-up task, a different split, or a question).',
    ];
  }
  return [
    'EXECUTION MODE: manual.',
    'Autonomous Mode is NOT running, so you drive execution yourself:',
    '  1. create each worker task with useWorktree: true, autoCodeReview: true and',
    '     addons: ["pull_request", "code_review"] (leave status at its default "backlog" — you are',
    '     about to dispatch it),',
    '  2. call mcp__board__dispatch_task on each task you want running now.',
    'Respect the parallel-session cap: if dispatch_task fails with a capacity error, leave that task queued,',
    'say so in your note, and dispatch it on a later turn once the running ones land.',
    'A worker that finishes is graded by a Code Review pass first, then parks in "validation" waiting on a',
    'human to merge its PR; one that reaches "failed" needs your judgment.',
  ];
}

// The brief that opens a queen session. `repoId` is handed over explicitly
// because every mcp__board__create_task call needs it, and the session has no
// other way to know which registered repo it is standing in.
function metaPrompt(
  orchestration: Pick<Orchestration, 'goal' | 'repoId' | 'repoName' | 'mode'>,
  memory?: string,
): string {
  const lines = [
    'You are a staff-level tech lead orchestrating a team of coding agents on a local Kanban board.',
    'A developer has given you ONE high-level goal for THIS repository. Your job is to plan it, hand the',
    'work to worker agents, watch what they produce, and keep coordinating until the goal is genuinely met.',
    '',
    'You are the planner and coordinator — NOT the implementer. You have read-only access to this repo',
    '(Read/Grep/Glob and read-only git commands) and you must never modify a file. Every change is made by',
    'a worker task you create on the board. If you catch yourself wanting to edit something, write a task',
    'for it instead.',
    '',
    'The goal:',
    '"""',
    String(orchestration.goal || '').trim(),
    '"""',
    '',
    `Repository: ${orchestration.repoName} — pass repoId "${orchestration.repoId}" to every create_task call.`,
    '',
    'YOUR BOARD TOOLS (MCP server "board"):',
    '  mcp__board__list_tasks    — see what is already on the board (filter by repoId/status)',
    '  mcp__board__get_task      — one task in full, with a tail of its session log; use this to read what',
    '                              a worker actually did (and why it failed) before deciding what is next',
    '  mcp__board__create_task   — queue a worker task (repoId, title, prompt, useWorktree, addons, status)',
    '  mcp__board__dispatch_task — run a task (see the execution mode below for whether that is yours to do)',
    '  mcp__board__stop_task     — stop a run that is clearly going the wrong way',
    '  mcp__board__list_repos    — the registered repos, if you ever need to confirm the id',
    '',
    'HOW TO PLAN:',
    '1. Explore the repository first — read the relevant code, conventions and existing patterns, plus any',
    '   CLAUDE.md / CONTRIBUTING.md. Ground the plan in what is actually there, not what you assume.',
    '2. Break the goal into a small number of self-contained worker tasks. Prefer FEW GOOD TASKS over many:',
    '   each one must be independently buildable and reviewable, and must not depend on another task\'s',
    '   uncommitted changes. If the goal is really one task, create one task.',
    '3. Sequence honestly. If step B genuinely needs step A merged first, do NOT create B yet — create A,',
    '   wait for it, then create B on a later turn with what you learned.',
    '4. Write each worker prompt as a complete, standalone brief in markdown: what to build, where in the',
    '   codebase it lives, the conventions to respect, and how to verify it (tests, lint). The worker never',
    '   sees this conversation or the other tasks, so no prompt may say "as discussed" or "like the other',
    '   task". Repeat whatever context it needs.',
    '5. Never create the same task twice. Before you create anything on a resumed turn, check what you have',
    '   already spawned.',
    '',
  ];

  if (memory && memory.trim()) {
    lines.push(
      'What Sr. Popo remembers about this project (accumulated from past sessions; treat as helpful context,',
      'verify against the code when it matters):',
      '"""',
      memory.trim(),
      '"""',
      '',
    );
  }

  lines.push(
    ...executionSection(orchestration.mode),
    '',
    'WHEN A WORKER LANDS:',
    'You will be resumed with a status update for every task you are watching. Then decide, deliberately:',
    '  - spawn the next slice of work now that its dependency is in,',
    '  - spawn a fix-up task for a worker that failed or came back wrong (read its log first — a fix-up',
    '    prompt must explain what went wrong and what to do instead),',
    '  - ask the developer a question, or',
    '  - declare the goal done.',
    'Do not pad the plan with busywork to look thorough, and do not declare victory while work is missing.',
    '',
    ...statusContract(orchestration.mode),
  );
  return lines.join('\n');
}

// One line of the worker-status digest a resume prompt carries.
function taskLine(task: Task): string {
  const bits = [`status=${task.status}`];
  if (task.lastOutcome) bits.push(`outcome=${task.lastOutcome}`);
  if (task.branch) bits.push(`branch=${task.branch}`);
  if (task.runCount) bits.push(`runs=${task.runCount}`);
  if (task.costUsd) bits.push(`cost=$${task.costUsd.toFixed(2)}`);
  let line = `- ${task.id} "${task.title}" — ${bits.join(', ')}`;
  if (task.lastError) line += `\n    last error: ${String(task.lastError).slice(0, 400)}`;
  return line;
}

// The follow-up that resumes a waiting queen once its watched workers landed.
// `tasks` are the watched tasks as they stand right now (missing ones — deleted
// on the board — are reported so the queen doesn't keep waiting on a ghost).
function statusPrompt(orchestration: Pick<Orchestration, 'watch' | 'mode'>, tasks: Task[]): string {
  const found = new Set(tasks.map((t) => t.id));
  const missing = (orchestration.watch || []).filter((id) => !found.has(id));
  const lines = [
    'Status update on the worker tasks you were watching:',
    '',
    ...(tasks.length ? tasks.map(taskLine) : ['(none of the watched tasks could be found)']),
  ];
  if (missing.length) {
    lines.push('', `These watched ids no longer exist on the board (deleted): ${missing.join(', ')}.`);
  }
  lines.push(
    '',
    'Use mcp__board__get_task on any task whose result you need to understand before deciding — especially',
    'a failed one; read its log rather than guessing what went wrong.',
    '',
    'Now decide what happens next: spawn follow-up or fix-up work, keep waiting on tasks still in flight,',
    'ask the developer, or declare the goal done.',
    '',
    ...statusContract(orchestration.mode),
  );
  return lines.join('\n');
}

// The follow-up that resumes a queen paused on a question, carrying the
// developer's free-text answer.
function replyPrompt(question: string | null, reply: string, mode: OrchestrationMode): string {
  return [
    'The developer answered your question.',
    '',
    `Your question: ${String(question || '(not recorded)').trim()}`,
    `Their answer: ${String(reply || '').trim() || '(no answer given — use your best judgment)'}`,
    '',
    'Continue orchestrating with that decision. Only ask again if something else is genuinely blocking.',
    '',
    ...statusContract(mode),
  ].join('\n');
}

// Self-heal for a turn that ended "waiting" with an empty watch list: nothing
// would ever wake the session up, so we resume it immediately and ask it to
// either name what it is waiting for or pick a terminal state.
function nudgePrompt(mode: OrchestrationMode): string {
  return [
    'You ended your turn as "waiting" but listed no task ids to watch, so there is nothing that could wake',
    'you up. Either create the next worker task(s) and wait on their ids, or end this turn with "done",',
    '"question", or "blocked".',
    '',
    ...statusContract(mode),
  ].join('\n');
}

// A short, safe title derived from the goal — the orchestration card's label.
function deriveTitle(goal: unknown): string {
  const line = String(goal || '')
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean) || 'Orchestrated goal';
  return line.length > 60 ? line.slice(0, 57).trimEnd() + '…' : line;
}

// Recover the status object a turn ends with. Returns null when the payload is
// missing, unparseable, or carries no recognized state — the caller then treats
// the turn as a failure rather than silently guessing what the queen meant.
function parseStatus(text: unknown): QueenStatus | null {
  const obj = sentinels.parseObject(text, HIVE_START, HIVE_END);
  if (!obj) return null;
  const raw = typeof obj.state === 'string' ? obj.state.trim().toLowerCase() : '';
  const state = STATES.find((s) => s === raw);
  if (!state) return null;
  const watch = Array.isArray(obj.watch)
    ? [...new Set(obj.watch.map((v) => String(v).trim()).filter(Boolean))].slice(0, MAX_WATCH)
    : [];
  const noteSource = typeof obj.note === 'string' && obj.note.trim()
    ? obj.note
    : typeof obj.summary === 'string' ? obj.summary : '';
  return { state, watch: state === 'waiting' ? watch : [], note: String(noteSource).trim() };
}

export {
  metaPrompt,
  statusPrompt,
  replyPrompt,
  nudgePrompt,
  parseStatus,
  deriveTitle,
  HIVE_START,
  HIVE_END,
};
