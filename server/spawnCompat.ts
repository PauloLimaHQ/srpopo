/*
 * Cross-platform-safe process spawning for launching another program by name.
 *
 * On Windows, `child_process.spawn()` cannot directly execute `.cmd`/`.bat`
 * files — CreateProcess needs a real PE image, not a batch script — and every
 * npm-installed CLI we launch (`claude`, `codex`, `grok`, plus editor
 * launchers like `code`/`idea`) ships as exactly that on Windows. So a bare
 * `spawn('claude', [...])` fails there even though `claude` runs fine from a
 * terminal (the terminal's own cmd.exe/PowerShell does the `.cmd` resolution
 * `CreateProcess` won't). This is Node's documented limitation, independent of
 * whether the binary is on PATH.
 *
 * The fix mirrors what the `cross-spawn` package does (kept here instead of
 * taken as a dependency — see CLAUDE.md "keep runtime dependencies minimal"):
 * run the command through `cmd.exe /d /s /c` ourselves, with the binary name
 * and every argument escaped for BOTH layers of parsing it goes through — the
 * C-runtime argv convention (backslash-before-quote doubling) the target
 * program's own argv parser expects, and cmd.exe's own metacharacter grammar
 * (&, |, <, >, ^, %, ", parens — all interpreted by cmd.exe even inside a
 * quoted token) — so nothing in a value we didn't fully control (a task's
 * free-text --allowedTools pattern, an install path with spaces or parens like
 * "Program Files (x86)") can break the invocation or run as its own command.
 * Algorithm reference: https://qntm.org/cmd.
 *
 * On macOS/Linux this is a plain passthrough to `spawn()` — argv there is
 * never shell-interpreted, so there is nothing to escape.
 */
import { spawn } from 'child_process';
import type { ChildProcess, SpawnOptions } from 'child_process';

// Escape one token (the binary name or one argument) so it survives cmd.exe's
// parser intact and is handed to the target program as a single argv entry.
function winEscapeArg(value: string): string {
  let arg = String(value);
  // C-runtime argv rule: a run of backslashes immediately before a literal `"`
  // (or at the very end, right before the closing quote we're about to add)
  // must be doubled, and the `"` itself backslash-escaped — otherwise the
  // target program's own argv parser splits the value in the wrong place.
  // Backslashes anywhere else (e.g. ordinary path separators) are untouched.
  arg = arg.replace(/(\\*)("|$)/g, (_m, backslashes: string, end: string) => {
    const doubled = backslashes + backslashes;
    return end === '"' ? `${doubled}\\"` : doubled;
  });
  arg = `"${arg}"`;
  // cmd.exe treats these as metacharacters even inside a quoted token; a
  // leading `^` tells cmd.exe to pass the next character through literally.
  arg = arg.replace(/[()%!^"<>&|]/g, '^$&');
  return arg;
}

// The full string handed to `cmd.exe /d /s /c` — one more layer of quoting
// around the whole escaped command, matching the `/d /s /c "..."` shape
// Node's own (unescaped) shell:true implementation uses internally on Windows.
function winCommandLine(bin: string, args: string[]): string {
  return `"${[bin, ...args].map(winEscapeArg).join(' ')}"`;
}

// Drop-in replacement for `child_process.spawn` that also works when `bin`
// resolves to a `.cmd`/`.bat` shim on Windows. Identical to `spawn()` on
// macOS/Linux.
function spawnCompat(bin: string, args: string[], options: SpawnOptions): ChildProcess {
  if (process.platform !== 'win32') return spawn(bin, args, options);
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', winCommandLine(bin, args)], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

export { spawnCompat, winEscapeArg, winCommandLine };
