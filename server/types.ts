/*
 * Shared types for Sr. Popo's Node-side code. These describe the persisted data
 * (repos/tasks/settings) and the small message/decision shapes that flow between
 * the runner, the permission bridge, and the SSE bus. Typing is additive — it
 * mirrors the objects the code already builds; it does not change any behavior.
 */

export interface Settings {
  notifications: boolean;
  sounds: boolean;
  // Linear personal API key, used to import issues. A secret: it lives only in
  // db.json and is never returned to the board (see PublicSettings).
  linearApiToken: string;
  // Caps how many `claude` child processes (dispatched runs + grooming sessions
  // combined) may be alive at once. Dispatch/groom reject once the cap is hit
  // rather than queuing — see runner.runningCount and index.ts's atCapacity.
  maxParallelSessions: number;
  // Ids of plugins the user installed from the marketplace (see server/plugins.ts).
  // A plugin's features (e.g. the "From Linear" import) only surface once it's here.
  installedPlugins: string[];
  // When on, a task sitting in `review` whose PR has merge conflicts with main is
  // automatically resumed with an instruction to resolve them (see
  // server/conflicts.ts). Applies to plain review-column tasks and to Autonomous
  // Mode's own merge-safety check alike. Opt-in: off by default since it silently
  // spawns a new `claude` run.
  autoResolveConflicts: boolean;
}

// The redacted, board-facing view of Settings. Omits the raw Linear token and
// exposes only a derived boolean so the UI can show configured/not-configured
// without ever holding the secret.
export interface PublicSettings {
  notifications: boolean;
  sounds: boolean;
  linearConfigured: boolean;
  maxParallelSessions: number;
  installedPlugins: string[];
  autoResolveConflicts: boolean;
}

// A marketplace plugin as the UI lists it. The full catalog lives in
// server/plugins.ts; this is the board-facing shape (no secrets).
export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  icon: string;
  docsUrl?: string;
  // Whether the plugin needs an API key configured after install (Linear does).
  requiresApiKey: boolean;
}

export interface Repo {
  id: string;
  path: string;
  name: string;
  branch: string | null;
  addedAt: string;
}

// A live worktree on disk for a repo, as reported by `git worktree list`
// (ground truth — a task's own `worktreePath` can go stale). Cross-referenced
// against db.tasks by path to attach the owning task, if any.
export interface WorktreeInfo {
  path: string;
  branch: string | null;
  dirty: boolean;
  files: number;
  taskId: string | null;
  taskTitle: string | null;
  taskStatus: TaskStatus | null;
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
  // Origin pointer for tasks imported from a Linear issue, so the drawer can
  // link back to it. Present only on the Linear import path.
  linearIssue?: { identifier: string; url: string };
  repoId: string;
  repoName: string;
  repoPath: string;
  addons: string[];
  personas: string[];
  // Files the user attached; bytes live under DATA_DIR/attachments/<id>/<name>,
  // managed only through the upload/delete routes (never the PATCH allowlist).
  attachments?: Attachment[];
  useWorktree: boolean;
  worktreePath: string | null;
  // User-editable override for the worktree branch name (e.g. to match a repo's
  // own branch convention or reuse a Linear issue's identifier). Only takes
  // effect up to the point the worktree is materialized; null falls back to the
  // auto-generated `srpopo/<slug>-<id>` name.
  branchName: string | null;
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
  // True while server/conflicts.ts has resumed this task's session to resolve a
  // merge conflict with main. The task's `status` stays 'running' for that resume
  // run (it's a real claude session); this is the separate "Resolving Conflicts"
  // label the board renders on top of it. Cleared once that run lands back in
  // review/failed/ready, same as the runner would for any other resume.
  resolvingConflicts: boolean;
  // Annotated onto GET /api/state responses so a reconnecting board rebuilds any
  // live tool-approval prompts. Never persisted to db.json.
  pendingPermissions?: PublicPermissionRequest[];
}

// A file attached to a task. `name` is the stored (sanitized) basename under
// DATA_DIR/attachments/<taskId>/; `size` is the byte length as written.
export interface Attachment {
  name: string;
  size: number;
  addedAt: string;
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

// How safe a task's PR is to merge, as github.classifyPrCheck decides it:
//   green     — open, not draft, mergeable, no failing/pending checks → safe to merge
//   pending   — checks still running (or mergeability not yet computed) → wait
//   failing   — at least one check failed → never merge
//   conflicts — merge conflicts with the base branch (GitHub's CONFLICTING/DIRTY) →
//               server/conflicts.ts can auto-resume the session to resolve them
//   blocked   — draft, closed/merged, branch-protection-blocked/behind, or
//               otherwise not mergeable for a reason a resume can't fix
//   no-pr     — no branch / no PR / the `gh` lookup itself failed
export type PrCheckStatus = 'green' | 'pending' | 'failing' | 'conflicts' | 'blocked' | 'no-pr';

// The result of github.prCheckForTask: the classification plus the PR it looked
// at (if any) and, when the lookup failed, the classifyError reason.
export interface PrCheck {
  status: PrCheckStatus;
  reason?: string;
  pr?: PrInfo | null;
}

// One task the Autonomous Mode engine currently owns, as the UI shows it.
export interface AutonomousTaskView {
  id: string;
  title: string;
  status: TaskStatus;
  costUsd: number;
  running: boolean;
  resolvingConflicts: boolean;
}

// The safe, UI-facing snapshot of the autonomous session (see server/autonomous.ts).
// Annotated onto GET /api/state and broadcast as `{ type: 'autonomous', status }`.
export interface AutonomousStatus {
  active: boolean;
  repoId: string | null;
  repoName: string | null;
  budgetUsd: number | null;
  spentUsd: number;
  startedAt: string | null;
  // True once a user stop was requested but in-flight runs are still finishing.
  stopping: boolean;
  // Why the session last changed state (e.g. 'started', 'budget-reached',
  // 'drained', 'stopped') — surfaced in the UI banner.
  reason: string | null;
  tasks: AutonomousTaskView[];
}

// The compact issue shape linear.parseIssueList normalizes for the browse list.
export interface LinearIssueSummary {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: string;
  updatedAt: string | null;
}

// A single comment on a Linear issue, normalized by linear.parseIssue.
export interface LinearIssueComment {
  body: string;
  author: string;
  createdAt: string | null;
}

// The full issue shape linear.parseIssue normalizes, with enough context
// (description + comments) to groom it into a task prompt.
export interface LinearIssue {
  identifier: string;
  title: string;
  description: string;
  url: string;
  state: string;
  comments: LinearIssueComment[];
}
