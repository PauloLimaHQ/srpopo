/*
 * Shared types for Sr. Popo's Node-side code. These describe the persisted data
 * (repos/tasks/settings) and the small message/decision shapes that flow between
 * the runner, the permission bridge, and the SSE bus. Typing is additive — it
 * mirrors the objects the code already builds; it does not change any behavior.
 */

export interface Settings {
  notifications: boolean;
}

export interface Repo {
  id: string;
  path: string;
  name: string;
  branch: string | null;
  addedAt: string;
}

export type TaskStatus =
  | 'backlog'
  | 'ready'
  | 'running'
  | 'grooming'
  | 'review'
  | 'done'
  | 'failed';

export interface Task {
  id: string;
  title: string;
  prompt: string;
  // The original rough idea, present only on tasks created via "Brief an Idea".
  brief?: string;
  repoId: string;
  repoName: string;
  repoPath: string;
  addons: string[];
  personas: string[];
  useWorktree: boolean;
  worktreePath: string | null;
  branch: string | null;
  model: string;
  permissionMode: string;
  allowedTools: string;
  promptPermissions: boolean;
  status: TaskStatus;
  sessionId: string | null;
  resolvedModel: string | null;
  costUsd: number;
  numTurns: number | null;
  durationMs: number | null;
  runCount: number;
  activeSubagents: number;
  lastOutcome: string | null;
  lastError: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  // Annotated onto GET /api/state responses so a reconnecting board rebuilds any
  // live tool-approval prompts. Never persisted to db.json.
  pendingPermissions?: PublicPermissionRequest[];
}

export interface Db {
  repos: Repo[];
  tasks: Task[];
  settings: Settings;
}

// A single line in a task's NDJSON session log / SSE timeline. `type` names the
// kind of event; the rest is a loose bag mirroring the CLI's stream-json shapes
// and the small synthetic events the runner emits.
export interface LogEvent {
  type: string;
  ts?: string;
  [key: string]: unknown;
}

// The decision contract the `claude` CLI expects back from a permission-prompt
// tool: allow (optionally with edited input) or deny (with a reason).
export interface AllowDecision {
  behavior: 'allow';
  updatedInput?: Record<string, unknown>;
}
export interface DenyDecision {
  behavior: 'deny';
  message?: string;
}
export type Decision = AllowDecision | DenyDecision;

// The safe, UI-facing view of a pending tool-approval request.
export interface PublicPermissionRequest {
  id: string;
  taskId: string;
  toolName: string;
  input: unknown;
  createdAt: string;
}

// The small pull-request shape github.parsePrList normalizes a `gh` payload into.
export interface PrInfo {
  number: number;
  url: string;
  title: string;
  state: string;
  isDraft: boolean;
  updatedAt: string | null;
}
