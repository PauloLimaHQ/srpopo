/*
 * Repository Specs — discover and read the markdown spec files a repo already
 * has committed under a top-level specs/ or .specs/ directory, so one or more
 * can be imported straight onto the board as a task (see server/plugins.ts's
 * repo-specs entry). Small, self-contained, and non-throwing in the same mold
 * as linear.ts: a missing or unreadable directory just yields no results
 * rather than an error, and every export resolves rather than throws.
 */
import fs from 'fs';
import path from 'path';
import type { RepoSpecFile } from './types';

// Both roots are scanned; either or both may be absent.
const SPEC_ROOTS = ['specs', '.specs'];
// Bounds the recursive walk so a pathological tree (or a symlink loop) can't
// hang discovery — a spec dir with per-idea subfolders (`.specs/<slug>/spec.md`)
// only needs a couple of levels.
const MAX_DEPTH = 4;
const SPEC_EXT_RE = /\.(md|markdown)$/i;
// Skips node_modules and any dot-directory (.git, .github, …) while walking
// *into* subdirectories — the spec root itself (.specs) is exempt since we're
// handed its path directly, not discovering it by name.
const SKIP_DIR_RE = /^(node_modules|\..*)$/;

// Recursively collect markdown files under `dir` (bounded by MAX_DEPTH) into
// `out`. Never throws — a missing/unreadable directory just contributes nothing.
function walk(dir: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_RE.test(entry.name)) continue;
      walk(full, depth + 1, out);
    } else if (entry.isFile() && SPEC_EXT_RE.test(entry.name)) {
      out.push(full);
    }
  }
}

// Title-case a kebab/snake-case filename stem: "my-cool-idea" -> "My Cool Idea".
function titleFromFilename(fileName: string): string {
  const stem = fileName.replace(SPEC_EXT_RE, '');
  const spaced = stem.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const title = spaced.replace(/\b\w/g, (c) => c.toUpperCase());
  return title || stem;
}

// The file's own first `# Heading` line, if present.
function titleFromContent(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

// Derive a readable title for a spec file: its own first heading, else its
// filename converted from kebab/snake case. `relOrAbsPath` only needs its
// basename, so either a relative or absolute path works.
function deriveTitle(relOrAbsPath: string, content: string): string {
  return titleFromContent(content) || titleFromFilename(path.basename(relOrAbsPath));
}

// All markdown spec files under <repoPath>/specs/ and <repoPath>/.specs/,
// sorted most-recently-modified first. Never throws — an absent or unreadable
// root just contributes no entries for that root.
function discoverSpecs(repoPath: string): RepoSpecFile[] {
  const files: string[] = [];
  for (const root of SPEC_ROOTS) walk(path.join(repoPath, root), 0, files);

  const out: RepoSpecFile[] = [];
  for (const abs of files) {
    let stat: fs.Stats;
    let content: string;
    try {
      stat = fs.statSync(abs);
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    out.push({
      path: path.relative(repoPath, abs).split(path.sep).join('/'),
      title: deriveTitle(abs, content),
      updatedAt: stat.mtime.toISOString(),
      size: stat.size,
    });
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

type ReadResult = { ok: true; content: string } | { ok: false; reason: 'not-found' | 'invalid-path' | 'error' };

// Read one spec file's content by its path relative to repoPath (as returned
// by discoverSpecs). `relPath` is client-supplied, so it's treated like user
// input: rejects an absolute path, anything that resolves outside repoPath, or
// anything landing outside the two spec roots (traversal via `../` included).
function readSpec(repoPath: string, relPath: string): ReadResult {
  const raw = String(relPath || '');
  if (!raw || path.isAbsolute(raw)) return { ok: false, reason: 'invalid-path' };
  if (!SPEC_EXT_RE.test(raw)) return { ok: false, reason: 'invalid-path' };

  const repoAbs = path.resolve(repoPath);
  const target = path.resolve(repoAbs, raw);
  const withinSpecRoot = SPEC_ROOTS.some((root) => {
    const rootAbs = path.resolve(repoAbs, root) + path.sep;
    return target.startsWith(rootAbs);
  });
  if (!withinSpecRoot) return { ok: false, reason: 'invalid-path' };

  try {
    if (!fs.statSync(target).isFile()) return { ok: false, reason: 'not-found' };
    return { ok: true, content: fs.readFileSync(target, 'utf8') };
  } catch (e) {
    return { ok: false, reason: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'error' };
  }
}

export { discoverSpecs, readSpec, deriveTitle, SPEC_ROOTS };
