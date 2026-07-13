/*
 * Interactive tool-permission prompts for headless runs.
 *
 * When a task opts into "ask before running tools", `runner` points the `claude`
 * CLI at a tiny MCP bridge (`permission-mcp.js`) via `--permission-prompt-tool`.
 * Any tool call that isn't already auto-approved (allow-list, add-on tools, or an
 * `acceptEdits` edit) is routed to that bridge, which POSTs it to the server; the
 * request lands here as a pending approval the user resolves from the board.
 *
 * This module is the single in-memory registry of those pending approvals. It is
 * deliberately process-local: a pending prompt only makes sense while its `claude`
 * child is alive, so nothing is persisted — if the server restarts, the child is
 * already gone and the prompt is moot.
 *
 * A decision is the shape the CLI expects back from a permission-prompt tool:
 *   { behavior: 'allow', updatedInput?: object }  — run it (optionally with edits)
 *   { behavior: 'deny', message: string }         — refuse, with a reason
 */
import { broadcast } from './bus';
import { id, now, appendLog } from './store';
import type { Decision, LogEvent, PublicPermissionRequest } from './types';

interface PendingEntry {
  id: string;
  taskId: string;
  toolName: string;
  input: unknown;
  createdAt: string;
  settled: boolean;
  resolve: ((decision: Decision) => void) | null;
  timer: NodeJS.Timeout | null;
}

// taskId -> Map(requestId -> entry). entry carries the resolver + timeout so a
// decision (from the UI), an abandon (bridge disconnect), or a task stop can all
// settle the same promise exactly once.
const byTask = new Map<string, Map<string, PendingEntry>>();

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // auto-deny an unanswered prompt after 30m
let timeoutMs = DEFAULT_TIMEOUT_MS;

function bucket(taskId: string): Map<string, PendingEntry> {
  let m = byTask.get(taskId);
  if (!m) {
    m = new Map();
    byTask.set(taskId, m);
  }
  return m;
}

// The safe, UI-facing view of a pending request (no resolver/timer).
function toPublic(e: PendingEntry): PublicPermissionRequest {
  return { id: e.id, taskId: e.taskId, toolName: e.toolName, input: e.input, createdAt: e.createdAt };
}

// Mirror runner.record: persist to the task log and push it live to the drawer.
function logEvent(taskId: string, event: LogEvent): void {
  event.ts = event.ts || now();
  appendLog(taskId, event);
  broadcast({ type: 'log', taskId, event });
}

/**
 * Register a pending approval. Returns `{ id, promise }`; the promise resolves
 * with a decision object once the user decides, the bridge disconnects, the task
 * stops, or the timeout fires — whichever comes first.
 */
function create(taskId: string, toolName: string, input: unknown): { id: string; promise: Promise<Decision> } {
  const reqId = id();
  const entry: PendingEntry = { id: reqId, taskId, toolName: String(toolName || 'tool'), input, createdAt: now(), settled: false, resolve: null, timer: null };
  const promise = new Promise<Decision>((resolve) => { entry.resolve = resolve; });
  bucket(taskId).set(reqId, entry);

  entry.timer = setTimeout(
    () => settle(taskId, reqId, { behavior: 'deny', message: 'Timed out waiting for approval' }, 'timeout'),
    timeoutMs,
  );
  if (entry.timer.unref) entry.timer.unref();

  broadcast({ type: 'permission', action: 'request', taskId, request: toPublic(entry) });
  return { id: reqId, promise };
}

// Resolve a pending request exactly once and broadcast/log the outcome.
function settle(taskId: string, reqId: string, decision: Decision, reason: string): boolean {
  const m = byTask.get(taskId);
  const entry = m && m.get(reqId);
  if (!entry || entry.settled) return false;
  entry.settled = true;
  if (entry.timer) clearTimeout(entry.timer);
  m!.delete(reqId);
  if (m!.size === 0) byTask.delete(taskId);

  if (entry.resolve) entry.resolve(decision);
  logEvent(taskId, { type: 'permission', toolName: entry.toolName, decision, reason });
  broadcast({ type: 'permission', action: 'resolved', taskId, requestId: reqId, decision, reason });
  return true;
}

// The user's answer from the board. Normalizes to the CLI's decision contract.
function decide(
  taskId: string,
  reqId: string,
  { behavior, message, updatedInput }: { behavior?: string; message?: string; updatedInput?: unknown } = {},
): boolean {
  const decision: Decision = behavior === 'allow'
    ? { behavior: 'allow', ...(updatedInput && typeof updatedInput === 'object' ? { updatedInput: updatedInput as Record<string, unknown> } : {}) }
    : { behavior: 'deny', message: message || 'Denied by user' };
  return settle(taskId, reqId, decision, 'decided');
}

// The bridge connection dropped before a decision (the claude child went away).
function abandon(taskId: string, reqId: string): boolean {
  return settle(taskId, reqId, { behavior: 'deny', message: 'Session ended before approval' }, 'abandoned');
}

// Deny every pending request for a task — used when a run is stopped or exits so
// no promise is left hanging and the UI clears its prompts.
function rejectForTask(taskId: string, message = 'Run ended'): void {
  const m = byTask.get(taskId);
  if (!m) return;
  for (const reqId of [...m.keys()]) settle(taskId, reqId, { behavior: 'deny', message }, 'ended');
}

function listForTask(taskId: string): PublicPermissionRequest[] {
  const m = byTask.get(taskId);
  return m ? [...m.values()].map(toPublic) : [];
}

// Test seam: shorten the auto-deny timeout so tests don't wait 30 minutes.
function _setTimeoutMs(ms: number): void {
  timeoutMs = ms;
}

export {
  create,
  decide,
  abandon,
  rejectForTask,
  listForTask,
  DEFAULT_TIMEOUT_MS,
  _setTimeoutMs,
};
