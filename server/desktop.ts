/*
 * Desktop hand-offs: reveal a checkout in the OS file manager, or open it in the
 * developer's own IDE.
 *
 * These are the "quick actions" next to the workspace Terminal button — the
 * escape hatches from the board back to the tools the developer already uses.
 * Everything here just launches a local GUI app and forgets about it; nothing is
 * read back, nothing is persisted.
 *
 * Dependency-light by construction: no `which`. We resolve a launcher by
 * scanning PATH (plus JetBrains Toolbox's generated-scripts directory, which
 * is often *not* on a GUI app's PATH) and, on macOS, fall back to `open -a` on
 * the .app bundle so an IDE installed without a CLI launcher still works.
 * Launching itself goes through spawnCompat (server/spawnCompat.ts), which on
 * Windows routes through cmd.exe — required to run `.cmd`/`.bat` launcher
 * scripts (VS Code, JetBrains Toolbox) at all; a no-op passthrough elsewhere.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { baseChildEnv } from './agents/env';
import { spawnCompat } from './spawnCompat';

// A supported editor: how to launch it from a terminal, and where its macOS app
// bundle lives if it has no CLI launcher installed. `bins`/`macApps` are tried in
// order, so a family's variants (Ultimate/Community, Pro/CE) share one entry.
export interface EditorDef {
  id: string;
  label: string;
  bins: string[];
  macApps: string[];
  // Shown when the editor looks installed as an app but has no CLI launcher.
  hint: string;
}

// The board-facing view: the same entry plus whether we can actually launch it.
export interface EditorInfo {
  id: string;
  label: string;
  available: boolean;
  hint: string;
}

const VSCODE_HINT =
  'Open the Command Palette in VS Code and run "Shell Command: Install \'code\' command in PATH".';
const JETBRAINS_HINT =
  'Turn on "Generate Shell Scripts" in JetBrains Toolbox (Settings → Tools), or run Tools → Create Command-line Launcher in the IDE.';

// The catalog. IntelliJ-family launchers are the names JetBrains Toolbox
// generates (`idea`, `webstorm`, …); Toolbox installs its app bundles under
// "JetBrains Toolbox", which is why that directory is searched below.
const EDITORS: EditorDef[] = [
  { id: 'vscode', label: 'Visual Studio Code', bins: ['code'], macApps: ['Visual Studio Code'], hint: VSCODE_HINT },
  {
    id: 'vscode-insiders',
    label: 'VS Code Insiders',
    bins: ['code-insiders'],
    macApps: ['Visual Studio Code - Insiders'],
    hint: VSCODE_HINT,
  },
  {
    id: 'intellij',
    label: 'IntelliJ IDEA',
    bins: ['idea'],
    macApps: ['IntelliJ IDEA', 'IntelliJ IDEA Ultimate', 'IntelliJ IDEA Community Edition', 'IntelliJ IDEA CE'],
    hint: JETBRAINS_HINT,
  },
  { id: 'webstorm', label: 'WebStorm', bins: ['webstorm'], macApps: ['WebStorm'], hint: JETBRAINS_HINT },
  {
    id: 'pycharm',
    label: 'PyCharm',
    bins: ['pycharm'],
    macApps: ['PyCharm', 'PyCharm Professional Edition', 'PyCharm Community Edition', 'PyCharm CE'],
    hint: JETBRAINS_HINT,
  },
  { id: 'goland', label: 'GoLand', bins: ['goland'], macApps: ['GoLand'], hint: JETBRAINS_HINT },
  { id: 'phpstorm', label: 'PhpStorm', bins: ['phpstorm'], macApps: ['PhpStorm'], hint: JETBRAINS_HINT },
  { id: 'rubymine', label: 'RubyMine', bins: ['rubymine'], macApps: ['RubyMine'], hint: JETBRAINS_HINT },
  { id: 'clion', label: 'CLion', bins: ['clion'], macApps: ['CLion'], hint: JETBRAINS_HINT },
  { id: 'rider', label: 'Rider', bins: ['rider'], macApps: ['Rider', 'JetBrains Rider'], hint: JETBRAINS_HINT },
  { id: 'rustrover', label: 'RustRover', bins: ['rustrover'], macApps: ['RustRover'], hint: JETBRAINS_HINT },
  { id: 'fleet', label: 'Fleet', bins: ['fleet'], macApps: ['Fleet', 'JetBrains Fleet'], hint: JETBRAINS_HINT },
  { id: 'android-studio', label: 'Android Studio', bins: ['studio'], macApps: ['Android Studio'], hint: JETBRAINS_HINT },
];

// What to call the OS file manager in the UI, so the button reads "Reveal in
// Finder" on a Mac and "Show in File Explorer" on Windows.
const FILE_MANAGER_LABEL =
  process.platform === 'darwin' ? 'Finder' : process.platform === 'win32' ? 'File Explorer' : 'file manager';

// ---------- launcher discovery ----------

// JetBrains Toolbox writes its `idea`/`webstorm`/… scripts here. A GUI-launched
// app usually doesn't have this on PATH even after resolve-env.ts repairs it, so
// we search it explicitly.
function toolboxScriptDirs(): string[] {
  const home = os.homedir();
  if (process.platform === 'darwin') return [path.join(home, 'Library/Application Support/JetBrains/Toolbox/scripts')];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData/Local');
    return [path.join(local, 'JetBrains/Toolbox/scripts')];
  }
  return [path.join(home, '.local/share/JetBrains/Toolbox/scripts')];
}

function searchDirs(): string[] {
  const fromPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return [...fromPath, ...toolboxScriptDirs()];
}

// Windows launchers are `code.cmd` / `idea.bat`, so try each PATHEXT suffix too.
function binNames(bin: string): string[] {
  if (process.platform !== 'win32') return [bin];
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return [bin, ...exts.map((e) => bin + e.toLowerCase())];
}

function resolveBin(bins: string[]): string | null {
  for (const dir of searchDirs()) {
    for (const bin of bins) {
      for (const name of binNames(bin)) {
        const candidate = path.join(dir, name);
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        } catch { /* next candidate */ }
      }
    }
  }
  return null;
}

function appDirs(): string[] {
  const home = os.homedir();
  return [
    '/Applications',
    '/Applications/JetBrains Toolbox',
    path.join(home, 'Applications'),
    path.join(home, 'Applications/JetBrains Toolbox'),
  ];
}

function resolveMacApp(macApps: string[]): string | null {
  if (process.platform !== 'darwin') return null;
  for (const dir of appDirs()) {
    for (const app of macApps) {
      const bundle = path.join(dir, `${app}.app`);
      if (fs.existsSync(bundle)) return bundle;
    }
  }
  return null;
}

// ---------- detection ----------

// Detection is ~a few hundred stat() calls, so a short cache keeps repeated
// Settings/quick-menu opens free while still noticing an IDE installed mid-session.
let cache: { at: number; list: EditorInfo[] } | null = null;
const CACHE_MS = 15_000;

function detect(force = false): EditorInfo[] {
  const nowMs = Date.now();
  if (!force && cache && nowMs - cache.at < CACHE_MS) return cache.list;
  const list = EDITORS.map((e) => ({
    id: e.id,
    label: e.label,
    hint: e.hint,
    available: !!(resolveBin(e.bins) || resolveMacApp(e.macApps)),
  }));
  cache = { at: nowMs, list };
  return list;
}

// ---------- launching ----------

// Fire-and-forget: the GUI app outlives this call and its output goes nowhere.
// Nested-session markers are stripped (invariant #3) so an IDE's built-in
// terminal doesn't think it's inside a Claude Code session.
function launch(cmd: string, args: string[]): void {
  const child = spawnCompat(cmd, args, {
    detached: true,
    stdio: 'ignore',
    env: baseChildEnv(),
    windowsHide: true,
  });
  child.on('error', (e) => console.error(`[desktop] ${cmd} failed:`, e.message));
  child.unref();
}

// Opens `target` in the OS file manager. Throws only for an unusable path; the
// launch itself is best-effort (the platform command always exists).
function reveal(target: string): void {
  if (process.platform === 'darwin') return launch('open', [target]);
  if (process.platform === 'win32') return launch('explorer', [target]);
  return launch('xdg-open', [target]);
}

// Opens `target` in the given editor. Prefers the CLI launcher (which reuses a
// running window and, for JetBrains, opens the folder as a project); falls back
// to the macOS app bundle. Throws a message worth showing the user when neither
// is there — that's the common case (IDE installed, launcher never generated).
function openInEditor(editorId: string, target: string): void {
  const def = EDITORS.find((e) => e.id === editorId);
  if (!def) throw new Error(`Unknown editor "${editorId}"`);
  const bin = resolveBin(def.bins);
  if (bin) return launch(bin, [target]);
  const app = resolveMacApp(def.macApps);
  if (app) return launch('open', ['-a', app, target]);
  throw new Error(`Can't find ${def.label} on this machine. ${def.hint}`);
}

export { EDITORS, FILE_MANAGER_LABEL, detect, reveal, openInEditor };
