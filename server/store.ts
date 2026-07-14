import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import type { Db, LogEvent, Repo, Settings, Task } from './types';

// When embedded in Electron the packaged app dir is read-only, so the main
// process points us at a writable per-user location via SRPOPO_DATA_DIR.
const DATA_DIR = process.env.SRPOPO_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

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
  // Remote access is OFF by default: the server binds 127.0.0.1 only and needs
  // no token, exactly as before. The token stays empty until the first time the
  // user enables remote access (generated lazily in PATCH /api/settings).
  remoteAccess: false,
  remoteAccessToken: '',
};

let db: Db = { repos: [], tasks: [], settings: { ...DEFAULT_SETTINGS } };
if (fs.existsSync(DB_PATH)) {
  try {
    db = Object.assign(
      { repos: [], tasks: [], settings: {} },
      JSON.parse(fs.readFileSync(DB_PATH, 'utf8')),
    ) as Db;
  } catch (err) {
    console.error('[store] failed to read db.json, starting fresh:', (err as Error).message);
  }
}
// Backfill any missing setting so the rest of the app can read them directly.
// Capture pre-backfill hints first so we can migrate older db.json files below.
const hadInstalledPlugins = Array.isArray(db.settings?.installedPlugins);
const hadLinearToken = !!(db.settings?.linearApiToken || '').trim();
db.settings = Object.assign({ ...DEFAULT_SETTINGS }, db.settings || {});
// Migrate: users who configured Linear before the marketplace existed keep it
// installed, so their "From Linear" button doesn't silently disappear.
if (!hadInstalledPlugins) db.settings.installedPlugins = hadLinearToken ? ['linear'] : [];

// Any task marked running/grooming when the server starts is an orphan from a
// previous run — its child claude process died with the server.
for (const t of db.tasks) {
  if (t.status === 'running' || t.status === 'grooming') {
    t.status = 'failed';
    t.lastOutcome = 'error';
    t.lastError = 'Server restarted while task was running';
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

export { db, save, id, now, appendLog, readLog, logPath, getTask, getRepo, DATA_DIR, DEFAULT_SETTINGS };
