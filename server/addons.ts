/*
 * Task add-ons — optional behaviors the user can toggle when creating a task.
 *
 * This file is the single source of truth. Each entry drives both:
 *   - the checkbox rendered in the New/Edit Task modal (via GET /api/addons), and
 *   - the extra instructions injected into the prompt at dispatch time.
 *
 * To add a new behavior later, just append an entry below — nothing else needs
 * to change. `instruction` is prompt text appended to the task prompt when the
 * add-on is selected; keep it a clear, standalone directive to the agent (it runs on
 * whichever backend the task selected, so don't assume Claude-specific behavior).
 *
 * `allow` is an optional list of `--allowedTools` patterns the behavior needs to
 * actually run headless. Selecting the add-on auto-approves exactly these tools
 * (merged into the task's allow-list at dispatch), so the run doesn't silently
 * finish without doing the work when the default permission mode would otherwise
 * block a Bash command. Keep each list tight — only what the instruction requires.
 */

import { db } from './store';

interface Addon {
  id: string;
  label: string;
  // Compact name for the New Task modal's chip row. `label` stays the long,
  // self-explanatory form — it doubles as the heading of the injected prompt
  // block — so the chip needs its own two-word version. Falls back to `label`.
  short?: string;
  hint: string;
  instruction: string;
  // Glyph name from public/icons.js, so the board can render the add-on as an
  // icon chip instead of a bare checkbox. Unknown/missing falls back client-side.
  icon?: string;
  // Alternate instruction used instead of `instruction` when the caller asks
  // for the draft variant (currently only `pull_request` sets this — see
  // `instructionsFor`'s `prDraft` option).
  draftInstruction?: string;
  // Kept out of `catalog()`, so it never shows up as a checkbox in the New Task
  // modal, while `instructionsFor`/`allowedToolsFor` still honor it for the
  // internal callers that apply it themselves (see `code_review`).
  hidden?: boolean;
  allow?: string[];
}

const ADDONS: Addon[] = [
  {
    id: 'pull_request',
    label: 'Create a Pull Request at the end',
    short: 'Pull Request',
    hint: 'Commit the work and open a PR when the task is finished.',
    icon: 'git-pull-request',
    instruction: [
      'When you have finished the task, commit your changes and open a pull request:',
      '- Stage and commit all changes with a clear, conventional commit message.',
      '- Push the branch to the remote.',
      '- Open a pull request with the `gh` CLI (`gh pr create`) using a descriptive',
      '  title and a body that summarizes what changed and why.',
      '- Report the pull request URL at the end of your response.',
    ].join('\n'),
    draftInstruction: [
      'When you have finished the task, commit your changes and open a pull request:',
      '- Stage and commit all changes with a clear, conventional commit message.',
      '- Push the branch to the remote.',
      '- Open the pull request as a **draft** (`gh pr create --draft`) using a',
      '  descriptive title and a body that summarizes what changed and why — it is',
      '  not ready for review yet, so leave it in draft rather than marking it ready.',
      '- Report the pull request URL at the end of your response.',
    ].join('\n'),
    // Opening a PR needs git commit/push and the `gh` CLI auto-approved.
    allow: [
      'Bash(gh:*)',
      'Bash(git add:*)',
      'Bash(git commit:*)',
      'Bash(git push:*)',
      'Bash(git branch:*)',
      'Bash(git switch:*)',
      'Bash(git checkout:*)',
      'Bash(git status:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
    ],
  },
  {
    id: 'code_review',
    label: 'Always do a code review after finish and fix issues',
    short: 'Self review',
    hint: 'Review your own diff, then fix anything you find before wrapping up.',
    icon: 'search',
    // Not offered as a per-task checkbox any more — the New Task modal is a
    // composer, not a settings sheet, and a self-review is a wrap-up policy
    // rather than a per-prompt decision. It stays defined because the unattended
    // paths still apply it by id: Autonomous Mode's REQUIRED_ADDONS
    // (server/autonomous.ts) and the orchestrator's worker recipe (server/orchestrator.ts).
    hidden: true,
    instruction: [
      'After you believe the task is complete, do a thorough self code review before finishing:',
      '- Review the full diff of your changes for correctness bugs, edge cases,',
      '  security issues, and regressions.',
      '- Check the change matches the surrounding code style and conventions.',
      '- Fix every issue you find, then review again until the diff is clean.',
      '- Summarize the review findings and the fixes you applied.',
    ].join('\n'),
    // Reviewing the diff needs read-only git inspection auto-approved.
    allow: [
      'Bash(git status:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
    ],
  },
];

const byId = new Map(ADDONS.map((a) => [a.id, a]));

// Lightweight catalog for the UI — the full instruction text stays server-side.
// Hidden add-ons are omitted: they're applied programmatically, not chosen.
function catalog(): Array<Pick<Addon, 'id' | 'label' | 'short' | 'hint' | 'icon'>> {
  return ADDONS.filter((a) => !a.hidden)
    .map(({ id, label, short, hint, icon }) => ({ id, label, short, hint, icon }));
}

// Keep only known ids, deduped, in catalog order.
function sanitize(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return ADDONS.filter((a) => ids.includes(a.id)).map((a) => a.id);
}

// The `pull_request` addon's instruction, plus a bullet to self-assign the PR
// when Settings > "Assign to me" is on. Read from `db.settings` at call time
// (not baked into the ADDONS literal) so toggling the setting takes effect on
// the next dispatch without needing to touch the addon selection itself.
function pullRequestInstruction(base: string): string {
  if (!db.settings.assignPrToSelf) return base;
  return `${base}\n- Assign the pull request to yourself: pass \`--assignee @me\` to \`gh pr create\`` +
    ' (or run `gh pr edit <number> --add-assignee @me` if it already exists).';
}

// Build the block of extra instructions appended to a prompt for the given ids.
// `prDraft` swaps the `pull_request` add-on to its draft-PR wording when set.
// Returns '' when nothing is selected so the prompt is left untouched.
function instructionsFor(ids: string[] = [], opts: { prDraft?: boolean } = {}): string {
  const chosen = sanitize(ids).map((i) => byId.get(i)!);
  if (!chosen.length) return '';
  const blocks = chosen.map((a) => {
    if (a.id !== 'pull_request') return `## ${a.label}\n${a.instruction}`;
    const base = opts.prDraft && a.draftInstruction ? a.draftInstruction : a.instruction;
    return `## ${a.label}\n${pullRequestInstruction(base)}`;
  });
  return '\n\n---\n\n# Additional instructions\n\n' + blocks.join('\n\n');
}

// The `--allowedTools` patterns the selected add-ons need auto-approved so their
// instructions can actually run headless. Deduped, in catalog order.
function allowedToolsFor(ids: string[] = []): string[] {
  const chosen = sanitize(ids).map((i) => byId.get(i)!);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of chosen) {
    for (const tool of a.allow || []) {
      if (!seen.has(tool)) {
        seen.add(tool);
        out.push(tool);
      }
    }
  }
  return out;
}

export { ADDONS, catalog, sanitize, instructionsFor, allowedToolsFor };
