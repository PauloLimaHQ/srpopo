import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import type { Db, Grooming, LogEvent, Orchestration, Repo, Settings, Task, UsageEntry } from './types';

// When embedded in Electron the packaged app dir is read-only, so the main
// process points us at a writable per-user location via SRPOPO_DATA_DIR.
const DATA_DIR = process.env.SRPOPO_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
// Append-only usage ledger (see server/usage.ts) — one JSON line per model per
// run, the source the Usage dashboard aggregates from. Kept separate from the
// per-task NDJSON logs so reading it for a dashboard never has to replay every
// task's full tool-call/assistant-text history.
const USAGE_PATH = path.join(DATA_DIR, 'usage.ndjson');

fs.mkdirSync(LOGS_DIR, { recursive: true });

// User-level preferences, persisted alongside repos/tasks in db.json. New keys
// added here get their default backfilled on load, so old db.json files upgrade.
const DEFAULT_SETTINGS: Settings = {
  notifications: true,
  sounds: true,
  linearApiToken: '',
  // 3 concurrent `claude` sessions is a reasonable default: enough to keep a few
  // tasks moving without starving one run of CPU or hitting subscription rate
  // limits on a typical dev laptop. Configurable in Settings.
  maxParallelSessions: 3,
  installedPlugins: [],
  // Traditional merge commit, matching `gh pr merge`'s own default.
  mergeStrategy: 'merge',
  // Off by default: auto-resolving conflicts spawns a new `claude` run unattended.
  autoResolveConflicts: false,
  // Autonomous Mode only merges work the Code Review stage graded 4 ("mergeable,
  // only nits") or better; anything below is left in `validation` for the human.
  minMergeGrade: 4,
  // Off by default, like the other opt-in GitHub behaviors here.
  assignPrToSelf: false,
  // Remote access is OFF by default: the server binds 127.0.0.1 only and needs
  // no token, exactly as before. The token stays empty until the first time the
  // user enables remote access (generated lazily in PATCH /api/settings).
  remoteAccess: false,
  remoteAccessToken: '',
  // No custom models until the user adds one in Settings → Models.
  customModels: [],
  // On by default: cheap (runs on a fixed Haiku model) and the developer
  // explicitly wants automatic per-repo memory distillation. See server/memory.ts.
  memory: true,
};

let db: Db = { repos: [], tasks: [], groomings: [], orchestrations: [], settings: { ...DEFAULT_SETTINGS } };
if (fs.existsSync(DB_PATH)) {
  try {
    db = Object.assign(
      { repos: [], tasks: [], groomings: [], orchestrations: [], settings: {} },
      JSON.parse(fs.readFileSync(DB_PATH, 'utf8')),
    ) as Db;
  } catch (err) {
    console.error('[store] failed to read db.json, starting fresh:', (err as Error).message);
  }
}
// Older db.json files predate the groomings collection.
if (!Array.isArray(db.groomings)) db.groomings = [];
// …and the orchestrations one (Hive Orchestration, see server/hive.ts).
if (!Array.isArray(db.orchestrations)) db.orchestrations = [];
// Backfill any missing setting so the rest of the app can read them directly.
// Capture pre-backfill hints first so we can migrate older db.json files below.
const hadInstalledPlugins = Array.isArray(db.settings?.installedPlugins);
const hadLinearToken = !!(db.settings?.linearApiToken || '').trim();
db.settings = Object.assign({ ...DEFAULT_SETTINGS }, db.settings || {});
// Migrate: users who configured Linear before the marketplace existed keep it
// installed, so their "From Linear" button doesn't silently disappear.
if (!hadInstalledPlugins) db.settings.installedPlugins = hadLinearToken ? ['linear'] : [];

// Bring one persisted task up to date with the current schema. Any task marked
// running when the server starts is an orphan from a previous run — its child
// claude process died with the server. Older db.json files may still carry the
// legacy per-task 'grooming' status; treat those the same way.
function migrateTask(t: Task): void {
  // Tasks created before the pluggable-agent backend default to Claude.
  if (!t.agent) t.agent = 'claude';
  if (t.status === 'running' || (t.status as string) === 'grooming') {
    t.status = 'failed';
    t.lastOutcome = 'error';
    t.lastError = 'Server restarted while task was running';
    t.resolvingConflicts = false;
  } else if (t.status === 'code_review') {
    // A dead code-review run is not a failed task: the implementation work
    // already succeeded, so park it where the human validates it (exactly what
    // runner.codeReview's own exit path does).
    t.status = 'validation';
    t.lastOutcome = 'review-error';
    t.lastError = 'Server restarted while the code review was running';
  } else if ((t.status as string) === 'review') {
    // The finished-work phase split into Code Review → Validation; the legacy
    // `review` column is what `validation` is now.
    t.status = 'validation';
  }
}
for (const t of db.tasks) migrateTask(t);
// Same for grooming cards: a card can't still be running without its child.
for (const g of db.groomings) {
  // Older db.json files predate the clarifying-questions field.
  if (!Array.isArray(g.questions)) g.questions = [];
  if (g.status === 'running') {
    g.status = 'failed';
    g.lastOutcome = 'error';
    g.lastError = 'Server restarted while grooming was running';
  }
}
// Same for orchestration cards: a live queen session died with the server. A
// card that was merely `waiting` (or `awaiting` an answer) is left alone — its
// claude session is resumable, and hive.start() re-arms the watchers on boot.
for (const o of db.orchestrations) {
  if (!Array.isArray(o.watch)) o.watch = [];
  if (!Array.isArray(o.taskIds)) o.taskIds = [];
  if (o.status === 'running') {
    o.status = 'failed';
    o.lastOutcome = 'error';
    o.lastError = 'Server restarted while the orchestrator was running';
  }
}

let saveTimer: NodeJS.Timeout | null = null;
function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DB_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_PATH);
  }, 50);
}

function id(): string {
  return crypto.randomBytes(5).toString('hex');
}

function now(): string {
  return new Date().toISOString();
}

function logPath(taskId: string): string {
  return path.join(LOGS_DIR, `${taskId}.ndjson`);
}

function appendLog(taskId: string, event: LogEvent): void {
  fs.appendFileSync(logPath(taskId), JSON.stringify(event) + '\n');
}

function readLog(taskId: string): unknown[] {
  const p = logPath(taskId);
  if (!fs.existsSync(p)) return [];
  const out: unknown[] = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip partial line */ }
  }
  return out;
}

function getTask(taskId: string): Task | undefined {
  return db.tasks.find((t) => t.id === taskId);
}

function getRepo(repoId: string): Repo | undefined {
  return db.repos.find((r) => r.id === repoId);
}

function getGrooming(groomingId: string): Grooming | undefined {
  return db.groomings.find((g) => g.id === groomingId);
}

function getOrchestration(orchestrationId: string): Orchestration | undefined {
  return db.orchestrations.find((o) => o.id === orchestrationId);
}

// Drop a task/grooming session log from disk (e.g. when a grooming is deleted).
function removeLog(taskId: string): void {
  try { fs.rmSync(logPath(taskId), { force: true }); } catch { /* best effort */ }
}

// In-memory cache of the parsed ledger, invalidated on every append. Local,
// single-user tool — one small file, so a full re-read is cheap the one time
// it's needed and free every other time GET /api/usage is hit.
let usageCache: UsageEntry[] | null = null;

function usageLogExists(): boolean {
  return fs.existsSync(USAGE_PATH);
}

// Creates an empty ledger file if none exists yet — the sentinel usage.ts's
// one-time backfill checks so it never re-scans every task's logs on boot.
function touchUsageLog(): void {
  if (!fs.existsSync(USAGE_PATH)) fs.writeFileSync(USAGE_PATH, '');
}

function appendUsage(entry: UsageEntry): void {
  fs.appendFileSync(USAGE_PATH, JSON.stringify(entry) + '\n');
  usageCache = null;
}

function readUsage(): UsageEntry[] {
  if (usageCache) return usageCache;
  if (!fs.existsSync(USAGE_PATH)) return (usageCache = []);
  const out: UsageEntry[] = [];
  for (const line of fs.readFileSync(USAGE_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip partial line */ }
  }
  usageCache = out;
  return out;
}

export {
  db, save, id, now, appendLog, readLog, removeLog, logPath, getTask, getRepo, getGrooming, getOrchestration, migrateTask,
  DATA_DIR, DEFAULT_SETTINGS, appendUsage, readUsage, usageLogExists, touchUsageLog,
};
