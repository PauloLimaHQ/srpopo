/*
 * Sr. Popo board MCP server — exposes the Kanban board to any MCP client while
 * Sr. Popo is running. Unlike the per-task permission bridge (permission-mcp.js,
 * a stdio process the CLI spawns), this one is mounted straight onto the running
 * Express app at `POST /mcp` using MCP's Streamable HTTP transport, so an outside
 * agent session (or any MCP client) can list, create, dispatch, and stop
 * tasks over localhost:
 *
 *   claude mcp add --transport http srpopo http://127.0.0.1:7777/mcp
 *
 * It reaches the same store/runner code paths as the REST API (via server/tasks.ts),
 * so a task queued over MCP is identical to one queued from the board. There is no
 * auth layer — the server binds `127.0.0.1` only, which is the security boundary,
 * exactly as the REST API relies on (see the invariants in CLAUDE.md).
 *
 * The transport is deliberately hand-rolled (newline-free JSON-RPC 2.0 over a
 * single POST) to keep Sr. Popo dependency-light. `respond(msg, call)` builds one
 * JSON-RPC reply (or null for a notification) and takes an injectable tool caller
 * so the protocol layer is unit-testable without touching the store.
 */
import type { Request, Response } from 'express';

import { db, save, now, getTask, readLog } from './store';
import * as runner from './runner';
import * as permissions from './permissions';
import * as tasks from './tasks';
import { broadcast } from './bus';
import type { Repo, Task } from './types';

// The latest transport spec we implement; we echo the client's requested version
// on initialize when it sends one (forward-compatible), like permission-mcp.js.
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'srpopo', version: '1.0.0' };
const INSTRUCTIONS =
  'Sr. Popo orchestrates coding-agent tasks on a local Kanban board. Use list_repos ' +
  'to find a registered repo id, then list_tasks/get_task to inspect work, ' +
  'create_task to queue a prompt, and dispatch_task to run it. Each task runs on its ' +
  'own agent backend (claude or codex). Dispatching spawns a real agent session on ' +
  'the user\'s machine — confirm intent before starting runs.';

// One MCP tool: its advertised schema plus the id of the arguments it reads.
const TOOL_DEFS = [
  {
    name: 'list_repos',
    description: 'List the git repositories registered in Sr. Popo (id, name, path, branch).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_tasks',
    description:
      'List tasks on the board as compact summaries. Optionally filter by status ' +
      '(backlog/ready/running/grooming/review/done/failed) and/or repoId. Archived ' +
      'tasks are excluded unless includeArchived is true.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Only tasks in this board column.' },
        repoId: { type: 'string', description: 'Only tasks for this repo.' },
        includeArchived: { type: 'boolean', description: 'Include archived tasks (default false).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_task',
    description:
      'Get one task in full, plus a tail of its session log (default 50 events) and ' +
      'any live tool-approval prompts waiting on the user.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task id.' },
        logLimit: { type: 'number', description: 'How many trailing log events to include (0 = all, max 500).' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_task',
    description:
      'Queue a new task. Created in backlog by default; pass status "ready" to stage ' +
      'it for dispatch. Does not run it — call dispatch_task for that.',
    inputSchema: {
      type: 'object',
      properties: {
        repoId: { type: 'string', description: 'Target repo id (see list_repos).' },
        title: { type: 'string', description: 'Short task title.' },
        prompt: { type: 'string', description: 'The prompt the agent will run.' },
        agent: { type: 'string', description: 'Which backend runs the task: "claude" (default) or "codex".' },
        model: { type: 'string', description: 'A model for the chosen agent, or "default" for its account default. Claude: sonnet / opus / haiku / fable, or a custom model id configured in Settings. Codex: e.g. gpt-5.2-codex.' },
        useWorktree: { type: 'boolean', description: 'Run isolated on a srpopo/<slug> worktree branch.' },
        permissionMode: { type: 'string', description: 'acceptEdits (default), bypassPermissions, plan, or default. On codex these map to a sandbox level rather than per-tool prompts.' },
        status: { type: 'string', description: '"ready" to stage for dispatch, otherwise backlog.' },
        branchName: { type: 'string', description: 'Override the auto-generated worktree branch name.' },
        baseBranch: { type: 'string', description: 'Branch to base the task on (worktree start point, or checked out for a direct run). Defaults to the repo\'s current HEAD.' },
        promptPermissions: { type: 'boolean', description: 'Ask before running unapproved tools (default true).' },
        allowedTools: { type: 'string', description: 'Comma/newline list of auto-approved tool patterns.' },
        addons: { type: 'array', items: { type: 'string' }, description: 'Add-on ids (see the board).' },
        prDraft: { type: 'boolean', description: 'When the "pull_request" addon is selected, open the PR as a draft instead of ready for review.' },
        personas: { type: 'array', items: { type: 'string' }, description: 'Persona ids (see the board).' },
      },
      required: ['repoId', 'title', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'dispatch_task',
    description:
      'Run a task: spawn its agent session (materializing a worktree first if the ' +
      'task uses one). With a message, resumes the task\'s existing session as a ' +
      'follow-up; otherwise runs its prompt fresh.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task id.' },
        message: { type: 'string', description: 'Follow-up message to resume an existing session with.' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'stop_task',
    description: 'Stop a running task\'s agent session.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'The task id.' } },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
];

// The board-facing view of a repo (mirrors what the REST /api/state exposes).
function repoView(r: Repo): unknown {
  return { id: r.id, name: r.name, path: r.path, branch: r.branch };
}

// A compact task summary for list_tasks — the hot fields, without the full prompt
// or log, so listings stay small.
function taskSummary(t: Task): unknown {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    repoId: t.repoId,
    repoName: t.repoName,
    useWorktree: t.useWorktree,
    worktreePath: t.worktreePath,
    baseBranch: t.baseBranch,
    branch: t.branch,
    costUsd: t.costUsd,
    runCount: t.runCount,
    lastOutcome: t.lastOutcome,
    lastError: t.lastError,
    updatedAt: t.updatedAt,
  };
}

// Wrap a tool's payload in the MCP tool-result shape (JSON as a text block).
function textResult(data: unknown): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }] };
}

// The real tool executor. Throws a plain Error on any failure; respond() turns
// that into an MCP `isError` tool result so the client sees the message.
async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'list_repos':
      return textResult(db.repos.map(repoView));

    case 'list_tasks': {
      const includeArchived = !!args.includeArchived;
      const status = args.status ? String(args.status) : null;
      const repoId = args.repoId ? String(args.repoId) : null;
      const list = db.tasks.filter(
        (t) =>
          (includeArchived || !t.archived) &&
          (!status || t.status === status) &&
          (!repoId || t.repoId === repoId),
      );
      return textResult(list.map(taskSummary));
    }

    case 'get_task': {
      const task = getTask(String(args.taskId ?? ''));
      if (!task) throw new Error('Task not found');
      // Default to the last 50 events; clamp to a sane ceiling so a huge session
      // log can't balloon a single response. 0 means "all".
      const raw = args.logLimit === undefined ? 50 : Math.trunc(Number(args.logLimit));
      const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 500) : 50;
      const events = readLog(task.id);
      const tail = limit > 0 ? events.slice(-limit) : events;
      return textResult({
        task: { ...task, pendingPermissions: permissions.listForTask(task.id) },
        events: tail,
      });
    }

    case 'create_task':
      return textResult(tasks.createTask(args));

    case 'dispatch_task': {
      const task = getTask(String(args.taskId ?? ''));
      if (!task) throw new Error('Task not found');
      if (runner.isRunning(task.id)) throw new Error('Task is already running');
      if (tasks.atCapacity()) throw new Error(tasks.capacityError());
      try {
        await tasks.dispatchTask(task, args.message != null ? String(args.message) : null);
      } catch (e) {
        // Mirror the REST dispatch route: a launch failure marks the task failed.
        task.status = 'failed';
        task.lastOutcome = 'error';
        task.lastError = (e as Error).message;
        task.updatedAt = now();
        save();
        broadcast({ type: 'task', task });
        throw e;
      }
      return textResult({ ok: true, task: taskSummary(task) });
    }

    case 'stop_task': {
      const task = getTask(String(args.taskId ?? ''));
      if (!task) throw new Error('Task not found');
      if (!runner.stop(task.id)) throw new Error('Task is not running');
      return textResult({ ok: true });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// A single JSON-RPC message the client is `params`-shaped enough to answer.
interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
}

// Build the JSON-RPC reply for one incoming message, or null for messages that
// take no reply (notifications). `call` runs a tool and is injectable for tests.
async function respond(msg: RpcMessage, call: typeof callTool = callTool): Promise<object | null> {
  const { id, method, params } = msg || {};
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOL_DEFS } };
    case 'tools/call': {
      const name = (params && params.name) || '';
      if (!TOOL_DEFS.some((t) => t.name === name)) {
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true },
        };
      }
      try {
        const result = await call(name, (params && params.arguments) || {});
        return { jsonrpc: '2.0', id, result };
      } catch (e) {
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true },
        };
      }
    }
    default:
      // Notifications (no id) and unknown methods: ack nothing / report not-found.
      if (method && method.startsWith('notifications/')) return null;
      if (id === undefined || id === null) return null;
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// POST /mcp — the Streamable HTTP transport endpoint. The body is a single
// JSON-RPC message (or a batch array). We answer requests with a plain JSON
// response and reply 202 when a batch carries only notifications. This server is
// stateless (no Mcp-Session-Id), so a client just POSTs each message.
async function handlePost(req: Request, res: Response): Promise<void> {
  const body = req.body;
  const batch = Array.isArray(body);
  const messages: RpcMessage[] = batch ? body : [body];
  const replies: object[] = [];
  for (const message of messages) {
    const reply = await respond(message);
    if (reply) replies.push(reply);
  }
  if (!replies.length) {
    // Nothing to return (all notifications / responses) — acknowledge and close.
    res.status(202).end();
    return;
  }
  res.json(batch ? replies : replies[0]);
}

// GET/DELETE /mcp — we don't offer a server-initiated SSE stream or sessions, so
// per the spec we reject these with 405.
function handleUnsupported(res: Response): void {
  res.status(405).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method Not Allowed' } });
}

export { respond, callTool, handlePost, handleUnsupported, TOOL_DEFS, PROTOCOL_VERSION, SERVER_INFO };
