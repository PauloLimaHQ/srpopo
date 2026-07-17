/*
 * Project memory — a private, per-repo markdown document of durable learnings
 * (conventions, architecture, decisions, gotchas) that Sr. Popo builds up over
 * time. It lives only in Sr. Popo's own data dir (never inside the user's
 * repository), is distilled in the background after each task that finishes
 * successfully (see runner.distillMemory), is viewable/editable by the user
 * (GET/PUT /api/repos/:id/memory), and is injected into grooming sessions so
 * specs get project context (see groomer.metaPrompt).
 *
 * This module is the single source of truth for the distillation flow's moving
 * parts — the meta-prompt (`distillPrompt`) and the sentinel parser
 * (`parseDistillResult`) — mirroring how server/groomer.ts owns idea grooming.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './store';
import type { Task } from './types';

const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const MAX_BYTES = 64 * 1024;

// A cheap, fixed model for background distillation — this is a small
// summarization task, not one that needs a frontier model. A constant (rather
// than a setting) so it's easy to revisit later without a migration.
const MEMORY_MODEL = 'haiku';

const MEMORY_START = '@@SRPOPO_MEMORY_START@@';
const MEMORY_END = '@@SRPOPO_MEMORY_END@@';
const NO_CHANGES = 'NO_CHANGES';

function memoryPath(repoId: string): string {
  return path.join(MEMORY_DIR, `${repoId}.md`);
}

function readMemory(repoId: string): string {
  try {
    return fs.readFileSync(memoryPath(repoId), 'utf8');
  } catch {
    return '';
  }
}

// The board-facing view: content plus the file's last-modified time (null when
// there's no memory yet). A single stat+read so the REST route doesn't need to
// know the on-disk shape.
function memoryInfo(repoId: string): { content: string; updatedAt: string | null } {
  const p = memoryPath(repoId);
  try {
    const stat = fs.statSync(p);
    return { content: fs.readFileSync(p, 'utf8'), updatedAt: stat.mtime.toISOString() };
  } catch {
    return { content: '', updatedAt: null };
  }
}

// Persist the memory document. Hard-capped so a runaway distillation (or a
// pasted-in edit) can't grow this file without bound; atomic like store.save()
// (temp file + rename) so a reader never sees a half-written file.
function writeMemory(repoId: string, content: string): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const p = memoryPath(repoId);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, content.slice(0, MAX_BYTES));
  fs.renameSync(tmp, p);
}

// Best-effort delete, called when a repo is removed from the board.
function removeMemory(repoId: string): void {
  try { fs.rmSync(memoryPath(repoId), { force: true }); } catch { /* best effort */ }
}

// The brief handed to the read-only distillation session: the memory document
// so far and the task that just finished, asking it to inspect the diff/log
// (via the read-only git tools) and emit the complete updated document — or
// NO_CHANGES — between sentinels so the result can be recovered verbatim.
function distillPrompt(memory: string, task: Pick<Task, 'title' | 'prompt' | 'lastOutcome'>): string {
  return [
    'You are maintaining a private, per-project memory document for a coding-agent orchestrator that just',
    'finished a task in this repository. The document records durable, project-level learnings — coding',
    'conventions, architecture facts, decisions and their rationale, gotchas — so future agent sessions here',
    'start with useful context. It is NOT a changelog, a task log, or a place for one-off task details.',
    '',
    'Current memory document (empty if none yet):',
    '"""',
    memory.trim() || '(empty)',
    '"""',
    '',
    'The task that just finished:',
    `Title: ${task.title}`,
    `Outcome: ${task.lastOutcome || 'unknown'}`,
    'Prompt given to the agent:',
    '"""',
    (task.prompt || '').trim(),
    '"""',
    '',
    'Inspect what actually changed with the read-only tools available to you (git log/diff/show, reading',
    'files) and decide whether this run taught anything durable and project-level worth remembering. Most',
    'runs teach nothing new — that is fine and expected.',
    '',
    'If there is something durable to record, output the COMPLETE updated memory document between the',
    'markers below: merge the new learning into the existing document (rewrite sections as needed) rather',
    'than appending forever. Keep it compact (aim for under ~6 KB) and organized under stable headings such',
    'as `## Conventions`, `## Architecture`, `## Decisions`, and `## Gotchas`. Never record secrets,',
    'credentials, or task minutiae.',
    '',
    'If nothing durable was learned, output exactly the token NO_CHANGES between the markers instead — do',
    'not rewrite the document just to rephrase it.',
    '',
    'Emit exactly one of the two between the markers below, and NOTHING after it:',
    MEMORY_START,
    '<the complete updated markdown document, or NO_CHANGES>',
    MEMORY_END,
  ].join('\n');
}

// Recover the session's final answer: the updated document, or null when the
// session answered NO_CHANGES, produced no parseable sentinel span, or the
// session failed outright (callers pass '' in that case). A null return means
// "leave the memory file untouched".
function parseDistillResult(text: unknown): string | null {
  if (typeof text !== 'string' || !text) return null;
  const start = text.lastIndexOf(MEMORY_START);
  const end = text.lastIndexOf(MEMORY_END);
  if (start === -1 || end <= start) return null;
  const span = text.slice(start + MEMORY_START.length, end).trim();
  if (!span || span === NO_CHANGES) return null;
  return span;
}

export {
  memoryPath,
  readMemory,
  memoryInfo,
  writeMemory,
  removeMemory,
  distillPrompt,
  parseDistillResult,
  MEMORY_MODEL,
  MEMORY_START,
  MEMORY_END,
};
