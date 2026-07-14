import { spawn } from 'child_process';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { id } from './store';
import * as runner from './runner';

// In-app shell sessions. Each session is a real interactive shell running on a
// pseudo-terminal so prompts, colors, and full-screen apps (vim, top) work. We
// get the pty from python3's stdlib `pty` module rather than a native module
// like node-pty, keeping the runtime dependency-free (see CLAUDE.md: express is
// the only dep). python3 ships on macOS dev machines (Command Line Tools) and
// virtually all Linux; Windows has no pty here and falls back to a plain pipe.
//
// Sessions are process-local and never persisted — like interactive permission
// prompts, they only make sense while the child is alive. They die with the
// server; the board reconnects to any still-running ones via the stream route.

interface Session {
  id: string;
  cwd: string;
  child: ChildProcessWithoutNullStreams;
  // Recent raw output, base64-encoded per chunk, capped so a reconnecting
  // client can repaint the screen without unbounded memory growth.
  buffer: string[];
  bufferBytes: number;
  listeners: Set<(chunk: string) => void>;
  exited: boolean;
}

const sessions = new Map<string, Session>();
const MAX_BUFFER_BYTES = 256 * 1024;

// Builds the argv that runs the user's login shell on a pty. `stty` sets the
// initial window size before `exec`ing the shell so output wraps correctly; it
// runs before the interactive shell starts, so it prints nothing.
function ptyCommand(shell: string, cols: number, rows: number): { cmd: string; args: string[] } {
  const init = `stty rows ${rows} cols ${cols} 2>/dev/null; exec "${shell}" -il`;
  if (process.platform === 'win32') {
    // No pty without a native module on Windows; run the shell over pipes
    // (degraded: no prompt redraw / full-screen apps). macOS + Linux are the
    // supported targets.
    return { cmd: process.env.COMSPEC || 'cmd.exe', args: [] };
  }
  // python3's stdlib pty allocates a real terminal and relays between our pipes
  // and the pty master; it skips raw mode when our stdin isn't a tty, so it
  // works from the spawned server. No native dependency required.
  const py = "import pty,sys; pty.spawn(['/bin/sh','-c',sys.argv[1]])";
  return { cmd: 'python3', args: ['-c', py, init] };
}

// Spawns a new shell session rooted at `cwd`. Returns its id. Throws if the
// shell process can't be spawned.
function create(cwd: string, cols = 80, rows = 24): string {
  const sid = id();
  const shell = process.env.SHELL || '/bin/bash';
  const { cmd, args } = ptyCommand(shell, cols, rows);
  const child = spawn(cmd, args, {
    cwd,
    // Reuse the task-runner env hardening: strip the API key (so `claude` in
    // the terminal uses the subscription login) and nested-session markers.
    env: { ...runner.childEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  }) as ChildProcessWithoutNullStreams;

  const session: Session = {
    id: sid,
    cwd,
    child,
    buffer: [],
    bufferBytes: 0,
    listeners: new Set(),
    exited: false,
  };
  sessions.set(sid, session);

  const emit = (chunk: Buffer) => {
    const b64 = chunk.toString('base64');
    session.buffer.push(b64);
    session.bufferBytes += b64.length;
    while (session.bufferBytes > MAX_BUFFER_BYTES && session.buffer.length > 1) {
      session.bufferBytes -= session.buffer.shift()!.length;
    }
    for (const fn of session.listeners) fn(b64);
  };
  child.stdout.on('data', emit);
  child.stderr.on('data', emit);
  child.on('exit', () => {
    session.exited = true;
    for (const fn of session.listeners) fn('');
    // Give reconnecting clients a moment to read the buffer, then drop it.
    setTimeout(() => sessions.delete(sid), 60_000);
  });
  child.on('error', () => {
    session.exited = true;
    for (const fn of session.listeners) fn('');
    sessions.delete(sid);
  });

  return sid;
}

function get(sid: string): Session | undefined {
  return sessions.get(sid);
}

// Subscribes to a session's output. Immediately replays the buffered output so
// a fresh or reconnecting client repaints the current screen, then streams live
// chunks. Returns an unsubscribe function.
function attach(sid: string, onChunk: (b64: string) => void): (() => void) | null {
  const s = sessions.get(sid);
  if (!s) return null;
  for (const b64 of s.buffer) onChunk(b64);
  s.listeners.add(onChunk);
  return () => s.listeners.delete(onChunk);
}

function write(sid: string, data: string): boolean {
  const s = sessions.get(sid);
  if (!s || s.exited) return false;
  s.child.stdin.write(data);
  return true;
}

// Best-effort live resize. Without a native pty we can't ioctl the window size
// directly, so we push an `stty` through the shell. It runs at the prompt and
// its (empty) output is harmless; running full-screen apps won't see it.
function resize(sid: string, cols: number, rows: number): boolean {
  const s = sessions.get(sid);
  if (!s || s.exited) return false;
  s.child.stdin.write(`stty rows ${rows} cols ${cols} 2>/dev/null\n`);
  return true;
}

function close(sid: string): void {
  const s = sessions.get(sid);
  if (!s) return;
  s.exited = true;
  s.child.kill('SIGKILL');
  sessions.delete(sid);
}

function closeAll(): void {
  for (const sid of [...sessions.keys()]) close(sid);
}

export { create, get, attach, write, resize, close, closeAll };
