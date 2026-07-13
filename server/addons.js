/*
 * Task add-ons — optional behaviors the user can toggle when creating a task.
 *
 * This file is the single source of truth. Each entry drives both:
 *   - the checkbox rendered in the New/Edit Task modal (via GET /api/addons), and
 *   - the extra instructions injected into the prompt at dispatch time.
 *
 * To add a new behavior later, just append an entry below — nothing else needs
 * to change. `instruction` is prompt text appended to the task prompt when the
 * add-on is selected; keep it a clear, standalone directive to Claude.
 */
const ADDONS = [
  {
    id: 'pull_request',
    label: 'Create a Pull Request at the end',
    hint: 'Commit the work and open a PR when the task is finished.',
    instruction: [
      'When you have finished the task, commit your changes and open a pull request:',
      '- Stage and commit all changes with a clear, conventional commit message.',
      '- Push the branch to the remote.',
      '- Open a pull request with the `gh` CLI (`gh pr create`) using a descriptive',
      '  title and a body that summarizes what changed and why.',
      '- Report the pull request URL at the end of your response.',
    ].join('\n'),
  },
  {
    id: 'code_review',
    label: 'Always do a code review after finish and fix issues',
    hint: 'Review your own diff, then fix anything you find before wrapping up.',
    instruction: [
      'After you believe the task is complete, do a thorough self code review before finishing:',
      '- Review the full diff of your changes for correctness bugs, edge cases,',
      '  security issues, and regressions.',
      '- Check the change matches the surrounding code style and conventions.',
      '- Fix every issue you find, then review again until the diff is clean.',
      '- Summarize the review findings and the fixes you applied.',
    ].join('\n'),
  },
];

const byId = new Map(ADDONS.map((a) => [a.id, a]));

// Lightweight catalog for the UI — the full instruction text stays server-side.
function catalog() {
  return ADDONS.map(({ id, label, hint }) => ({ id, label, hint }));
}

// Keep only known ids, deduped, in catalog order.
function sanitize(ids) {
  if (!Array.isArray(ids)) return [];
  return ADDONS.filter((a) => ids.includes(a.id)).map((a) => a.id);
}

// Build the block of extra instructions appended to a prompt for the given ids.
// Returns '' when nothing is selected so the prompt is left untouched.
function instructionsFor(ids = []) {
  const chosen = sanitize(ids).map((i) => byId.get(i));
  if (!chosen.length) return '';
  const blocks = chosen.map((a) => `## ${a.label}\n${a.instruction}`);
  return '\n\n---\n\n# Additional instructions\n\n' + blocks.join('\n\n');
}

module.exports = { ADDONS, catalog, sanitize, instructionsFor };
