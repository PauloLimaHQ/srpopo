/*
 * Shared types for Sr. Popo's Node-side code. These describe the persisted data
 * (repos/tasks/settings) and the small message/decision shapes that flow between
 * the runner, the permission bridge, and the SSE bus. Typing is additive — it
 * mirrors the objects the code already builds; it does not change any behavior.
 */

// How `github.mergePrForTask` finishes a task's pull request via `gh pr merge`:
// a traditional merge commit, a single squashed commit, or a rebase-and-merge.
export type MergeStrategy = 'merge' | 'squash' | 'rebase';

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
  // Preferred `gh pr merge` strategy, used by both the "Move to Done" merge step
  // and the Autonomous Mode engine (see github.mergePrForTask).
  mergeStrategy: MergeStrategy;
  // When on, a task sitting in `review` whose PR has merge conflicts with main is
  // automatically resumed with an instruction to resolve them (see
  // server/conflicts.ts). Applies to plain review-column tasks and to Autonomous
  // Mode's own merge-safety check alike. Opt-in: off by default since it silently
  // spawns a new `claude` run.
  autoResolveConflicts: boolean;
  // When on, the "Create a Pull Request at the end" add-on (server/addons.ts)
  // assigns the PR it opens to the logged-in `gh` user (`--assignee @me`).
  // Off by default like the other opt-in GitHub behaviors above.
  assignPrToSelf: boolean;
  // Opt-in "Remote Access (LAN)" mode. When true the server binds the LAN
  // interface (0.0.0.0) instead of 127.0.0.1 only, and every non-localhost
  // request must carry the shared token below. Off by default — invariant #1
  // (localhost is the security boundary) only relaxes when the user opts in.
  remoteAccess: boolean;
  // Shared access token that gates LAN requests when remoteAccess is on. A
  // secret like linearApiToken: it lives only in db.json, is generated lazily
  // the first time remote access is enabled, and is never returned to the board
  // (see PublicSettings) — only over the localhost-only GET /api/remote-access.
  remoteAccessToken: string;
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
  mergeStrategy: MergeStrategy;
  autoResolveConflicts: boolean;
  assignPrToSelf: boolean;
  // Whether LAN remote access is enabled, and whether a token exists — never the
  // raw token itself (that only flows over the localhost-only GET /api/remote-access).
  remoteAccess: boolean;
  remoteAccessConfigured: boolean;
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
  | 'review'
  | 'done'
  | 'failed';

// A grooming card's own lifecycle — separate from tasks. It never becomes a
// task; it spawns them. `running` (like a task's) is set only by the runner.
export type GroomingStatus = 'draft' | 'running' | 'finished' | 'failed';

// Where a grooming's spawned tasks land: always backlog, always ready, or let
// the grooming session decide per task (its `ready` flag on each spec).
export type GroomingTarget = 'backlog' | 'ready' | 'auto';

// A "Brief an Idea" card. Lives in db.groomings with its own board column and
// lifecycle: draft → running → finished (or failed), archive/delete when done.
// The grooming session is read-only research in the repo — it never gets a
// worktree or a resumable session, so there is nothing on disk to clean up.
export interface Grooming {
  id: string;
  title: string;
  // The rough idea being groomed (the brief).
  idea: string;
  repoId: string;
  repoName: string;
  repoPath: string;
  model: string;
  target: GroomingTarget;
  // Origin pointer when the idea was imported from a Linear issue.
  linearIssue?: { identifier: string; url: string };
  // Suggested worktree branch, applied only when exactly one task is spawned
  // (branch names must be unique across tasks).
  branchName: string | null;
  status: GroomingStatus;
  sessionId: string | null;
  resolvedModel: string | null;
  costUsd: number;
  numTurns: number | null;
  durationMs: number | null;
  runCount: number;
  activeSubagents: number;
  lastOutcome: string | null;
  lastError: string | null;
  // Ids of the tasks this grooming spawned when it finished.
  taskIds: string[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
  // The original rough idea, present only on tasks spawned by a grooming.
  brief?: string;
  // The grooming card that spawned this task, so the two can link to each other.
  groomingId?: string;
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
  // Per-model token/cost breakdown, accumulated across every run/resume of this
  // task (mirrors costUsd's cumulative bookkeeping) — keyed by model id, e.g.
  // "claude-sonnet-5". Populated from each `result` event's own `modelUsage` map
  // (see runner.ts, server/usage.ts); absent/empty on tasks that haven't run yet.
  modelUsage: Record<string, ModelUsageStat>;
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

// Token/cost totals for one model, accumulated across one or more runs. Shared
// by Task.modelUsage (per-task cumulative) and the usage-ledger aggregates
// (server/usage.ts) so both read the same shape.
export interface ModelUsageStat {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

// One row of the append-only usage ledger (data/usage.ndjson), written by
// usage.applyResult whenever a `result` event lands. One row per model per run
// (a run using two models produces two rows sharing the same taskId/ts), which
// keeps every downstream aggregation a simple group-by. Denormalizes
// taskTitle/repoName at write time so historical stats still read right after
// a task is renamed, archived, or its repo removed.
export interface UsageEntry {
  ts: string;
  taskId: string;
  taskTitle: string;
  repoId: string;
  repoName: string;
  model: string;
  kind: 'run' | 'groom';
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  durationMs: number;
  numTurns: number;
}

export interface UsageTotals {
  costUsd: number;
  runs: number;
  tasks: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface UsageModelBreakdown {
  model: string;
  costUsd: number;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface UsageRepoBreakdown {
  repoId: string;
  repoName: string;
  costUsd: number;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface UsageDayBucket {
  date: string; // YYYY-MM-DD (UTC)
  costUsd: number;
  runs: number;
}

// The full response of GET /api/usage — everything the Settings → Usage panel
// needs for one period/repo selection in a single round trip.
export interface UsageSummary {
  period: string;
  since: string | null;
  until: string;
  totals: UsageTotals;
  // Same-length window immediately before `since`, for the "vs last period"
  // comparison; null for the 'all' period (there is no "previous" window).
  previous: { costUsd: number; runs: number } | null;
  deltaPct: number | null;
  byModel: UsageModelBreakdown[];
  byRepo: UsageRepoBreakdown[];
  byDay: UsageDayBucket[];
}

export interface Db {
  repos: Repo[];
  tasks: Task[];
  groomings: Grooming[];
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
  // Whether this session also actively reviews + finishes tasks parked in `review`
  // (resume with a review pass, then green-merge → done), not just merge green PRs.
  reviewMode: boolean;
  startedAt: string | null;
  // True once a user stop was requested but in-flight runs are still finishing.
  stopping: boolean;
  // Why the session last changed state (e.g. 'started', 'standby',
  // 'budget-reached', 'stopped') — surfaced in the UI banner.
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
