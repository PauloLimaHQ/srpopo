/*
 * Package scripts — the repo's own `package.json` scripts, offered as a Run
 * button next to the board.
 *
 * Sr. Popo is an ops surface for a checkout, not just a task queue: half of
 * "does this work?" is starting the thing. This module reads a checkout's
 * manifest and answers two questions — which scripts exist, and what command
 * runs one on this project's package manager (npm / pnpm / yarn / bun, picked
 * from the manifest's `packageManager` field or the lockfile on disk).
 *
 * It never runs anything itself. The board sends a script *name*; `commandFor`
 * looks it up in the manifest and returns the command line, and the caller
 * types that into an in-app terminal session (server/terminal.ts) — so a run is
 * a shell you can watch, interrupt and re-run, exactly like typing it yourself,
 * and an arbitrary command from the client can never become a spawn.
 *
 * Read-only and dependency-free: one `fs.readFileSync` per call, no cache to go
 * stale when the developer edits package.json mid-session.
 */

import fs from 'fs';
import path from 'path';

type Manager = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface ScriptEntry {
  name: string;
  command: string;
}

// What the board gets: null `manager` means "no package.json here", which is
// what hides the Run button for a non-Node checkout.
interface Manifest {
  manager: Manager | null;
  scripts: ScriptEntry[];
  // The script a bare click on Run should start, if the project has one.
  primary: string | null;
}

// A manifest with hundreds of scripts is a monorepo root, not a menu. Cap the
// list so the UI stays a menu and the response stays small.
const MAX_SCRIPTS = 60;
// A package.json this big isn't one we can usefully read.
const MAX_BYTES = 2 * 1024 * 1024;

// What "start the project" means, in preference order. First one present wins.
const PRIMARY_ORDER = ['dev', 'start', 'serve', 'develop'];

// Lockfile → the manager that wrote it, checked in this order so a repo that
// has both a pnpm lockfile and a stale package-lock.json resolves to pnpm.
const LOCKFILES: Array<[string, Manager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

function isManager(v: unknown): v is Manager {
  return v === 'npm' || v === 'pnpm' || v === 'yarn' || v === 'bun';
}

// Corepack's `"packageManager": "pnpm@9.1.0"` is the project's own declaration,
// so it beats whatever lockfiles happen to be lying around.
function declaredManager(pkg: Record<string, unknown>): Manager | null {
  const raw = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0].trim() : '';
  return isManager(raw) ? raw : null;
}

function lockfileManager(cwd: string): Manager | null {
  for (const [file, manager] of LOCKFILES) {
    if (fs.existsSync(path.join(cwd, file))) return manager;
  }
  return null;
}

// Reads the checkout's scripts. Any unreadable/unparsable manifest degrades to
// "no scripts here" rather than throwing — the Run button simply stays hidden.
function read(cwd: string): Manifest {
  const empty: Manifest = { manager: null, scripts: [], primary: null };
  const file = path.join(cwd, 'package.json');
  let pkg: Record<string, unknown>;
  try {
    if (fs.statSync(file).size > MAX_BYTES) return empty;
    pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return empty;
  }
  if (!pkg || typeof pkg !== 'object') return empty;
  const raw = pkg.scripts;
  if (!raw || typeof raw !== 'object') return empty;

  const scripts: ScriptEntry[] = Object.entries(raw as Record<string, unknown>)
    .filter(([name, command]) => name && typeof command === 'string')
    .slice(0, MAX_SCRIPTS)
    .map(([name, command]) => ({ name, command: command as string }));

  const manager = declaredManager(pkg) || lockfileManager(cwd) || 'npm';
  const primary = PRIMARY_ORDER.find((n) => scripts.some((s) => s.name === n)) || null;
  return { manager, scripts, primary };
}

// The command is typed into a shell, so quote a script name that isn't already
// a plain word. Same rule server/terminal.ts uses for paths: the common case
// should read like the command the developer would have typed themselves.
function shQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// The command line that runs `name` on this checkout, or null when the script
// isn't in the manifest — the only thing standing between a request body and a
// shell, so it is a lookup, never a passthrough.
function commandFor(manifest: Manifest, name: unknown): string | null {
  if (typeof name !== 'string' || !manifest.manager) return null;
  if (!manifest.scripts.some((s) => s.name === name)) return null;
  // `yarn run x` works too, but `yarn x` is what a Yarn project's README says.
  const verb = manifest.manager === 'yarn' ? '' : 'run ';
  return `${manifest.manager} ${verb}${shQuote(name)}`;
}

export { commandFor, read };
export type { Manager, Manifest, ScriptEntry };
