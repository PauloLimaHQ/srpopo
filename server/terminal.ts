import { spawn } from 'child_process';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import type { Writable } from 'stream';
import * as bus from './bus';
import { id } from './store';
import * as runner from './runner';

// In-app shell sessions. Each session is a real interactive shell running on a
// pseudo-terminal so prompts, colors, and full-screen apps (vim, top) work. We
// get the pty from python3's stdlib `pty` module rather than a native module
// like node-pty, keeping the runtime dependency-free (see CLAUDE.md: express is
// the only dep). python3 ships on macOS dev machines (Command Line Tools) and
// virtually all Linux; Windows has no pty here and falls back to a plain pipe.
//
// A session can boot straight into an agent CLI (`kind`) or into a command
// (`command`, e.g. the `npm run dev` behind the workspace's Run button): the
// shell starts as usual and the line is typed into it, so quitting `claude` —
// or Ctrl-C'ing the dev server — leaves you at a live prompt instead of killing
// the tab.
//
// Sessions are process-local and never persisted — like interactive permission
// prompts, they only make sense while this server is up. They die with it; the
// board lists the survivors via GET /api/terminal/sessions and reattaches to
// each one's output with the stream route.

type Kind = 'shell' | 'claude' | 'codex' | 'grok';
// active = alive and printing; idle = alive but quiet (sitting at a prompt,
// waiting for you); exited = the process is gone. The board renders them as a
// green / amber / red bullet.
type Status = 'active' | 'idle' | 'exited';

interface Session {
  id: string;
  repoId: string;
  cwd: string;
  kind: Kind;
  label: string;
  // The label before its "2"/"3" suffix, so a second session of the same sort
  // in the same repo can be numbered without re-deriving where it came from.
  base: string;
  // The line typed at the fresh prompt for a command session (a package
  // script), else undefined. Kept so the board can label and re-run it.
  command?: string;
  child: ChildProcessWithoutNullStreams;
  // The relay's resize channel (fd 3); null on Windows, which has no pty here.
  control: Writable | null;
  // Recent raw output, base64-encoded per chunk, capped so a reconnecting
  // client can repaint the screen without unbounded memory growth.
  buffer: string[];
  bufferBytes: number;
  listeners: Set<(chunk: string) => void>;
  exited: boolean;
  createdAt: string;
  lastActivity: number;
  // The status last broadcast, so the sweep below only emits real transitions.
  status: Status;
}

interface Summary {
  id: string;
  repoId: string;
  cwd: string;
  kind: Kind;
  label: string;
  command?: string;
  status: Status;
  createdAt: string;
}

const sessions = new Map<string, Session>();
const MAX_BUFFER_BYTES = 256 * 1024;
// Quiet for this long and a live session is "idle" rather than "active".
const IDLE_MS = 30_000;
// How often the sweep re-grades every session (only transitions broadcast).
const SWEEP_MS = 5_000;
// Exited sessions stay listed — a red tab you can still scroll back through —
// until dismissed. Cap how many we hold so a long day doesn't grow forever.
const MAX_EXITED = 20;

const KIND_LABEL: Record<Kind, string> = {
  shell: 'Shell', claude: 'Claude', codex: 'Codex', grok: 'Grok',
};

function isKind(v: unknown): v is Kind {
  return v === 'shell' || v === 'claude' || v === 'codex' || v === 'grok';
}

// The binary a non-shell session types at its prompt. Uses the same resolved
// bin names the runner spawns tasks with, so a custom CLI path works here too.
function launchBin(kind: Kind): string | null {
  if (kind === 'claude') return runner.CLAUDE_BIN;
  if (kind === 'codex') return runner.CODEX_BIN;
  if (kind === 'grok') return runner.GROK_BIN;
  return null;
}

// The shell echoes what we type at its prompt, so quote only when the path
// actually needs it — the common case should read like the command the user
// would have typed themselves.
function shQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function statusOf(s: Session): Status {
  if (s.exited) return 'exited';
  return Date.now() - s.lastActivity > IDLE_MS ? 'idle' : 'active';
}

function summary(s: Session): Summary {
  return {
    id: s.id, repoId: s.repoId, cwd: s.cwd, kind: s.kind,
    label: s.label, command: s.command, status: statusOf(s), createdAt: s.createdAt,
  };
}

function announce(s: Session): void {
  s.status = statusOf(s);
  bus.broadcast({ type: 'terminal', session: summary(s) });
}

// One timer for all sessions, running only while there are any. It exists to
// turn "went quiet" into an event — every other transition is broadcast by the
// code that causes it.
let sweep: NodeJS.Timeout | null = null;
function syncSweep(): void {
  if (sessions.size && !sweep) {
    sweep = setInterval(() => {
      for (const s of sessions.values()) if (statusOf(s) !== s.status) announce(s);
    }, SWEEP_MS);
    sweep.unref();
  } else if (!sessions.size && sweep) {
    clearInterval(sweep);
    sweep = null;
  }
}

// The relay that gives a session its pseudo-terminal: python3's stdlib `pty`
// allocates a real one and this loop shuttles bytes between our pipes and the
// pty master. No native module, so no runtime dependency (see CLAUDE.md).
//
// It is a hand-rolled loop rather than `pty.spawn` for one reason: **fd 3 is a
// resize channel**. Writing `"<cols> <rows>\n"` to it runs a real TIOCSWINSZ
// ioctl on the master, which is the only thing that makes the kernel raise
// SIGWINCH in the shell — so a full-screen app (claude's TUI, vim, top)
// actually re-lays-out when the panel is dragged. Pushing an `stty` through
// stdin, the obvious alternative, only works at a bare prompt and echoes the
// command across the screen every time.
const PTY_RELAY = `
import os, pty, sys, select, struct, fcntl, termios
shell, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
pid, fd = pty.fork()
if pid == 0:
    try:
        os.execvp(shell, [shell, '-il'])
    except Exception:
        os._exit(127)
def winsz(c, r):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
    except OSError:
        pass
winsz(cols, rows)
CTRL = 3
watch = [fd, 0, CTRL]
buf = b''
while True:
    try:
        readable, _, _ = select.select(watch, [], [])
    except (OSError, ValueError):
        break
    if fd in readable:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b''
        if not data:
            break
        os.write(1, data)
    if 0 in readable:
        try:
            data = os.read(0, 65536)
        except OSError:
            data = b''
        if data:
            os.write(fd, data)
        else:
            watch.remove(0)
    if CTRL in readable:
        try:
            chunk = os.read(CTRL, 4096)
        except OSError:
            chunk = b''
        if not chunk:
            watch.remove(CTRL)
        else:
            buf += chunk
            while b'\\n' in buf:
                line, buf = buf.split(b'\\n', 1)
                parts = line.split()
                if len(parts) == 2:
                    try:
                        winsz(int(parts[0]), int(parts[1]))
                    except ValueError:
                        pass
try:
    os.close(fd)
except OSError:
    pass
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
`;

// Builds the argv that runs the user's login shell on a pty at the given size.
function ptyCommand(shell: string, cols: number, rows: number): { cmd: string; args: string[] } {
  if (process.platform === 'win32') {
    // No pty without a native module on Windows; run the shell over pipes
    // (degraded: no prompt redraw / full-screen apps, and resize is a no-op).
    // macOS + Linux are the supported targets.
    return { cmd: process.env.COMSPEC || 'cmd.exe', args: [] };
  }
  return { cmd: 'python3', args: ['-c', PTY_RELAY, shell, String(cols), String(rows)] };
}

// A second Claude session in the same repo is "Claude 2" — the tabs and the
// sidebar rows are short, so the number is what tells them apart. A command
// session is labeled with the command itself ("npm run dev"), numbered the
// same way.
function labelFor(repoId: string, base: string): string {
  const n = [...sessions.values()].filter((s) => s.repoId === repoId && s.base === base).length + 1;
  return n > 1 ? `${base} ${n}` : base;
}

// Drops the oldest dismissable (exited) sessions once too many have piled up.
function trimExited(): void {
  const dead = [...sessions.values()].filter((s) => s.exited)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const s of dead.slice(0, Math.max(0, dead.length - MAX_EXITED))) remove(s.id);
}

// Spawns a new shell session rooted at `cwd`. Returns its summary. Throws if
// the shell process can't be spawned. `command` types one line at the fresh
// prompt (a package script — server/scripts.ts builds it); it is a plain shell
// either way, so the session outlives whatever it started.
function create(opts: {
  cwd: string; repoId: string; kind?: Kind; command?: string; cols?: number; rows?: number;
}): Summary {
  const { cwd, repoId } = opts;
  const kind: Kind = isKind(opts.kind) ? opts.kind : 'shell';
  const command = typeof opts.command === 'string' && opts.command.trim() ? opts.command.trim() : undefined;
  const sid = id();
  const shell = process.env.SHELL || '/bin/bash';
  const { cmd, args } = ptyCommand(shell, opts.cols || 80, opts.rows || 24);
  const child = spawn(cmd, args, {
    cwd,
    // Reuse the task-runner env hardening: strip the API key (so `claude` in
    // the terminal uses the subscription login) and nested-session markers.
    env: { ...runner.childEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    // The fourth pipe is the relay's resize channel (see PTY_RELAY).
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  const control = (child.stdio[3] as Writable | undefined) ?? null;

  const base = command || KIND_LABEL[kind];
  const session: Session = {
    id: sid,
    repoId,
    cwd,
    kind,
    label: labelFor(repoId, base),
    base,
    command,
    child,
    control,
    buffer: [],
    bufferBytes: 0,
    listeners: new Set(),
    exited: false,
    createdAt: new Date().toISOString(),
    lastActivity: Date.now(),
    status: 'active',
  };
  sessions.set(sid, session);

  const emit = (chunk: Buffer) => {
    const b64 = chunk.toString('base64');
    session.buffer.push(b64);
    session.bufferBytes += b64.length;
    while (session.bufferBytes > MAX_BUFFER_BYTES && session.buffer.length > 1) {
      session.bufferBytes -= session.buffer.shift()!.length;
    }
    session.lastActivity = Date.now();
    if (session.status !== 'active') announce(session);
    for (const fn of session.listeners) fn(b64);
  };
  child.stdout.on('data', emit);
  child.stderr.on('data', emit);
  const onDead = () => {
    if (session.exited) return;
    session.exited = true;
    for (const fn of session.listeners) fn('');
    announce(session);
    trimExited();
  };
  child.on('exit', onDead);
  child.on('error', onDead);

  // Type the agent CLI (or the package script) at the fresh prompt rather than
  // exec'ing it, so the tab survives quitting the agent / stopping the script.
  // The pty buffers this until the shell reads it.
  const bin = launchBin(kind);
  const startup = command || (bin ? shQuote(bin) : null);
  if (startup) child.stdin.write(`${startup}\n`);

  syncSweep();
  bus.broadcast({ type: 'terminal', session: summary(session) });
  return summary(session);
}

function get(sid: string): Session | undefined {
  return sessions.get(sid);
}

function list(): Summary[] {
  return [...sessions.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(summary);
}

// Subscribes to a session's output. Immediately replays the buffered output so
// a fresh or reconnecting client repaints the current screen, then streams live
// chunks. An exited session replays and then gets the same empty-chunk "the
// process is gone" marker a live one would send. Returns an unsubscribe
// function, or null when there is no such session.
function attach(sid: string, onChunk: (b64: string) => void): (() => void) | null {
  const s = sessions.get(sid);
  if (!s) return null;
  for (const b64 of s.buffer) onChunk(b64);
  if (s.exited) onChunk('');
  s.listeners.add(onChunk);
  return () => s.listeners.delete(onChunk);
}

function write(sid: string, data: string): boolean {
  const s = sessions.get(sid);
  if (!s || s.exited) return false;
  s.child.stdin.write(data);
  s.lastActivity = Date.now();
  if (s.status !== 'active') announce(s);
  return true;
}

// Live resize: a real TIOCSWINSZ on the pty master, so the shell gets SIGWINCH
// and a full-screen app redraws at the new size. Nothing is written to stdin,
// so it leaves no trace on screen. A no-op on Windows (no pty, no channel).
function resize(sid: string, cols: number, rows: number): boolean {
  const s = sessions.get(sid);
  if (!s || s.exited || !s.control) return false;
  s.control.write(`${cols} ${rows}\n`);
  return true;
}

// Kills the process but keeps the session listed as `exited`, so its tab turns
// red and its scrollback stays readable until the user dismisses it.
function close(sid: string): void {
  const s = sessions.get(sid);
  if (!s || s.exited) return;
  s.child.kill('SIGKILL');
  s.exited = true;
  for (const fn of s.listeners) fn('');
  announce(s);
  trimExited();
}

// Kills (if needed) and forgets a session entirely — the tab's × and the
// sidebar's dismiss.
function remove(sid: string): void {
  const s = sessions.get(sid);
  if (!s) return;
  if (!s.exited) s.child.kill('SIGKILL');
  s.exited = true;
  sessions.delete(sid);
  syncSweep();
  bus.broadcast({ type: 'terminal-removed', id: sid });
}

function closeAll(): void {
  for (const sid of [...sessions.keys()]) remove(sid);
}

export { create, get, list, attach, write, resize, close, remove, closeAll, isKind };
export type { Kind, Status, Summary };
