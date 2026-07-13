const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const { db, save, id, now, readLog, getTask, getRepo } = require('./store');
const { broadcast, sse } = require('./bus');
const git = require('./git');
const runner = require('./runner');
const addons = require('./addons');
const personas = require('./personas');
const groomer = require('./groomer');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function slugify(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'task'
  );
}

function err(res, code, message) {
  res.status(code).json({ error: message });
}

// ---------- health ----------

app.get('/api/health', (req, res) => {
  execFile(runner.CLAUDE_BIN, ['--version'], { timeout: 10000 }, (e, stdout) => {
    res.json({
      ok: !e,
      claude: e ? null : stdout.trim(),
      error: e ? `claude CLI not found (${runner.CLAUDE_BIN})` : null,
      node: process.version,
    });
  });
});

// ---------- state / events ----------

app.get('/api/state', (req, res) => {
  res.json({
    repos: db.repos,
    tasks: db.tasks.filter((t) => !t.archived),
    settings: db.settings,
  });
});

app.get('/api/events', (req, res) => sse(req, res));

// ---------- settings ----------

// User preferences (e.g. desktop notifications). Persisted in db.json and
// broadcast so every connected board — and the Electron shell — stays in sync.
app.get('/api/settings', (req, res) => res.json(db.settings));

app.patch('/api/settings', (req, res) => {
  if ('notifications' in req.body) db.settings.notifications = !!req.body.notifications;
  save();
  broadcast({ type: 'settings', settings: db.settings });
  res.json(db.settings);
});

// Catalog of optional task behaviors the UI renders as checkboxes.
app.get('/api/addons', (req, res) => res.json(addons.catalog()));

// Catalog of expert personas the UI renders as selectable role checkboxes.
app.get('/api/personas', (req, res) => res.json(personas.catalog()));

// ---------- repos ----------

app.post('/api/repos', async (req, res) => {
  const raw = String(req.body.path || '').trim();
  if (!raw) return err(res, 400, 'path is required');
  const repoPath = raw.replace(/^~(?=\/|$)/, process.env.HOME || '~');
  if (!fs.existsSync(repoPath)) return err(res, 400, `Path does not exist: ${repoPath}`);
  if (!(await git.isGitRepo(repoPath))) return err(res, 400, `Not a git repository: ${repoPath}`);
  if (db.repos.some((r) => r.path === repoPath)) return err(res, 409, 'Repo already added');

  const repo = {
    id: id(),
    path: repoPath,
    name: path.basename(repoPath),
    branch: await git.currentBranch(repoPath),
    addedAt: now(),
  };
  db.repos.push(repo);
  save();
  broadcast({ type: 'repos', repos: db.repos });
  res.json(repo);
});

app.delete('/api/repos/:id', (req, res) => {
  const idx = db.repos.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return err(res, 404, 'Repo not found');
  const active = db.tasks.some((t) => t.repoId === req.params.id && !t.archived);
  if (active) return err(res, 409, 'Repo has non-archived tasks; archive them first');
  db.repos.splice(idx, 1);
  save();
  broadcast({ type: 'repos', repos: db.repos });
  res.json({ ok: true });
});

// ---------- tasks ----------

app.post('/api/tasks', (req, res) => {
  const { title, prompt, repoId, model, useWorktree, permissionMode, status } = req.body;
  if (!title || !prompt) return err(res, 400, 'title and prompt are required');
  const repo = getRepo(repoId);
  if (!repo) return err(res, 400, 'Unknown repo');

  const task = {
    id: id(),
    title: String(title).trim(),
    prompt: String(prompt),
    repoId: repo.id,
    repoName: repo.name,
    repoPath: repo.path,
    addons: addons.sanitize(req.body.addons),
    personas: personas.sanitize(req.body.personas),
    useWorktree: !!useWorktree,
    worktreePath: null,
    branch: null,
    model: model || 'default',
    permissionMode: permissionMode || 'acceptEdits',
    allowedTools: runner.normalizeAllowedTools(req.body.allowedTools),
    status: status === 'ready' ? 'ready' : 'backlog',
    sessionId: null,
    resolvedModel: null,
    costUsd: 0,
    numTurns: null,
    durationMs: null,
    runCount: 0,
    activeSubagents: 0,
    lastOutcome: null,
    lastError: null,
    archived: false,
    createdAt: now(),
    updatedAt: now(),
    startedAt: null,
    finishedAt: null,
  };
  db.tasks.push(task);
  save();
  broadcast({ type: 'task', task });
  res.json(task);
});

// ---------- briefs (idea grooming) ----------

// "Brief an Idea": turn a rough one-line idea into a groomed, ready-to-run task.
// Creates the task in the `grooming` state and kicks off a short, read-only
// Claude session in the repo that rewrites the idea into a well-structured
// prompt; when it finishes the task moves to `ready`. Like dispatch, the
// grooming state is entered only here — never via PATCH /api/tasks/:id.
app.post('/api/briefs', (req, res) => {
  const brief = String(req.body.brief || '').trim();
  if (!brief) return err(res, 400, 'brief is required');
  const repo = getRepo(req.body.repoId);
  if (!repo) return err(res, 400, 'Unknown repo');

  const task = {
    id: id(),
    title: groomer.deriveTitle(brief),
    prompt: brief, // the rough idea, until grooming rewrites it
    brief, // the original idea, preserved even after grooming
    repoId: repo.id,
    repoName: repo.name,
    repoPath: repo.path,
    addons: [],
    personas: [],
    useWorktree: true,
    worktreePath: null,
    branch: null,
    model: req.body.model || 'default',
    permissionMode: 'acceptEdits',
    allowedTools: '',
    status: 'grooming',
    sessionId: null,
    resolvedModel: null,
    costUsd: 0,
    numTurns: null,
    durationMs: null,
    runCount: 0,
    activeSubagents: 0,
    lastOutcome: null,
    lastError: null,
    archived: false,
    createdAt: now(),
    updatedAt: now(),
    startedAt: null,
    finishedAt: null,
  };
  db.tasks.push(task);
  save();
  broadcast({ type: 'task', task });

  try {
    runner.groom(task, brief);
    res.json(task);
  } catch (e) {
    task.status = 'backlog';
    task.lastOutcome = 'error';
    task.lastError = e.message;
    task.updatedAt = now();
    save();
    broadcast({ type: 'task', task });
    err(res, 500, e.message);
  }
});

app.patch('/api/tasks/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return err(res, 404, 'Task not found');
  if (runner.isRunning(task.id)) return err(res, 409, 'Task is running; stop it first');

  const allowed = ['title', 'prompt', 'model', 'permissionMode', 'allowedTools', 'useWorktree', 'status', 'addons', 'personas'];
  for (const key of allowed) {
    if (key in req.body) {
      if (key === 'addons') {
        task.addons = addons.sanitize(req.body.addons);
      } else if (key === 'allowedTools') {
        task.allowedTools = runner.normalizeAllowedTools(req.body.allowedTools);
      } else if (key === 'personas') {
        task.personas = personas.sanitize(req.body.personas);
      } else if (key === 'status') {
        const target = req.body.status;
        if (!['backlog', 'ready', 'review', 'done', 'failed'].includes(target)) {
          return err(res, 400, `Cannot set status to "${target}" directly (use /dispatch to run)`);
        }
        task.status = target;
      } else if (key === 'useWorktree' && task.worktreePath) {
        // worktree already materialized; ignore toggle
      } else {
        task[key] = req.body[key];
      }
    }
  }
  task.updatedAt = now();
  save();
  broadcast({ type: 'task', task });
  res.json(task);
});

app.post('/api/tasks/:id/dispatch', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return err(res, 404, 'Task not found');
  if (runner.isRunning(task.id)) return err(res, 409, 'Task is already running');

  try {
    if (task.useWorktree && !task.worktreePath) {
      const { wtPath, branch } = await git.addWorktree(task.repoPath, task.id, slugify(task.title));
      task.worktreePath = wtPath;
      task.branch = branch;
      save();
    }
    const followUp = req.body && req.body.message ? String(req.body.message) : null;
    if (followUp && task.sessionId) {
      runner.dispatch(task, followUp, { resume: true });
    } else {
      // Fresh run of the task prompt — frame it with any selected personas up
      // front, then fold in any selected add-on behaviors at the end.
      const framed = personas.preambleFor(task.personas) + task.prompt + addons.instructionsFor(task.addons);
      runner.dispatch(task, framed, { resume: false });
    }
    res.json(task);
  } catch (e) {
    task.status = 'failed';
    task.lastOutcome = 'error';
    task.lastError = e.message;
    task.updatedAt = now();
    save();
    broadcast({ type: 'task', task });
    err(res, 500, e.message);
  }
});

app.post('/api/tasks/:id/stop', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return err(res, 404, 'Task not found');
  if (!runner.stop(task.id)) return err(res, 409, 'Task is not running');
  res.json({ ok: true });
});

app.post('/api/tasks/:id/archive', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return err(res, 404, 'Task not found');
  if (runner.isRunning(task.id)) return err(res, 409, 'Stop the task before archiving');
  task.archived = true;
  task.updatedAt = now();
  save();
  broadcast({ type: 'task-removed', taskId: task.id });
  res.json({ ok: true });
});

app.post('/api/tasks/:id/worktree/remove', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return err(res, 404, 'Task not found');
  if (runner.isRunning(task.id)) return err(res, 409, 'Stop the task first');
  if (!task.worktreePath) return err(res, 400, 'Task has no worktree');
  try {
    await git.removeWorktree(task.repoPath, task.worktreePath);
    task.worktreePath = null;
    task.updatedAt = now();
    save();
    broadcast({ type: 'task', task });
    res.json(task);
  } catch (e) {
    err(res, 500, e.message);
  }
});

app.get('/api/tasks/:id/logs', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return err(res, 404, 'Task not found');
  res.json({ task, events: readLog(task.id) });
});

app.get('/api/tasks/:id/worktree/status', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task || !task.worktreePath) return err(res, 404, 'No worktree');
  res.json((await git.worktreeStatus(task.worktreePath)) || {});
});

// ---------- boot ----------

/**
 * Start the HTTP server on 127.0.0.1.
 * @param {number} [port] - desired port; pass 0 for an OS-assigned free port.
 * @returns {Promise<{server: import('http').Server, port: number, url: string}>}
 */
function start(port = process.env.PORT || 7777) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({ server, port: actual, url: `http://127.0.0.1:${actual}` });
    });
    server.on('error', reject);
  });
}

module.exports = { app, start, runner };

// When run directly (`node server/index.js`), boot as a standalone server.
if (require.main === module) {
  start().then(({ port }) => {
    console.log(`\n  Sr. Popo is watching over your tasks at http://localhost:${port}\n`);
  });

  process.on('SIGINT', () => {
    runner.stopAll();
    process.exit(0);
  });
}
