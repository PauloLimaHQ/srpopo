import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A macOS/Linux GUI app launched from Finder/Dock/DMG does NOT inherit the
// user's shell PATH — launchd hands it a minimal `/usr/bin:/bin:/usr/sbin:/sbin`.
// The `claude` CLI almost always lives outside that (the native installer puts it
// in ~/.local/bin), so a packaged run can't find it even though it works fine when
// launched from a terminal. This module repairs the environment BEFORE the server
// module is required — it (a) merges the login shell's PATH into process.env.PATH
// and (b) pins CLAUDE_BIN to an absolute path when it can locate the binary — so
// both the health check and every task spawn resolve `claude` the same way the
// user's terminal does. It never throws: a failure here must not block app boot.

// Common install locations for the `claude` CLI, in priority order. Relative to
// $HOME so they resolve per-user. Kept in sync with where the native installer,
// the legacy local install, Homebrew, and npm-global place the binary.
function knownClaudeCandidates(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.local', 'bin', 'claude'), // native installer (default)
    path.join(home, '.claude', 'local', 'claude'), // legacy local install
    '/opt/homebrew/bin/claude', // Homebrew (Apple Silicon)
    '/usr/local/bin/claude', // Homebrew (Intel) / manual
    path.join(home, '.npm-global', 'bin', 'claude'), // npm -g with custom prefix
    path.join(home, 'Library', 'pnpm', 'claude'), // pnpm global (macOS)
  ];
}

// Extra directories worth having on PATH even if the shell probe fails — the
// same install locations as above, minus the binary name.
function extraPathDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, 'Library', 'pnpm'),
  ];
}

// Ask the user's login shell for its PATH. This picks up whatever .zprofile /
// .zlogin / .bash_profile export, which is where PATH belongs and what a
// terminal-launched run would see. Guarded to Unix — Windows GUI apps inherit a
// usable PATH already.
//
// NOTE: we deliberately use a login (`-l`) but NOT interactive (`-i`) shell. An
// interactive shell sources .zshrc, which on real setups loads frameworks like
// oh-my-zsh plus async plugins (zsh-autosuggestions, fast-syntax-highlighting)
// that fork background workers inheriting our stdout pipe. That pipe then never
// reaches EOF, so execFileSync HANGS INDEFINITELY — past its own `timeout`, which
// can't reclaim a grandchild holding the fd — and wedges app boot (this runs at
// the very first synchronous step of electron/main.ts). A non-interactive login
// shell returns in well under a second; PATH additions that live only in .zshrc
// are still covered by extraPathDirs() and the direct CLAUDE_BIN probe below.
function loginShellPath(): string | null {
  if (process.platform === 'win32') return null;
  const shellBin = process.env.SHELL || '/bin/zsh';
  const marker = '__SRPOPO_PATH__';
  try {
    // -l => login shell, so profile files load. A sentinel marker lets us extract
    // PATH cleanly even if the shell prints other noise.
    const out = execFileSync(shellBin, ['-lc', `printf '${marker}=%s\\n' "$PATH"`], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = out.split('\n').find((l) => l.startsWith(`${marker}=`));
    const value = line ? line.slice(marker.length + 1).trim() : '';
    return value || null;
  } catch {
    return null;
  }
}

// Merge dirs into PATH without duplicates, preserving order (existing entries first).
function mergePath(current: string, additions: string[]): string {
  const sep = path.delimiter;
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of [...current.split(sep), ...additions]) {
    const d = dir.trim();
    if (d && !seen.has(d)) {
      seen.add(d);
      merged.push(d);
    }
  }
  return merged.join(sep);
}

// Repair process.env.PATH and pin CLAUDE_BIN to an absolute path when we can find
// the binary. Safe to call once at startup, before the server module is required
// (runner.ts reads CLAUDE_BIN at import time).
export function resolveClaudeEnv(): void {
  try {
    // 1) Rebuild PATH from the login shell (falls back to the current PATH) plus
    //    the well-known install dirs, so `claude` resolves like it does in a terminal.
    const base = loginShellPath() || process.env.PATH || '';
    process.env.PATH = mergePath(base, extraPathDirs());

    // 2) If the user hasn't pinned CLAUDE_BIN, probe the known locations and set it
    //    to the first existing absolute path. This makes the app robust even when
    //    the shell probe fails (e.g. a non-standard shell) and PATH is still thin.
    if (!process.env.CLAUDE_BIN) {
      for (const candidate of knownClaudeCandidates()) {
        try {
          if (fs.existsSync(candidate)) {
            process.env.CLAUDE_BIN = candidate;
            break;
          }
        } catch {
          // ignore a bad candidate and keep probing
        }
      }
    }
  } catch {
    // Never let env repair block app boot — if it fails we just fall back to the
    // inherited PATH and a bare `claude`, which is the pre-fix behavior.
  }
}
