/*
 * "Ask Sr. Popo" — free-form Q&A about a registered repo, answered by a short,
 * read-only Claude session run inside it (see runner.ask). This file owns the
 * two small pieces that make that answer useful:
 *   - `readMemory(repoId)` — the repo's accumulated project memory (see
 *     server/memory.ts), if any exists yet. Missing is a normal, expected
 *     case: the session then answers from repo exploration alone.
 *   - `askPrompt(question, memory)` — the session's instructions.
 */
import * as memory from './memory';

// The repo's accumulated project memory, if one exists yet. Returns null (not
// an error) when there's none — memory is optional context, not a requirement
// to answer a question. memory.readMemory itself never throws, returning ''
// for a missing/unreadable file.
function readMemory(repoId: string): string | null {
  const text = memory.readMemory(repoId).trim();
  return text || null;
}

// The read-only session prompt for a developer's free-form question about a
// repo. Grounded in the repo's accumulated memory when present; the session
// is told to verify it against the code rather than trust it blindly, since
// memory can go stale as the repo changes.
function askPrompt(question: string, memory: string | null): string {
  return [
    "You are answering a developer's question about THIS repository — you are running inside it.",
    'Explore the codebase read-only as needed (read files, grep, check git log/diff/show) to answer',
    'accurately. Do not modify anything.',
    '',
    ...(memory
      ? [
          "Sr. Popo's accumulated memory of this project — treat it as context, and verify it against",
          'the code when it matters, since it may be stale:',
          '"""',
          memory,
          '"""',
          '',
        ]
      : []),
    "The developer's question:",
    '"""',
    question.trim(),
    '"""',
    '',
    'Answer concisely in markdown.',
  ].join('\n');
}

export { readMemory, askPrompt };
