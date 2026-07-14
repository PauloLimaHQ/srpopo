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
import type { Task, Attachment, Repo, PublicSettings, WorktreeInfo } from './types';
import * as git from './git';
import * as runner from './runner';
import * as attachments from './attachments';
import * as addons from './addons';
import * as permissions from './permissions';
import * as personas from './personas';
import * as groomer from './groomer';
import * as github from './github';
import * as linear from './linear';
import * as plugins from './plugins';
import * as autonomous from './autonomous';
import * as framing from './framing';
import * as terminal from './terminal';
import * as taskService from './tasks';
import * as mcp from './mcp';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(appRoot(), 'public')));

// Read once at boot — package.json never changes underneath a running process.
const appVersion: string = JSON.parse(
  fs.readFileSync(path.join(appRoot(), 'package.json'), 'utf8')
).version;

// Slug + prompt framing live in server/framing.ts so the dispatch route and the
// Autonomous Mode engine build worktree names and framed prompts identically.
const slugify = framing.slugify;

function err(res: Response, code: number, message: string): void {
  res.status(code).json({ error: message });
}


// The board-facing view of settings: never leak the raw Linear token, only a
// derived boolean. This is the ONLY shape sent to the UI (GET /api/settings,
// GET /api/state, and the `settings` broadcast); PATCH is the only writer.
function publicSettings(): PublicSettings {
  return {
    notifications: db.settings.notifications,
    sounds: db.settings.sounds,
    linearConfigured: !!(db.settings.linearApiToken && db.settings.linearApiToken.trim()),
    maxParallelSessions: db.settings.maxParallelSessions,
    installedPlugins: plugins.sanitize(db.settings.installedPlugins),
  };
}

// Capacity gating (max parallel `claude` children) lives in the task service so
// the REST routes and the MCP server enforce the same cap; these thin aliases
// keep the existing call sites readable.
const atCapacity = taskService.atCapacity;
const capacityError = taskService.capacityError;

// Map a linear.ts failure reason to an HTTP status + user-facing message.
function linearFail(res: Response, reason: linear.LinearReason): void {
  const map: Record<linear.LinearReason, [number, string]> = {
    'no-token': [400, 'Add your Linear API key in Settings first'],
    unauthorized: [401, 'Linear rejected the API key — check it in Settings'],
    'not-found': [404, 'Linear issue not found'],
    error: [502, 'Could not reach Linear — try again'],
  };
  const [code, message] = map[reason] || [502, 'Linear request failed'];
  err(res, code, message);
}

// Build a grooming task from a composed brief and kick off runner.groom — the
// single source of truth for the "create a grooming task and dispatch it" dance,
// shared by POST /api/briefs and the Linear import path. Like dispatch, the
// `grooming` status is entered only here (via runner.groom), never via PATCH.
// On a groom failure the task is rolled back to backlog and the error rethrown.
function startGrooming(repo: Repo, brief: string, model: unknown, extra?: Partial<Task>): Task {
  const task: Task = {
    id: id(),
    title: groomer.deriveTitle(brief),
    prompt: brief, // the composed brief, until grooming rewrites it
    brief, // preserved even after grooming (the drawer renders it)
    repoId: repo.id,
    repoName: repo.name,
    repoPath: repo.path,
    addons: [],
    personas: [],
    useWorktree: true,
    worktreePath: null,
    branchName: null,
    branch: null,
    model: (model as string) || 'default',
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
    ...extra,
  };
  db.tasks.push(task);
  save();
  broadcast({ type: 'task', task });

  try {
    runner.groom(task, brief);
  } catch (e) {
    task.status = 'backlog';
    task.lastOutcome = 'error';
    task.lastError = (e as Error).message;
    task.updatedAt = now();
    save();
    broadcast({ type: 'task', task });
    throw e;
  }
  return task;
}

// ---------- health ----------

app.get('/api/health', (req: Request, res: Response) => {
  execFile(runner.CLAUDE_BIN, ['--version'], { timeout: 10000 }, (e, stdout) => {
    res.json({
      ok: !e,
      claude: e ? null : stdout.trim(),
      error: e ? `claude CLI not found (${runner.CLAUDE_BIN})` : null,
      node: process.version,
      version: appVersion,
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
    settings: publicSettings(),
    // Live autonomous-session snapshot so a reconnecting board rebuilds its banner
    // (like pendingPermissions above, this is process-local and never persisted).
    autonomous: autonomous.status(),
  });
});

app.get('/api/events', (req: Request, res: Response) => sse(req, res));

// ---------- MCP server ----------

// Board control over MCP's Streamable HTTP transport, live for as long as Sr.
// Popo is running. An outside MCP client (e.g. `claude mcp add --transport http
// srpopo http://127.0.0.1:7777/mcp`) can list/create/dispatch/stop tasks through
// the same code paths as the REST API. See server/mcp.ts; localhost binding is
// the only security boundary, exactly as for /api.
app.post('/mcp', async (req: Request, res: Response) => {
  try {
    await mcp.handlePost(req, res);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: (e as Error).message } });
    }
  }
});
app.get('/mcp', (req: Request, res: Response) => mcp.handleUnsupported(res));
app.delete('/mcp', (req: Request, res: Response) => mcp.handleUnsupported(res));

// ---------- settings ----------

// User preferences (e.g. desktop notifications). Persisted in db.json and
// broadcast so every connected board — and the Electron shell — stays in sync.
app.get('/api/settings', (req: Request, res: Response) => res.json(publicSettings()));

app.patch('/api/settings', (req: Request, res: Response) => {
  if ('notifications' in req.body) db.settings.notifications = !!req.body.notifications;
  if ('sounds' in req.body) db.settings.sounds = !!req.body.sounds;
  // The Linear token is a secret: accept it here (trimmed) but never echo it back.
  if ('linearApiToken' in req.body) db.settings.linearApiToken = String(req.body.linearApiToken || '').trim();
  if ('maxParallelSessions' in req.body) {
    const n = Math.trunc(Number(req.body.maxParallelSessions));
    if (!Number.isFinite(n) || n < 1 || n > 20) {
      return err(res, 400, 'maxParallelSessions must be a whole number between 1 and 20');
    }
    db.settings.maxParallelSessions = n;
  }
  // Marketplace: the board sends the full desired set of installed plugin ids;
  // unknown ids are dropped so only real plugins can be toggled on.
  if ('installedPlugins' in req.body) db.settings.installedPlugins = plugins.sanitize(req.body.installedPlugins);
  save();
  const settings = publicSettings();
  broadcast({ type: 'settings', settings });
  res.json(settings);
});

// Catalog of optional task behaviors the UI renders as checkboxes.
app.get('/api/addons', (req: Request, res: Response) => res.json(addons.catalog()));

// Catalog of expert personas the UI renders as selectable role checkboxes.
app.get('/api/personas', (req: Request, res: Response) => res.json(personas.catalog()));

// Marketplace catalog. `installed` is the current set so the UI can render each
// plugin as installed/available; installing/uninstalling goes through PATCH
// /api/settings (installedPlugins), keeping settings' single writer.
app.get('/api/plugins', (req: Request, res: Response) =>
  res.json({ plugins: plugins.catalog(), installed: plugins.sanitize(db.settings.installedPlugins) }));

// ---------- autonomous mode (marketplace plugin) ----------

// The safe, UI-facing session snapshot (mirrors the /api/state annotation).
app.get('/api/autonomous', (req: Request, res: Response) => res.json(autonomous.status()));

// Start an autonomous session for one repo, capped at a dollar budget. Gated on
// the plugin being installed; one session at a time (a second start is a 409).
app.post('/api/autonomous/start', async (req: Request, res: Response) => {
  if (!plugins.sanitize(db.settings.installedPlugins).includes('autonomous')) {
    return err(res, 400, 'Install the Autonomous Mode plugin first');
  }
  const repo = getRepo(req.body.repoId);
  if (!repo) return err(res, 400, 'Unknown repo');
  const budgetUsd = Number(req.body.budgetUsd);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 1000) {
    return err(res, 400, 'budgetUsd must be a number between 0 and 1000');
  }
  if (autonomous.isActive()) return err(res, 409, 'Autonomous mode is already running');
  try {
    res.json(await autonomous.start({ repoId: repo.id, budgetUsd }));
  } catch (e) {
    err(res, 500, (e as Error).message);
  }
});

// Stop the active session: stop starting new tasks, let in-flight runs finish.
app.post('/api/autonomous/stop', (req: Request, res: Response) => res.json(autonomous.stop()));

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
    name: await git.displayName(repoPath),
    branch: await git.currentBranch(repoPath),
    addedAt: now(),
  };
  db.repos.push(repo);
  save();
  broadcast({ type: 'repos', repos: db.repos });
  res.json(repo);
});

// Live lookup of the repo's current checked-out branch — refreshed on demand
// (e.g. when the New Task / Brief modals open) rather than the snapshot taken
// when the repo was added, which can go stale as the user switches branches.
app.get('/api/repos/:id/branch', async (req: Request, res: Response) => {
  const repo = db.repos.find((r) => r.id === req.params.id);
  if (!repo) return err(res, 404, 'Repo not found');
  res.json({ branch: await git.currentBranch(repo.path) });
});

// Live worktree list for a repo, sourced from `git worktree list` (ground
// truth) rather than stored task.worktreePath values, which can go stale.
app.get('/api/repos/:id/worktrees', async (req: Request, res: Response) => {
  const repo = db.repos.find((r) => r.id === req.params.id);
  if (!repo) return err(res, 404, 'Repo not found');
  const entries = await git.listWorktrees(repo.path);
  const worktrees: WorktreeInfo[] = entries.map((e) => {
    const task = db.tasks.find((t) => t.worktreePath === e.path);
    return {
      path: e.path,
      branch: e.branch,
      dirty: e.dirty,
      files: e.files,
      taskId: task?.id ?? null,
      taskTitle: task?.title ?? null,
      taskStatus: task?.status ?? null,
    };
  });
  res.json({ worktrees });
});

// Removes a worktree by path, e.g. from the Workspace popover's live list.
// Unlike POST /api/tasks/:id/worktree/remove (which only clears a task's own
// worktree), this also handles orphaned worktrees that have no owning task
// (task deleted/archived while the worktree survived, or one created outside
// Sr. Popo). The path is checked against `git worktree list` for the repo
// first so this can't be pointed at an arbitrary filesystem path.
app.post('/api/repos/:id/worktrees/remove', async (req: Request, res: Response) => {
  const repo = db.repos.find((r) => r.id === req.params.id);
  if (!repo) return err(res, 404, 'Repo not found');
  const wtPath = String(req.body?.path || '');
  const live = await git.listWorktrees(repo.path);
  if (!live.some((w) => w.path === wtPath)) return err(res, 404, 'Worktree not found');
  const task = db.tasks.find((t) => t.worktreePath === wtPath);
  if (task && runner.isRunning(task.id)) return err(res, 409, 'Stop the task first');
  try {
    await git.removeWorktree(repo.path, wtPath);
    if (task) {
      task.worktreePath = null;
      task.updatedAt = now();
      broadcast({ type: 'task', task });
    }
    save();
    res.json({ ok: true });
  } catch (e) {
    err(res, 500, (e as Error).message);
  }
});

// Opens an in-app shell session rooted at the repo root or one of its live
// worktrees, so the user can drop into a terminal on the checkout they're
// viewing without leaving Sr. Popo. The starting path is validated against the
// repo root and `git worktree list` first so it can't be pointed at an
// arbitrary filesystem location. Returns the new session id; the board then
// streams it via GET /api/terminal/:id/stream.
app.post('/api/repos/:id/terminal', async (req: Request, res: Response) => {
  const repo = db.repos.find((r) => r.id === req.params.id);
  if (!repo) return err(res, 404, 'Repo not found');
  const target = req.body?.path ? String(req.body.path) : repo.path;
  if (target !== repo.path) {
    const live = await git.listWorktrees(repo.path);
    if (!live.some((w) => w.path === target)) return err(res, 404, 'Path not found');
  }
  const cols = Number(req.body?.cols) || 80;
  const rows = Number(req.body?.rows) || 24;
  try {
    const tid = terminal.create(target, cols, rows);
    res.json({ id: tid, cwd: target });
  } catch (e) {
    err(res, 500, (e as Error).message);
  }
});

// Live output stream for a shell session (SSE). Replays the buffered screen on
// connect, then streams raw output as base64 `data:` events. An empty event
// signals the shell exited.
app.get('/api/terminal/:tid/stream', (req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  const off = terminal.attach(req.params.tid, (b64) => res.write(`data: ${b64}\n\n`));
  if (!off) { res.write('event: gone\ndata: \n\n'); return res.end(); }
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(heartbeat); off(); });
});

app.post('/api/terminal/:tid/input', (req: Request, res: Response) => {
  const ok = terminal.write(req.params.tid, String(req.body?.data ?? ''));
  if (!ok) return err(res, 404, 'Session not found');
  res.json({ ok: true });
});

app.post('/api/terminal/:tid/resize', (req: Request, res: Response) => {
  const cols = Number(req.body?.cols) || 80;
  const rows = Number(req.body?.rows) || 24;
  terminal.resize(req.params.tid, cols, rows);
  res.json({ ok: true });
});

app.post('/api/terminal/:tid/close', (req: Request, res: Response) => {
  terminal.close(req.params.tid);
  res.json({ ok: true });
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
  try {
    res.json(taskService.createTask(req.body));
  } catch (e) {
    err(res, 400, (e as Error).message);
  }
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
  if (atCapacity()) return err(res, 409, capacityError());

  try {
    const branchName = req.body.branchName ? String(req.body.branchName).trim() : null;
    res.json(startGrooming(repo, brief, req.body.model, { branchName }));
  } catch (e) {
    err(res, 500, (e as Error).message);
  }
});

// ---------- linear (import a Linear issue as a groomed task) ----------

// The current viewer's assigned issues, for the "browse my issues" list. Typed,
// non-throwing: a missing token / auth failure / network error maps to a 4xx/5xx
// the UI can show rather than crashing.
app.get('/api/linear/issues', async (req: Request, res: Response) => {
  const result = await linear.listMyIssues();
  if (!result.ok) return linearFail(res, result.reason);
  res.json({ issues: result.issues });
});

// Turn a Linear issue (by UUID or identifier like ABC-123) into a groomed task.
// Fetches the issue server-side, composes a brief from it, and routes it through
// the same grooming pipeline as POST /api/briefs.
app.post('/api/linear/briefs', async (req: Request, res: Response) => {
  const repo = getRepo(req.body.repoId);
  if (!repo) return err(res, 400, 'Unknown repo');
  const issueId = String(req.body.issueId || '').trim();
  if (!issueId) return err(res, 400, 'issueId is required');
  if (atCapacity()) return err(res, 409, capacityError());

  const result = await linear.getIssue(issueId);
  if (!result.ok) return linearFail(res, result.reason);

  const brief = linear.briefFromIssue(result.issue);
  // Default the branch to the issue's own identifier (e.g. "abc-123") so it
  // matches whatever convention the team already uses in Linear/GitHub; an
  // explicit branchName from the caller still wins.
  const branchName = req.body.branchName
    ? String(req.body.branchName).trim()
    : slugify(result.issue.identifier);
  try {
    res.json(startGrooming(repo, brief, req.body.model, {
      linearIssue: { identifier: result.issue.identifier, url: result.issue.url },
      branchName,
    }));
  } catch (e) {
    err(res, 500, (e as Error).message);
  }
});

app.patch('/api/tasks/:id', (req: Request, res: Response) => {
  const task = getTask(req.params.id);
  if (!task) return err(res, 404, 'Task not found');
  if (runner.isRunning(task.id)) return err(res, 409, 'Task is running; stop it first');

  const allowed = ['title', 'prompt', 'model', 'permissionMode', 'allowedTools', 'promptPermissions', 'useWorktree', 'branchName', 'status', 'addons', 'personas'] as const;
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
      } else if (key === 'branchName') {
        // Branch is fixed once the worktree is materialized; ignore edits after that.
        if (!task.worktreePath) task.branchName = req.body.branchName ? String(req.body.branchName).trim() : null;
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
  if (atCapacity()) return err(res, 409, capacityError());

  try {
    await taskService.dispatchTask(task, req.body && req.body.message ? String(req.body.message) : null);
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

// Merge the task's open PR via `gh pr merge`. Used by the "Move to Done" flow so
// a task can be wrapped up — merge, then optionally drop its worktree — in one
// step. Non-throwing at the github layer; a failed merge maps to a 502 the board
// surfaces as a toast (an already-merged PR just succeeds).
app.post('/api/tasks/:id/pr/merge', async (req: Request, res: Response) => {
  const task = getTask(req.params.id);
  if (!task) return err(res, 404, 'Task not found');
  const result = await github.mergePrForTask(task);
  if (!result.ok) return err(res, 502, result.message || 'Could not merge the pull request');
  res.json({ ok: true, alreadyMerged: !!result.alreadyMerged });
});

app.get('/api/tasks/:id/worktree/status', async (req: Request, res: Response) => {
  const task = getTask(req.params.id);
  if (!task || !task.worktreePath) return err(res, 404, 'No worktree');
  res.json((await git.worktreeStatus(task.worktreePath)) || {});
});

// Repos added before "org/repo" naming existed only have a bare directory name
// (no "/"). Best-effort upgrade them from their `origin` remote on boot so
// older db.json files pick up the new label without a manual re-add.
async function backfillRepoNames(): Promise<void> {
  let changed = false;
  for (const repo of db.repos) {
    if (repo.name.includes('/')) continue;
    const name = await git.displayName(repo.path);
    if (name !== repo.name) {
      repo.name = name;
      changed = true;
    }
  }
  if (changed) {
    save();
    broadcast({ type: 'repos', repos: db.repos });
  }
}

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
      backfillRepoNames();
    });
    server.on('error', reject);
  });
}

export { app, start, runner, terminal };

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
