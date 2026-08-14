/*
 * Task lifecycle service — the single source of truth for *creating* and
 * *dispatching* a task, shared by the REST API (server/index.ts) and the MCP
 * server (server/mcp.ts) so both entry points build tasks and spawn runs
 * identically. Keeping this here means a task queued over MCP is byte-for-byte
 * the same as one queued from the board.
 *
 * HTTP/protocol concerns (status codes, JSON-RPC shapes) stay with the callers;
 * this module only touches the store, git, and the runner.
 */
import { db, save, id, now, getRepo } from './store';
import { broadcast } from './bus';
import * as addons from './addons';
import * as personas from './personas';
import * as git from './git';
import * as runner from './runner';
import * as framing from './framing';
import * as repoSettings from './repoSettings';
import type { RepoSettings, Task, TaskAgent } from './types';

// Which backends a task may run against (see server/agents/*). Anything else
// falls back to the default so a stray value can't produce an unrunnable task.
const AGENTS: TaskAgent[] = ['claude', 'codex', 'grok'];
export function sanitizeAgent(value: unknown): TaskAgent {
  return AGENTS.includes(value as TaskAgent) ? (value as TaskAgent) : 'claude';
}
// Is this a backend we can actually run? Used by PATCH /api/tasks/:id, which must
// leave a task's agent alone rather than silently reset it to the default.
export function isAgent(value: unknown): value is TaskAgent {
  return AGENTS.includes(value as TaskAgent);
}

// The user-supplied fields a new task is built from. Everything is validated /
// sanitized here, so callers can pass a raw request body straight through.
export interface CreateTaskInput {
  title?: unknown;
  prompt?: unknown;
  repoId?: unknown;
  agent?: unknown;
  model?: unknown;
  useWorktree?: unknown;
  permissionMode?: unknown;
  status?: unknown;
  addons?: unknown;
  prDraft?: unknown;
  autoCodeReview?: unknown;
  personas?: unknown;
  autoPersona?: unknown;
  allowedTools?: unknown;
  branchName?: unknown;
  baseBranch?: unknown;
  promptPermissions?: unknown;
}

// True once dispatched runs + grooming sessions together hit the configured cap
// — checked right before spawning a new `claude` child so a dispatch fails fast
// with a clear message instead of silently piling up and starving each run of
// CPU / hitting subscription rate limits.
export function atCapacity(): boolean {
  return runner.runningCount() >= (db.settings.maxParallelSessions || 1);
}

export function capacityError(): string {
  return `Max parallel sessions reached (${runner.runningCount()}/${db.settings.maxParallelSessions} running). ` +
    'Stop a running task or raise the limit in Settings.';
}

// Fields a workspace can supply a default for. Every one of them exists on both
// CreateTaskInput and RepoSettings, so the two can be read through one helper.
type SharedField = keyof RepoSettings & keyof CreateTaskInput;

// Create a task in `backlog` (or `ready`), persist it, and broadcast it to every
// connected board. Throws a plain Error on invalid input; the caller maps that
// to a 4xx (REST) or a tool error (MCP).
export function createTask(input: CreateTaskInput): Task {
  const prompt = String(input.prompt ?? '');
  if (!prompt.trim()) throw new Error('prompt is required');
  // No title is required up front: a blank one is derived from the prompt's
  // first line, so creating a task never costs an LLM call just for a label.
  const title = String(input.title ?? '').trim() || framing.deriveTitle(prompt);
  const repo = getRepo(String(input.repoId ?? ''));
  if (!repo) throw new Error('Unknown repo');

  // The workspace's own defaults (server/repoSettings.ts) fill in only the
  // fields the caller left out — `'key' in input`, not truthiness, mirroring the
  // `promptPermissions` idiom below. The board always sends every field
  // explicitly, so its own prefill is what the user sees; lean callers (MCP
  // create_task and friends) omit most keys and inherit the workspace defaults.
  // The final fallbacks after `pick` are unchanged from before this existed.
  const ws = repoSettings.forRepo(repo.id);
  const pick = (key: SharedField): unknown => (key in input ? input[key] : ws[key]);
  const baseBranch = pick('baseBranch');

  const task: Task = {
    id: id(),
    title,
    prompt,
    repoId: repo.id,
    repoName: repo.name,
    repoPath: repo.path,
    agent: sanitizeAgent(pick('agent')),
    addons: addons.sanitize(pick('addons')),
    prDraft: !!input.prDraft,
    // Opt-in per task (off by default): grade the branch in the Code Review stage
    // when the run finishes, instead of going straight to validation.
    autoCodeReview: !!pick('autoCodeReview'),
    personas: personas.sanitize(pick('personas')),
    autoPersona: !!pick('autoPersona'),
    attachments: [],
    useWorktree: !!pick('useWorktree'),
    worktreePath: null,
    branchName: input.branchName ? String(input.branchName).trim() : null,
    baseBranch: baseBranch ? String(baseBranch).trim() : null,
    branch: null,
    model: (pick('model') as string) || 'default',
    permissionMode: (pick('permissionMode') as string) || 'acceptEdits',
    allowedTools: runner.normalizeAllowedTools(pick('allowedTools')),
    // Ask the user to approve otherwise-denied tools instead of silently finishing
    // without running them. Defaults on; opt out for fully-unattended runs.
    promptPermissions: 'promptPermissions' in input ? !!input.promptPermissions : true,
    status: input.status === 'ready' ? 'ready' : 'backlog',
    sessionId: null,
    resolvedModel: null,
    costUsd: 0,
    numTurns: null,
    durationMs: null,
    modelUsage: {},
    runCount: 0,
    activeSubagents: 0,
    lastOutcome: null,
    lastError: null,
    resolvingConflicts: false,
    archived: false,
    createdAt: now(),
    updatedAt: now(),
    startedAt: null,
    finishedAt: null,
  };
  db.tasks.push(task);
  save();
  broadcast({ type: 'task', task });
  return task;
}

// Materialize the task's worktree lazily (on first dispatch) then spawn the run.
// A `message` on a task that already has a session resumes it as a follow-up
// (`claude --resume`); otherwise the framed task prompt runs fresh. The runner
// flips the task to `running` and streams the session.
export async function dispatchTask(task: Task, message?: string | null): Promise<void> {
  if (task.useWorktree && !task.worktreePath) {
    const slug = framing.slugify(task.title);
    // Precedence for the branch name: the task's own override, then the
    // workspace's branch convention, then git.addWorktree's built-in
    // `srpopo/<slug>-<id>` (left untouched as the last resort). Every path that
    // dispatches a task — REST, MCP, Autonomous Mode, orchestrator workers,
    // grooming-spawned tasks — comes through here, so this is the only place
    // the convention needs applying.
    const template = repoSettings.forRepo(task.repoId).branchTemplate;
    const branchName = task.branchName
      || (template ? repoSettings.resolveBranchName(template, { slug, id: task.id }) : null);
    const { wtPath, branch } = await git.addWorktree(
      task.repoPath,
      task.id,
      slug,
      branchName,
      task.baseBranch,
    );
    task.worktreePath = wtPath;
    task.branch = branch;
    save();
  } else if (!task.useWorktree && task.baseBranch) {
    // Direct run: put the repo on the chosen branch first, but only when it
    // isn't already there — git errors loudly (dirty tree, branch busy in
    // another worktree) rather than clobbering anything.
    const current = await git.currentBranch(task.repoPath);
    if (current !== task.baseBranch) await git.checkoutBranch(task.repoPath, task.baseBranch);
  }
  const followUp = message ? String(message) : null;
  if (followUp && task.sessionId) {
    runner.dispatch(task, followUp, { resume: true });
  } else {
    // Fresh run of the task prompt — framed (personas + prompt + add-ons +
    // attachments) the same way the autonomous engine frames it.
    runner.dispatch(task, framing.framePrompt(task), { resume: false });
  }
}
