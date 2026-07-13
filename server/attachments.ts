/*
 * Per-task file attachments. Uploaded bytes live under
 * DATA_DIR/attachments/<taskId>/<sanitizedName> — never inside the repo or the
 * git worktree (which may not exist yet, and which we must not pollute). At
 * dispatch the runner injects each file's absolute path into the prompt so the
 * `claude` session can Read it. Metadata (the Attachment[] on a task) is still
 * persisted through store.save(); this module only owns the bytes on disk.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './store';

const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');

// The per-task directory holding a task's uploaded files.
function attachmentsDir(taskId: string): string {
  return path.join(ATTACHMENTS_DIR, taskId);
}

// Reduce an incoming filename to a safe basename: strip any directory parts,
// drop leading dots (so nothing hides or escapes), and neutralize the rest.
// Security-critical — this is the only guard keeping writes inside the task dir.
function sanitizeName(name: unknown): string {
  const base = path.basename(String(name || '')).replace(/^\.+/, '');
  const cleaned = base.replace(/[/\\]/g, '').trim();
  return cleaned || 'file';
}

// Pick a name that doesn't clash with an existing file in the task dir, by
// suffixing " (2)", " (3)", … before the extension. Never overwrites.
function uniqueName(taskId: string, name: string): string {
  const dir = attachmentsDir(taskId);
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}

// Write bytes for a task under a sanitized, collision-free name; returns the
// stored name and its size so the caller can record an Attachment entry.
function write(taskId: string, rawName: unknown, bytes: Buffer): { name: string; size: number } {
  const dir = attachmentsDir(taskId);
  fs.mkdirSync(dir, { recursive: true });
  const name = uniqueName(taskId, sanitizeName(rawName));
  fs.writeFileSync(path.join(dir, name), bytes);
  return { name, size: bytes.length };
}

// Remove a single attachment file. The name is re-sanitized so a hostile
// :name param can't reach outside the task dir. Missing file is a no-op.
function remove(taskId: string, rawName: unknown): void {
  const name = sanitizeName(rawName);
  fs.rmSync(path.join(attachmentsDir(taskId), name), { force: true });
}

// Remove a task's whole attachment dir (called when the task is deleted).
function removeDir(taskId: string): void {
  fs.rmSync(attachmentsDir(taskId), { recursive: true, force: true });
}

// Absolute paths of a task's attachments, in the given metadata order. Used by
// dispatch to list the files for Claude; skips any that no longer exist on disk.
function listPaths(taskId: string, names: string[]): string[] {
  const dir = attachmentsDir(taskId);
  return names
    .map((n) => path.join(dir, sanitizeName(n)))
    .filter((p) => fs.existsSync(p));
}

export { attachmentsDir, sanitizeName, write, remove, removeDir, listPaths };
