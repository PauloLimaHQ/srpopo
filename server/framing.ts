/*
 * Prompt framing — the single place that turns a task's prompt into the exact
 * text a fresh `claude -p` run receives on stdin.
 *
 * A dispatched run is framed the same way no matter who starts it: any selected
 * personas are prepended (the "who"), the task prompt sits in the middle, the
 * selected add-on behaviors are appended (the "what to do at the end"), and any
 * attached files are listed by absolute path so the session can Read them.
 *
 * Extracted here so both the interactive dispatch route (server/index.ts) and the
 * Autonomous Mode engine (server/autonomous.ts) build byte-for-byte identical
 * prompts — the engine must not drift from what a human dispatch would send.
 */
import * as personas from './personas';
import * as addons from './addons';
import * as attachments from './attachments';
import type { Task } from './types';

// A URL/branch/worktree-safe slug from arbitrary text. Kept here (rather than in
// index.ts) so the engine can name its worktrees exactly as the dispatch route does.
function slugify(text: unknown): string {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'task'
  );
}

// Build the full stdin prompt for a fresh (non-resume) dispatch of `task`.
function framePrompt(task: Task): string {
  let framed = personas.preambleFor(task.personas) + task.prompt + addons.instructionsFor(task.addons);
  // List any attached files by absolute path so the session can Read them.
  if (task.attachments?.length) {
    const paths = attachments.listPaths(task.id, task.attachments.map((a) => a.name));
    if (paths.length) {
      framed += '\n\n## Attached files\nThe user attached these files for this task. Read them as needed:\n' +
        paths.map((p) => `- ${p}`).join('\n');
    }
  }
  return framed;
}

// Build the stdin prompt for an autonomous *review pass* — a resume of a finished
// task's session that critically re-reviews the branch before it's merged. The
// engine (server/autonomous.ts) decides "needs another look" vs "clean" purely by
// whether this run advanced HEAD, so the directive is explicit: commit real fixes,
// but make no commit at all when the work is already correct.
function frameReviewPrompt(task: Task): string {
  return [
    'You previously worked on the task below and opened a pull request for it.',
    'Before it is merged, do one more rigorous review of the changes on this branch.',
    '',
    '## Original task',
    task.prompt,
    '',
    '## What to do now',
    '- Inspect the full diff of this branch against its base (e.g. `git diff`).',
    '- Look for correctness bugs, missed requirements, edge cases, security issues,',
    '  regressions, and anything that does not match the surrounding code style.',
    '- If you find any real problem or worthwhile improvement, fix it now: edit the',
    '  code, then commit and push so the pull request is updated.',
    '- If the change is already correct and complete, make NO changes and create no',
    '  commit — leave the branch exactly as it is.',
    '- Finish by summarizing what you reviewed and what, if anything, you changed.',
  ].join('\n');
}

export { framePrompt, frameReviewPrompt, slugify };
