import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

import { db, save, id, now, readLog, getTask, getRepo } from './store';
import { broadcast, sse } from './bus';
import { appRoot } from './paths';
import type { Task, Attachment } from './types';
import * as git from './git';
import * as runner from './runner';
import * as attachments from './attachments';
import * as addons from './addons';
import * as permissions from './permissions';
import * as personas from './personas';
import * as groomer from './groomer';
import * as github from './github';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(appRoot(), 'public')));

function slugify(text: unknown): string {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'task'
  );
}

function err(res: Response, code: number, message: string): void {
  res.status(code).json({ error: message });
}

// ---------- health ----------

app.get('/api/health', (req: Request, res: Response) => {
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

app.get('/api/state', (req: Request, res: Response) => {
  res.json({
    repos: db.repos,
    // Annotate each task with any live permission prompts so a board that loads
    // (or reconnects) mid-run immediately shows what's waiting on the user.
    tasks: db.tasks
      .filter((t) => !t.archived)
      .map((t) => ({ ...t, pendingPermissions: permissions.listForTask(t.id) })),
    settings: db.settings,
  });
});

app.get('/api/events', (req: Request, res: Response) => sse(req, res));

// ---------- settings ----------

// User preferences (e.g. desktop notifications). Persisted in db.json and
// broadcast so every connected board — and the Electron shell — stays in sync.
app.get('/api/settings', (req: Request, res: Response) => res.json(db.settings));

app.patch('/api/settings', (req: Request, res: Response) => {
  if ('notifications' in req.body) db.settings.notifications = !!req.body.notifications;
  if ('sounds' in req.body) db.settings.sounds = !!req.body.sounds;
  save();
  broadcast({ type: 'settings', settings: db.settings });
  res.json(db.settings);
});

// Catalog of optional task behaviors the UI renders as checkboxes.
app.get('/api/addons', (req: Request, res: Response) => res.json(addons.catalog()));

// Catalog of expert personas the UI renders as selectable role checkboxes.
app.get('/api/personas', (req: Request, res: Response) => res.json(personas.catalog()));

// ---------- repos ----------

app.post('/api/repos', async (req: Request, res: Response) => {
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

app.delete('/api/repos/:id', (req: Request, res: Response) => {
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

app.post('/api/tasks', (req: Request, res: Response) => {
  const { title, prompt, repoId, model, useWorktree, permissionMode, status } = req.body;
  if (!title || !prompt) return err(res, 400, 'title and prompt are required');
  const repo = getRepo(repoId);
  if (!repo) return err(res, 400, 'Unknown repo');

  const task: Task = {
    id: id(),
    title: String(title).trim(),
    prompt: String(prompt),
    repoId: repo.id,
    repoName: repo.name,
    repoPath: repo.path,
    addons: addons.sanitize(req.body.addons),
    personas: personas.sanitize(req.body.personas),
    attachments: [],
    useWorktree: !!useWorktree,
    worktreePath: null,
    branch: null,
    model: model || 'default',
    permissionMode: permissionMode || 'acceptEdits',
    allowedTools: runner.normalizeAllowedTools(req.body.allowedTools),
    // Ask the user to approve otherwise-denied tools instead of silently finishing
    // without running them. Defaults on; opt out for fully-unattended runs.
    promptPermissions: 'promptPermissions' in req.body ? !!req.body.promptPermissions : true,
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
app.post('/api/briefs', (req: Request, res: Response) => {
  const brief = String(req.body.brief || '').trim();
  if (!brief) return err(res, 400, 'brief is required');
  const repo = getRepo(req.body.repoId);
  if (!repo) return err(res, 400, 'Unknown repo');

  const task: Task = {
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
    promptPermissions: true, // applies once dispatched; grooming itself is read-only
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
    task.lastError = (e as Error).message;
    task.updatedAt = now();
    save();
    broadcast({ type: 'task', task });
    err(res, 500, (e as Error).message);
  }
});

app.patch('/api/tasks/:id', (req: Request, res: Response) => {
  const task = getTask(req.params.id);
  if (!task) return err(res, 404, 'Task not found');
  if (runner.isRunning(task.id)) return err(res, 409, 'Task is running; stop it first');

  const allowed = ['title', 'prompt', 'model', 'permissionMode', 'allowedTools', 'promptPermissions', 'useWorktree', 'status', 'addons', 'personas'] as const;
  for (const key of allowed) {
    if (key in req.body) {
      if (key === 'addons') {
        task.addons = addons.sanitize(req.body.addons);
      } else if (key === 'allowedTools') {
        task.allowedTools = runner.normalizeAllowedTools(req.body.allowedTools);
      } else if (key === 'promptPermissions') {
        task.promptPermissions = !!req.body.promptPermissions;
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
        (task as unknown as Record<string, unknown>)[key] = req.body[key];
      }
    }
  }
  task.updatedAt = now();
  save();
  broadcast({ type: 'task', task });
  res.json(task);
});

// ---------- attachments ----------

// Upload one file for a task. The raw bytes are the request body (route-scoped
// express.raw, so the global JSON parser is untouched); the original filename
// rides in the X-Filename header and is sanitized to a safe basename before it
// touches disk. Blocked while the task is live, mirroring the PATCH guard.
app.post(
  '/api/tasks/:id/attachments',
  express.raw({ type: 'application/octet-stream', limit: '25mb' }),
  (req: Request, res: Response) => {
    const task = getTask(req.params.id);
    if (!task) return err(res, 404, 'Task not found');
    if (task.status === 'running' || task.status === 'grooming') {
      return err(res, 409, 'Task is running; stop it first');
    }
    const header = req.header('X-Filename');
    if (!header) return err(res, 400, 'X-Filename header is required');
    // The client percent-encodes the name so non-ASCII survives the header.
    let rawName = header;
    try { rawName = decodeURIComponent(header); } catch { /* keep the raw header */ }
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!bytes.length) return err(res, 400, 'Empty upload');

    const { name, size } = attachments.write(task.id, rawName, bytes);
    const entry: Attachment = { name, size, addedAt: now() };
    task.attachments = task.attachments || [];
    task.attachments.push(entry);
    task.updatedAt = now();
    save();
    broadcast({ type: 'task', task });
    res.json(task);
  },
);

// Delete one of a task's attachments. The :name param is re-sanitized so it
// can't reach outside the task's attachment dir.
app.delete('/api/tasks/:id/attachments/:name', (req: Request, res: Response) => {
  const task = getTask(req.params.id);
  if (!task) return err(res, 404, 'Task not found');
  if (task.status === 'running' || task.status === 'grooming') {
    return err(res, 409, 'Task is running; stop it first');
  }
  const name = attachments.sanitizeName(req.params.name);
  attachments.remove(task.id, name);
  task.attachments = (task.attachments || []).filter((a) => a.name !== name);
  task.updatedAt = now();
  save();
  broadcast({ type: 'task', task });
  res.json(task);
});

app.post('/api/tasks/:id/dispatch', async (req: Request, res: Response) => {
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
      let framed = personas.preambleFor(task.personas) + task.prompt + addons.instructionsFor(task.addons);
      // List any attached files by absolute path so the session can Read them.
      if (task.attachments?.length) {
        const paths = attachments.listPaths(task.id, task.attachments.map((a) => a.name));
        if (paths.length) {
          framed += '\n\n## Attached files\nThe user attached these files for this task. Read them as needed:\n' +
            paths.map((p) => `- ${p}`).join('\n');
        }
      }
      runner.dispatch(task, framed, { resume: false });
    }
    res.json(task);
  } catch (e) {
    task.status = 'failed';
    task.lastOutcome = 'error';
    task.lastError = (e as Error).message;
    task.updatedAt = now();
    save();
    broadcast({ type: 'task', task });
    err(res, 500, (e as Error).message);
  }
});

app.post('/api/tasks/:id/stop', (req: Request, res: Response) => {
  const task = getTask(req.params.id);
  if (!task) return err(res, 404, 'Task not found');
  if (!runner.stop(task.id)) return err(res, 409, 'Task is not running');
  res.json({ ok: true });
});

// ---------- interactive tool-permission prompts ----------

// Called by the permission-prompt MCP bridge (localhost only, see permission-mcp.js).
// Registers a pending approval and holds the response open until the user decides
// in the board, then replies with the CLI's { behavior, ... } decision contract.
// Never errors out: a not-running task or a dropped connection resolves to a deny.
app.post('/api/tasks/:id/permission', (req: Request, res: Response) => {
  const task = getTask(req.params.id);
  if (!task || !runner.isRunning(task.id)) {
    return res.json({ behavior: 'deny', message: 'Task is not running' });
  }
  const toolName = String((req.body && req.body.tool_name) || 'tool');
  const input = (req.body && req.body.input) || {};
  const { id: reqId, promise } = permissions.create(task.id, toolName, input);
  // If the bridge disconnects before we answer (the claude child died), settle it.
  // Guard on writableEnded: res 'close' also fires on a normal completed response,
  // and note req 'close' is unusable here — it fires as soon as the POST body is
  // read, long before any decision.
  res.on('close', () => { if (!res.writableEnded) permissions.abandon(task.id, reqId); });
  promise.then((decision) => { if (!res.writableEnded) res.json(decision); });
});

// The user's answer to a pending prompt, from the board UI. Resolves the request
// the bridge is waiting on. Idempotent: a stale/duplicate decision is a no-op.
app.post('/api/tasks/:id/permissions/:reqId', (req: Request, res: Response) => {
  const task = getTask(req.params.id);
  if (!task) return err(res, 404, 'Task not found');
  const behavior = req.body && req.body.behavior === 'allow' ? 'allow' : 'deny';
  const ok = permissions.decide(task.id, req.params.reqId, {
    behavior,
    message: req.body && req.body.message,
    updatedInput: req.body && req.body.updatedInput,
  });
  res.json({ ok });
});

app.post('/api/tasks/:id/archive', (req: Request, res: Response) => {
  const task = getTask(req.params.id);
  if (!task) return err(res, 404, 'Task not found');
  if (runner.isRunning(task.id)) return err(res, 409, 'Stop the task before archiving');
  task.archived = true;
  task.updatedAt = now();
  // The task is gone from the board; drop its uploaded files too. Absent dir is fine.
  attachments.removeDir(task.id);
  task.attachments = [];
  save();
  broadcast({ type: 'task-removed', taskId: task.id });
  res.json({ ok: true });
});

app.post('/api/tasks/:id/worktree/remove', async (req: Request, res: Response) => {
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
    err(res, 500, (e as Error).message);
  }
});

app.get('/api/tasks/:id/logs', (req: Request, res: Response) => {
  const task = getTask(req.params.id);
  if (!task) return err(res, 404, 'Task not found');
  res.json({ task, events: readLog(task.id) });
});

// Read-only lookup of the GitHub PR for a task's branch, via the `gh` CLI.
// Never mutates task state or requires the task to be running; returns a typed
// { pr, reason } result so a missing/failed `gh` never crashes the endpoint.
app.get('/api/tasks/:id/pr', async (req: Request, res: Response) => {
  const task = getTask(req.params.id);
  if (!task) return err(res, 404, 'Task not found');
  res.json(await github.prForTask(task));
});

app.get('/api/tasks/:id/worktree/status', async (req: Request, res: Response) => {
  const task = getTask(req.params.id);
  if (!task || !task.worktreePath) return err(res, 404, 'No worktree');
  res.json((await git.worktreeStatus(task.worktreePath)) || {});
});

// ---------- boot ----------

/**
 * Start the HTTP server on 127.0.0.1.
 * @param port - desired port; pass 0 for an OS-assigned free port.
 */
function start(port: string | number = process.env.PORT || 7777): Promise<{ server: Server; port: number; url: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(Number(port), '127.0.0.1', () => {
      const actual = (server.address() as AddressInfo).port;
      const url = `http://127.0.0.1:${actual}`;
      // Tell the runner where the permission bridge should POST approval requests.
      runner.setBaseUrl(url);
      resolve({ server, port: actual, url });
    });
    server.on('error', reject);
  });
}

export { app, start, runner };

// When run directly (`node server/index.js` / `tsx server/index.ts`), boot as a
// standalone server.
if (require.main === module) {
  start().then(({ port }) => {
    console.log(`\n  Sr. Popo is watching over your tasks at http://localhost:${port}\n`);
  });

  process.on('SIGINT', () => {
    runner.stopAll();
    process.exit(0);
  });
}
