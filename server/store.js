const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// When embedded in Electron the packaged app dir is read-only, so the main
// process points us at a writable per-user location via SRPOPO_DATA_DIR.
const DATA_DIR = process.env.SRPOPO_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

fs.mkdirSync(LOGS_DIR, { recursive: true });

let db = { repos: [], tasks: [] };
if (fs.existsSync(DB_PATH)) {
  try {
    db = Object.assign({ repos: [], tasks: [] }, JSON.parse(fs.readFileSync(DB_PATH, 'utf8')));
  } catch (err) {
    console.error('[store] failed to read db.json, starting fresh:', err.message);
  }
}

// Any task marked running/grooming when the server starts is an orphan from a
// previous run — its child claude process died with the server.
for (const t of db.tasks) {
  if (t.status === 'running' || t.status === 'grooming') {
    t.status = 'failed';
    t.lastOutcome = 'error';
    t.lastError = 'Server restarted while task was running';
  }
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DB_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_PATH);
  }, 50);
}

function id() {
  return crypto.randomBytes(5).toString('hex');
}

function now() {
  return new Date().toISOString();
}

function logPath(taskId) {
  return path.join(LOGS_DIR, `${taskId}.ndjson`);
}

function appendLog(taskId, event) {
  fs.appendFileSync(logPath(taskId), JSON.stringify(event) + '\n');
}

function readLog(taskId) {
  const p = logPath(taskId);
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip partial line */ }
  }
  return out;
}

function getTask(taskId) {
  return db.tasks.find((t) => t.id === taskId);
}

function getRepo(repoId) {
  return db.repos.find((r) => r.id === repoId);
}

module.exports = { db, save, id, now, appendLog, readLog, logPath, getTask, getRepo, DATA_DIR };
