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

// Parse optional YAML frontmatter from the top of a spec file. Deliberately tiny
// and dependency-free — it mirrors the platform's own generate-index.mjs parser:
// a leading `---\n…\n---` block, `key: value` lines, surrounding quotes stripped.
// Never throws: a file with no frontmatter (or a malformed block) just yields {}.
function parseFrontmatter(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const match = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return out;
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim().replace(/^["'](.*)["']$/, '$1');
    out[m[1]] = value;
  }
  return out;
}

// A repo's committed spec-framework config, read from specs/.spec-config.json (or
// the .specs/ equivalent). Lets a repo declare how its index is regenerated and
// which statuses count as actionable, instead of hardcoding either. Absent or
// malformed config just yields {} — the caller falls back to built-in defaults.
interface SpecConfig {
  indexCommand?: string;
  actionableStatuses?: string[];
}

// The default actionable statuses when a repo declares none: freshly-authored or
// in-flight work. (Specs with no status at all are always treated as actionable —
// that's handled by the UI, not this list.)
const DEFAULT_ACTIONABLE_STATUSES = ['draft', 'in-progress', 'partial'];

function readSpecConfig(repoPath: string): SpecConfig {
  for (const root of SPEC_ROOTS) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(repoPath, root, '.spec-config.json'), 'utf8');
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      const config: SpecConfig = {};
      if (typeof parsed.indexCommand === 'string' && parsed.indexCommand.trim()) {
        config.indexCommand = parsed.indexCommand.trim();
      }
      if (Array.isArray(parsed.actionableStatuses)) {
        config.actionableStatuses = parsed.actionableStatuses
          .filter((s: unknown) => typeof s === 'string' && s.trim())
          .map((s: string) => s.trim());
      }
      return config;
    } catch {
      return {};
    }
  }
  return {};
}

// The auto-approvable `--allowedTools` pattern for a repo's index command, so a
// spec-import run can regenerate the index headless (e.g. "node specs/gen.mjs" ->
// "Bash(node:*)"). Returns null when no index command is configured.
function indexCommandTool(config: SpecConfig): string | null {
  if (!config.indexCommand) return null;
  const bin = config.indexCommand.split(/\s+/)[0];
  return bin ? `Bash(${bin}:*)` : null;
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

// Derive a readable title for a spec file, in order of preference: its
// frontmatter `title:`, then its own first `# Heading`, then its filename
// converted from kebab/snake case. `relOrAbsPath` only needs its basename, so
// either a relative or absolute path works.
function deriveTitle(relOrAbsPath: string, content: string): string {
  return (
    parseFrontmatter(content).title ||
    titleFromContent(content) ||
    titleFromFilename(path.basename(relOrAbsPath))
  );
}

// A spec's sequence number: its frontmatter `number:` if present, else a leading
// numeric filename prefix (e.g. "0084-add-auth.md" -> "0084"). Undefined when the
// file has neither, so plain-markdown repos keep their mtime sort.
function deriveNumber(fileName: string, frontmatter: Record<string, string>): string | undefined {
  const fromFm = frontmatter.number?.trim();
  if (fromFm) return fromFm;
  const match = fileName.match(/^(\d+)/);
  return match ? match[1] : undefined;
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
    const frontmatter = parseFrontmatter(content);
    const entry: RepoSpecFile = {
      path: path.relative(repoPath, abs).split(path.sep).join('/'),
      title: deriveTitle(abs, content),
      updatedAt: stat.mtime.toISOString(),
      size: stat.size,
    };
    const number = deriveNumber(path.basename(abs), frontmatter);
    if (number) entry.number = number;
    if (frontmatter.status) entry.status = frontmatter.status;
    if (frontmatter.created) entry.created = frontmatter.created;
    out.push(entry);
  }
  // Frontmatter-driven repos read best ordered by spec number; plain-markdown
  // repos (no numbers anywhere) keep the most-recently-modified-first sort.
  if (out.some((s) => s.number)) {
    out.sort((a, b) => {
      const na = a.number ? parseInt(a.number, 10) : Infinity;
      const nb = b.number ? parseInt(b.number, 10) : Infinity;
      if (na !== nb) return na - nb;
      return a.path.localeCompare(b.path);
    });
  } else {
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return out;
}

// The prompt for a task imported from a spec the run can open itself: point it at
// the file instead of pasting the whole thing in. The spec is committed in the
// repo, so the run reads it from disk at the version it will actually implement —
// and re-reads it as it works, rather than relying on one stale copy frozen into
// the prompt at import time. Callers must only use this when the file is present
// in the run's working directory (see git.isTracked) — otherwise inline the
// content with inlinePrompt below.
//
// Deliberately plain prose with a backticked path rather than a `@file` mention:
// `@` is Claude-CLI-specific, and a task's backend is switchable to Codex after
// import (see CLAUDE.md, "Agent backends"). "Read the spec at `path`" is a plain
// instruction both backends act on with their own Read tool.
function referencePrompt(relPath: string): string {
  return [
    `Read the spec at \`${relPath}\` and implement it.`,
    '',
    'That file is the source of truth for this task. Read it in full first, then read',
    'the parts of the codebase it touches so your work matches the conventions already',
    'there. Follow what the spec decides rather than re-planning it.',
    '',
    'If the spec is ambiguous, or contradicts the code as it actually exists, prefer the',
    'codebase and call the discrepancy out in your summary instead of guessing. If some',
    'of the scope turns out to be unreachable, implement what you can and say plainly',
    'what you left undone and why.',
  ].join('\n');
}

// The prompt for a spec the run *cannot* open: a git-ignored spec dir is never
// checked out into a worktree, so the file's own text has to travel in the prompt.
// The path is still named so the run can refer to it (and so the framing's spec
// completion block lines up).
function inlinePrompt(relPath: string, content: string): string {
  return [
    `Implement the spec below. It comes from \`${relPath}\` in this repo, which is not`,
    'checked into git, so its full text is reproduced here rather than read from disk.',
    '',
    '---',
    '',
    content,
  ].join('\n');
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

export {
  discoverSpecs,
  readSpec,
  referencePrompt,
  inlinePrompt,
  deriveTitle,
  parseFrontmatter,
  readSpecConfig,
  indexCommandTool,
  DEFAULT_ACTIONABLE_STATUSES,
  SPEC_ROOTS,
};
export type { SpecConfig };
