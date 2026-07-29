/*
 * Code Review — the stage between a finished run and human validation.
 *
 * A task that lands successfully with an open pull request gets a FRESH,
 * independent reviewer session (runner.codeReview) in its worktree: a different
 * pair of eyes that did not write the code, read-only on the repo, allowed just
 * enough `gh` to read the PR and post ONE review comment on it. This file is the
 * single source of truth for that flow's moving parts, mirroring server/groomer.ts:
 *   - `metaPrompt(task, pr)`  — the reviewer's brief, including the grade rubric,
 *   - `parseVerdict(text)`    — tolerant recovery of the turn's closing JSON, and
 *   - `applyVerdict(task, v)` — writes the verdict onto the task (pure-ish, so the
 *     bookkeeping is unit-testable without spawning anything).
 *
 * Division of labor: the AGENT owns the prose review (it posts the PR comment);
 * the SERVER owns the grade label on the PR (github.setMergeableLabel), which is
 * derived deterministically from the parsed grade. The reviewer is deliberately
 * NOT given `gh pr edit` or `gh label`.
 */

import * as sentinels from './sentinels';
import type { PrInfo, Task, TaskCodeReview } from './types';

const REVIEW_START = '@@SRPOPO_REVIEW_START@@';
const REVIEW_END = '@@SRPOPO_REVIEW_END@@';

// The grade scale, in the exact wording used in the reviewer prompt, in the PR
// comment, and in the board's own tooltips — one vocabulary everywhere.
const GRADE_MEANINGS: Record<number, string> = {
  1: 'must not be merged',
  2: 'still not mergeable, but better than 1',
  3: 'mergeable with reservations',
  4: 'mergeable, only nits',
  5: 'good to go',
};

// The verdict one review turn produces. Same shape the task carries, minus the
// server-stamped `reviewedAt`.
export interface ReviewVerdict {
  grade: number;
  summary: string;
  blockers: string[];
  commentUrl: string | null;
}

// The rubric, restated verbatim in the prompt so the scale is applied
// consistently across reviews (and across models).
function rubric(): string[] {
  return [1, 2, 3, 4, 5].map((g) => `  ${g} = ${GRADE_MEANINGS[g]}`);
}

// The brief handed to the read-only reviewer session. It reviews the branch the
// task built, posts one review comment on the PR, and closes the turn with the
// verdict JSON between the sentinels so parseVerdict can recover it.
function metaPrompt(
  task: Pick<Task, 'title' | 'prompt' | 'branch'>,
  pr: Pick<PrInfo, 'number' | 'title'>,
): string {
  const lines = [
    'You are a staff-level engineer doing an independent CODE REVIEW of a pull request in this repository.',
    'You did NOT write this code — another agent did. Review it as a fresh, skeptical second pair of eyes:',
    'no ownership, no benefit of the doubt, and no assuming the author was right.',
    '',
    'You are READ-ONLY on the code. Do not edit, create or delete any file, do not commit, do not push, and',
    'do not change the pull request itself (no labels, no merges, no closing). The single write action you',
    'may take is posting ONE review comment on the pull request (see "Post your review" below).',
    '',
    `Pull request: #${pr.number}${pr.title ? ` — ${pr.title}` : ''}`,
    `Branch under review: ${task.branch || '(the current branch)'}`,
    '',
    'The task the author was given:',
    '"""',
    `${String(task.title || '').trim()}`,
    '',
    `${String(task.prompt || '').trim()}`,
    '"""',
    '',
    'HOW TO REVIEW:',
    '1. Read the full change against the base branch — `gh pr diff`, `git diff`, `git log` — and then read',
    '   enough of the surrounding code (the callers, the types, the tests) to judge correctness for real.',
    '   A diff-only reading catches style; it does not catch a broken contract.',
    '2. Judge specifically:',
    '   - correctness: does it do what it claims, in every path it touches?',
    '   - edge cases: empty/missing input, errors, concurrency, off-by-one, unhandled rejections.',
    '   - security: injected input, secrets, shell strings, anything widening an existing boundary.',
    '   - regressions: behavior it changes for existing callers, silently or otherwise.',
    '   - missed requirements: anything the original task asked for that is not actually done.',
    "   - conventions: the repo's own patterns and rules (read CLAUDE.md and any CONTRIBUTING.md if present).",
    '3. Be concrete. Every finding names the file and what is wrong, not a general worry. Do not invent',
    '   problems to look thorough, and do not pad the review with praise.',
    '',
    'GRADE THE PULL REQUEST on this 1-5 mergeable scale:',
    ...rubric(),
    'Grade the work as it stands, not its potential. A real blocker means 1 or 2 no matter how good the',
    'rest of the change is; "only nits left" is a 4; a genuinely clean change is a 5.',
    '',
    'POST YOUR REVIEW:',
    'Post exactly one comment on the pull request with:',
    `  gh pr comment ${pr.number} --body "<your review>"`,
    'Structure the body as: a one-line verdict, then the grade with its meaning from the scale above, then',
    'your findings grouped under "Blockers", "Should fix" and "Nits" (omit a group that is empty). Keep it',
    'readable markdown — this is what the developer reads on GitHub.',
    '',
    'THEN END YOUR TURN with exactly ONE JSON object between the two markers below, and NOTHING after it:',
    '  - "grade": the integer 1-5 you assigned.',
    '  - "summary": one or two sentences — the verdict in plain words.',
    '  - "blockers": the blocking findings as short strings (empty array when there are none).',
    '  - "commentUrl": the URL `gh pr comment` printed, or null if you could not post the comment.',
    REVIEW_START,
    '{ "grade": 4, "summary": "…", "blockers": [], "commentUrl": "https://github.com/…" }',
    REVIEW_END,
  ];
  return lines.join('\n');
}

// Coerce a raw grade into an integer 1..5, or null when there is nothing usable
// there (no grade at all, or a non-numeric value). Out-of-range numbers are
// clamped rather than rejected — a model that answers 0 or 9 still means "worst"
// or "best", and losing the whole review over it would be worse.
function coerceGrade(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value.trim()) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(5, Math.max(1, Math.round(n)));
}

// Recover the reviewer's closing verdict. Tolerant span extraction (sentinels →
// ```json fence → bare {…}) is shared with grooming/the queen via sentinels.ts.
// Returns null — never throws — when there is no usable grade in the payload.
function parseVerdict(text: unknown): ReviewVerdict | null {
  const obj = sentinels.parseObject(text, REVIEW_START, REVIEW_END);
  if (!obj) return null;
  const grade = coerceGrade(obj.grade);
  if (grade === null) return null;
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  const blockers = Array.isArray(obj.blockers)
    ? obj.blockers.map((b) => String(b).trim()).filter(Boolean).slice(0, 20)
    : [];
  const commentUrl = typeof obj.commentUrl === 'string' && obj.commentUrl.trim() ? obj.commentUrl.trim() : null;
  return { grade, summary: summary || gradeMeaning(grade), blockers, commentUrl };
}

// The human-readable meaning of a grade, for prompts, log lines and tooltips.
function gradeMeaning(grade: number): string {
  return GRADE_MEANINGS[grade] || 'ungraded';
}

// Record a verdict on the task and hand it back. Replaces any previous verdict —
// each pass grades the diff as it is now.
function applyVerdict(task: Pick<Task, 'codeReview'>, verdict: ReviewVerdict): TaskCodeReview {
  const codeReview: TaskCodeReview = {
    grade: verdict.grade,
    summary: verdict.summary,
    blockers: verdict.blockers,
    commentUrl: verdict.commentUrl,
    reviewedAt: new Date().toISOString(),
  };
  task.codeReview = codeReview;
  return codeReview;
}

export { metaPrompt, parseVerdict, applyVerdict, gradeMeaning, GRADE_MEANINGS, REVIEW_START, REVIEW_END };
