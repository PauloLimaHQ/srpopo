/**
 * Resource monitor — how much of this machine Sr. Popo and its agents are using.
 *
 * Opt-in (Settings > General > "Resource monitor", `Settings.resourceMonitor`):
 * sampling shells out to the OS process table, so nothing runs until the user
 * asks for it. Everything here is read-only, local, and best-effort — a snapshot
 * that can't be taken degrades to `null` fields rather than failing a request.
 *
 * How a snapshot is built:
 *   1. Read the whole process table once (`ps` on macOS/Linux, a CIM query on
 *      Windows) and index it by pid + parent pid.
 *   2. Walk the tree rooted at *this* process (`process.pid`) — under Electron
 *      that's the app: main process, renderer, GPU helper, in-app terminals, and
 *      every agent CLI child.
 *   3. Attribute each live agent child's own subtree (`runner.liveChildren()`) to
 *      its task/grooming/orchestration/ask session, and report the rest as the
 *      app itself. `agents` + `app` therefore partition the same tree.
 *
 * Units: CPU is a percentage of the machine's **total** capacity (all cores), so
 * the app, agent, and system numbers are directly comparable and sum sensibly.
 * Memory is resident set size (RSS) summed per process — pages shared between
 * processes are counted once per process, so a tree total reads high; it's the
 * same caveat every OS activity monitor carries.
 */
import { execFile } from 'child_process';
import os from 'os';

import { db, now } from './store';
import * as runner from './runner';

// A single OS process, as read from the process table.
interface ProcRow {
  pid: number;
  ppid: number;
  rssBytes: number;
  // Percent of one core, as the OS reports it; normalized to machine-wide
  // percent when it lands in a snapshot. Null when the platform can't say yet
  // (Windows needs two samples to derive a rate).
  cpuPercent: number | null;
}

// The rolled-up usage of one process subtree.
export interface TreeUsage {
  rssBytes: number;
  // Percent of this machine's total CPU capacity (all cores), or null if the
  // platform couldn't report CPU for these processes.
  cpuPercent: number | null;
  processes: number;
}

// One live agent session's slice of the tree.
export interface SessionUsage extends TreeUsage {
  // The task / grooming / orchestration / ask-session id the child belongs to.
  id: string;
  kind: 'task' | 'grooming' | 'orchestration' | 'ask';
  title: string;
  // Which backend is running (see Task.agent); null for sessions that are
  // always Claude (grooming, orchestration, ask).
  agent: string | null;
  pid: number | null;
  startedAt: string | null;
}

export interface Snapshot {
  enabled: true;
  sampledAt: string;
  system: {
    platform: string;
    cpuCount: number;
    // Machine-wide CPU usage (0..100) derived from os.cpus() deltas between
    // snapshots; null on the very first sample (no previous tick to diff).
    cpuPercent: number | null;
    loadAvg1: number | null;
    memTotalBytes: number;
    memUsedBytes: number;
  };
  app: TreeUsage & { pid: number };
  agents: SessionUsage[];
  totals: TreeUsage;
  // Set when the process table couldn't be read (permissions, no `ps`, …). The
  // snapshot still carries the system figures and the app's own RSS.
  note: string | null;
}

export interface DisabledSnapshot {
  enabled: false;
}

// Snapshots are cached briefly so several open boards (and a fast poll while the
// panel is open) share one `ps` call instead of one each.
const CACHE_MS = 1200;
let cached: { at: number; snapshot: Snapshot } | null = null;
let inFlight: Promise<Snapshot> | null = null;

// Previous os.cpus() tick totals, for the machine-wide CPU delta.
let prevCpu: { idle: number; total: number } | null = null;
// Previous per-pid cumulative CPU time (Windows only, in seconds) + when it was
// read, so a rate can be derived from two samples.
let prevWinCpu: { at: number; times: Map<number, number> } | null = null;

function cpuCount(): number {
  return Math.max(1, os.cpus().length);
}

// Machine-wide CPU usage since the previous call, as a 0..100 percentage.
function systemCpuPercent(): number | null {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [kind, ms] of Object.entries(cpu.times)) {
      total += ms;
      if (kind === 'idle') idle += ms;
    }
  }
  const prev = prevCpu;
  prevCpu = { idle, total };
  if (!prev) return null;
  const dTotal = total - prev.total;
  const dIdle = idle - prev.idle;
  if (dTotal <= 0) return null;
  return clampPercent(((dTotal - dIdle) / dTotal) * 100);
}

function clampPercent(n: number): number {
  return Math.max(0, Math.round(n * 10) / 10);
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// macOS/Linux: one `ps` pass over every process. `rss` is in KiB and `pcpu` is
// the OS's own recent-CPU estimate for the process, as a percent of one core.
async function readPosixTable(): Promise<ProcRow[]> {
  // BSD-style flags on macOS, UNIX-style on Linux and friends — `-e` isn't
  // accepted by macOS's ps and `-ax` isn't by procps.
  const flag = process.platform === 'darwin' ? '-axo' : '-eo';
  const out = await run('ps', [flag, 'pid=,ppid=,rss=,pcpu=']);
  const rows: ProcRow[] = [];
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const rssKib = Number(parts[2]);
    const pcpu = Number(parts[3]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    rows.push({
      pid,
      ppid,
      rssBytes: Number.isFinite(rssKib) ? rssKib * 1024 : 0,
      cpuPercent: Number.isFinite(pcpu) ? pcpu : null,
    });
  }
  return rows;
}

// Windows: Win32_Process has no CPU-percent column, only cumulative kernel +
// user time (in 100-nanosecond units), so CPU is derived from the delta against
// the previous sample — the first snapshot reports null CPU per process.
async function readWindowsTable(): Promise<ProcRow[]> {
  const out = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Csv -NoTypeInformation',
  ]);
  const at = Date.now();
  const prev = prevWinCpu;
  const times = new Map<number, number>();
  const rows: ProcRow[] = [];
  const elapsedSec = prev ? (at - prev.at) / 1000 : 0;
  for (const line of out.split('\n')) {
    const cells = line.trim().replace(/^"|"$/g, '').split('","');
    if (cells.length < 5) continue;
    const [pidStr, ppidStr, rssStr, kernelStr, userStr] = cells;
    const pid = Number(pidStr);
    const ppid = Number(ppidStr);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue; // the header row lands here
    const cpuSec = (Number(kernelStr) + Number(userStr)) / 1e7;
    times.set(pid, Number.isFinite(cpuSec) ? cpuSec : 0);
    let cpuPercent: number | null = null;
    const before = prev?.times.get(pid);
    if (before !== undefined && elapsedSec > 0.2 && Number.isFinite(cpuSec)) {
      cpuPercent = clampPercent(((cpuSec - before) / elapsedSec) * 100);
    }
    rows.push({ pid, ppid, rssBytes: Number(rssStr) || 0, cpuPercent });
  }
  prevWinCpu = { at, times };
  return rows;
}

function readProcessTable(): Promise<ProcRow[]> {
  return process.platform === 'win32' ? readWindowsTable() : readPosixTable();
}

// Every pid in the subtree rooted at `root`, `root` included. `skip` prunes
// whole branches — used to keep the agent subtrees out of the app's own total.
function subtree(root: number, children: Map<number, number[]>, skip: Set<number>): number[] {
  if (skip.has(root)) return [];
  const out: number[] = [];
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid) || skip.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const child of children.get(pid) || []) stack.push(child);
  }
  return out;
}

// Roll a set of pids up into one usage figure. CPU is divided by the core count
// so it reads as a share of the whole machine (see the module comment).
function rollUp(pids: number[], byPid: Map<number, ProcRow>, cores: number): TreeUsage {
  let rssBytes = 0;
  let cpu = 0;
  let sawCpu = false;
  let processes = 0;
  for (const pid of pids) {
    const row = byPid.get(pid);
    if (!row) continue;
    processes += 1;
    rssBytes += row.rssBytes;
    if (row.cpuPercent !== null) {
      cpu += row.cpuPercent;
      sawCpu = true;
    }
  }
  return { rssBytes, cpuPercent: sawCpu ? clampPercent(cpu / cores) : null, processes };
}

// What a live agent child is working on, for the panel's session rows. The id is
// a task, grooming or orchestration id; an "Ask Sr. Popo" session is ephemeral
// (never persisted), so it falls through to the generic label.
function describe(id: string): { kind: SessionUsage['kind']; title: string; agent: string | null } {
  const task = db.tasks.find((t) => t.id === id);
  if (task) return { kind: 'task', title: task.title, agent: task.agent || 'claude' };
  const grooming = db.groomings.find((g) => g.id === id);
  if (grooming) return { kind: 'grooming', title: grooming.title || 'Idea grooming', agent: null };
  const orchestration = db.orchestrations.find((o) => o.id === id);
  if (orchestration) return { kind: 'orchestration', title: orchestration.title || 'Goal orchestration', agent: null };
  return { kind: 'ask', title: 'Ask Sr. Popo', agent: null };
}

// A live agent child as the runner reports it (see runner.liveChildren).
interface LiveChild {
  id: string;
  pid: number | null;
  startedAt: string | null;
}

/**
 * Split one process-table reading into "the app" and "each agent session".
 *
 * Pure — no OS access — so the tree walk is directly testable: give it a
 * synthetic table, an app pid, and the live children, and it returns the same
 * partition a real snapshot uses. Each agent child owns its own subtree; the app
 * owns everything else rooted at `appPid`, so nothing is counted twice. A child
 * whose pid has already exited (it isn't in the table) reports zeroes rather than
 * being silently dropped — the session is still live, we just missed it.
 */
function attribute(rows: ProcRow[], appPid: number, live: LiveChild[], cores: number): {
  app: TreeUsage & { pid: number };
  agents: SessionUsage[];
  totals: TreeUsage;
} {
  const byPid = new Map<number, ProcRow>();
  const children = new Map<number, number[]>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }

  const agentPids = new Set(live.map((c) => c.pid).filter((pid): pid is number => pid !== null && byPid.has(pid)));
  const agents: SessionUsage[] = live.map((child) => {
    const pids = child.pid !== null && byPid.has(child.pid) ? subtree(child.pid, children, new Set()) : [];
    return {
      ...describe(child.id),
      id: child.id,
      pid: child.pid,
      startedAt: child.startedAt,
      ...rollUp(pids, byPid, cores),
    };
  });
  // Busiest session first — that's what a monitor is opened to find.
  agents.sort((a, b) => (b.cpuPercent || 0) - (a.cpuPercent || 0) || b.rssBytes - a.rssBytes);

  const app = { pid: appPid, ...rollUp(subtree(appPid, children, agentPids), byPid, cores) };
  const totals: TreeUsage = {
    rssBytes: app.rssBytes + agents.reduce((sum, a) => sum + a.rssBytes, 0),
    cpuPercent: clampPercent((app.cpuPercent || 0) + agents.reduce((sum, a) => sum + (a.cpuPercent || 0), 0)),
    processes: app.processes + agents.reduce((sum, a) => sum + a.processes, 0),
  };
  return { app, agents, totals };
}

// CPU is a rate, so it needs two readings. Rather than hand the board a first
// snapshot with no CPU figures at all, a cold start takes a throwaway baseline,
// waits a beat, and then samples for real — a one-off ~300ms on the first
// request after the monitor is switched on.
async function primeIfCold(): Promise<void> {
  const needsWinBase = process.platform === 'win32' && !prevWinCpu;
  if (prevCpu && !needsWinBase) return;
  systemCpuPercent(); // records the tick baseline, returns null
  if (needsWinBase) {
    // Windows derives per-process CPU from cumulative-time deltas too; a failure
    // here is reported by the real pass below, not swallowed silently.
    try { await readWindowsTable(); } catch { /* handled by the sampling pass */ }
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
}

async function build(): Promise<Snapshot> {
  await primeIfCold();
  const cores = cpuCount();
  const memTotalBytes = os.totalmem();
  const system = {
    platform: process.platform,
    cpuCount: cores,
    cpuPercent: systemCpuPercent(),
    loadAvg1: process.platform === 'win32' ? null : os.loadavg()[0],
    memTotalBytes,
    memUsedBytes: memTotalBytes - os.freemem(),
  };

  const live = runner.liveChildren();
  let rows: ProcRow[] = [];
  let note: string | null = null;
  try {
    rows = await readProcessTable();
  } catch (err) {
    note = `Could not read the process table: ${(err as Error).message}`;
  }

  if (!rows.length) {
    // Degraded but still useful: Node always knows its own memory footprint.
    return {
      enabled: true,
      sampledAt: now(),
      system,
      app: { pid: process.pid, rssBytes: process.memoryUsage().rss, cpuPercent: null, processes: 1 },
      agents: live.map((child) => ({
        ...describe(child.id),
        id: child.id,
        pid: child.pid,
        startedAt: child.startedAt,
        rssBytes: 0,
        cpuPercent: null,
        processes: 0,
      })),
      totals: { rssBytes: process.memoryUsage().rss, cpuPercent: null, processes: 1 },
      note: note || 'The process table came back empty on this platform.',
    };
  }

  const { app, agents, totals } = attribute(rows, process.pid, live, cores);
  return { enabled: true, sampledAt: now(), system, app, agents, totals, note };
}

/**
 * Take (or reuse) a snapshot. Returns `{ enabled: false }` while the feature is
 * off in Settings, so nothing is sampled and the board knows to stay quiet.
 * Concurrent callers share one in-flight sample; a fresh-enough snapshot is
 * served from the cache.
 */
async function snapshot(): Promise<Snapshot | DisabledSnapshot> {
  if (!db.settings.resourceMonitor) return { enabled: false };
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.snapshot;
  if (inFlight) return inFlight;
  inFlight = build()
    .then((snap) => {
      cached = { at: Date.now(), snapshot: snap };
      return snap;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

// Drop the cached sample + CPU baselines. Called when the setting is turned off
// so re-enabling starts from a clean slate rather than a stale delta.
function reset(): void {
  cached = null;
  prevCpu = null;
  prevWinCpu = null;
}

// `attribute` is exported for the smoke suite (it's the risky part: the tree walk
// and the app/agent split); nothing else calls it directly.
export { snapshot, reset, attribute };
