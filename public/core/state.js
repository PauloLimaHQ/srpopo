/* Sr. Popo — state. No build step: native ES module.
 *
 * The shared board state and the few helpers every feature needs. This module
 * imports nothing from features/ on purpose — it is the bottom of the graph.
 */

// ---------- state ----------
const state = {
  repos: [],
  tasks: new Map(), // id -> task
  groomings: new Map(), // id -> grooming card (own lifecycle, Grooming column)
  orchestrations: new Map(), // id -> orchestration card (own lifecycle, Orchestration column)
  openTaskId: null, // task shown in drawer
  openGroomingId: null, // grooming card shown in drawer (mutually exclusive)
  openOrchestrationId: null, // orchestration card shown in drawer (mutually exclusive)
  addons: [],       // catalog of optional task behaviors (from /api/addons)
  personas: [],     // catalog of expert personas (from /api/personas)
  plugins: [],      // marketplace catalog (from /api/plugins)
  settings: { notifications: true, sounds: true, maxParallelSessions: 3, installedPlugins: [], mergeStrategy: 'merge', minMergeGrade: 4, remoteAccess: false, remoteAccessConfigured: false, customModels: [], isolateMcpServers: true, sessionMemoryMb: 'auto', sessionMemoryAutoMb: 0 }, // user preferences (from /api/settings)
  filters: { search: '' }, // board filters (free-text only — repo scope comes from state.view)
  view: { mode: 'super' }, // { mode: 'super' } | { mode: 'workspace', repoId }
  prByTask: new Map(), // taskId -> 'loading' | { pr, reason } from /api/tasks/:id/pr
  repoBranchByTask: new Map(), // taskId -> 'loading' | repo's live current branch (non-worktree tasks only)
  repoBranchByRepo: new Map(), // repoId -> 'loading' | repo's live current branch (Super View / workspace header)
  repoRemoteUrlByRepo: new Map(), // repoId -> repo's `origin` remote as a web URL (e.g. GitHub), or null
  repoAheadBehindByRepo: new Map(), // repoId -> { ahead, behind } | null for the repo's current branch vs its upstream
  worktreesByRepo: new Map(), // repoId -> 'loading' | [ WorktreeInfo ] from /api/repos/:id/worktrees
  permissions: new Map(), // taskId -> [ pending tool-approval requests ]
  autoApprove: new Set(), // taskIds whose live run is in auto-approve ("AUTO MODE")
  autonomous: null, // live autonomous-session snapshot (from /api/state + `autonomous` SSE)
  usage: { period: '30d', repoId: '', summary: null }, // Settings → Usage panel (from /api/usage)
  // Desktop hand-offs for the workspace quick actions (from /api/desktop): what
  // this OS calls its file manager, and which IDEs are installed here.
  desktop: { fileManager: 'file manager', editors: [] },
  askId: null, // the in-flight "Ask Sr. Popo" session id (see modal-ask), or null
  askText: '', // assistant text streamed so far for the open ask session
};

// Pending permission-prompt helpers — a task's live tool-approval requests.
function pendingPermissions(taskId) {
  return state.permissions.get(taskId) || [];
}
function setPendingPermissions(taskId, list) {
  if (list && list.length) state.permissions.set(taskId, list);
  else state.permissions.delete(taskId);
}
// Auto-approve ("AUTO MODE") helpers — a running task the user has told to allow
// every otherwise-prompted tool. Process-local, tracked live off SSE.
function isAutoApprove(taskId) {
  return state.autoApprove.has(taskId);
}
function setAutoApproveLocal(taskId, on) {
  if (on) state.autoApprove.add(taskId);
  else state.autoApprove.delete(taskId);
}

// In the desktop app native notifications are fired by the Electron shell; in a
// plain browser we fall back to the Web Notifications API from here.
const isElectron = !!(window.srpopo && window.srpopo.isElectron);

// Dot colors are mid-tones chosen to read on both the light "paper" and dark
// surfaces; running uses Claude's terracotta accent to match the theme.
const COLUMNS = [
  { key: 'backlog', label: 'Backlog', dot: '#94897a' },
  { key: 'ready', label: 'Ready', dot: '#5b8cbe' },
  { key: 'running', label: 'Running', dot: '#d97757' },
  { key: 'code_review', label: 'Code Review', dot: '#3f9d97' },
  { key: 'validation', label: 'Validation', dot: '#8a78d6' },
  { key: 'done', label: 'Done', dot: '#5aa873' },
];
// The Grooming column is not a task column: it's rendered first, holds only
// grooming cards (their own draft/running/finished lifecycle), and is locked —
// nothing is ever dragged into or out of it.
const GROOMING_COLUMN = { key: 'grooming', label: 'Grooming', dot: '#c06fce' };
// Same idea for Goal Orchestration: a locked column of orchestration cards,
// each one a goal an orchestrator agent is planning and coordinating.
const ORCH_COLUMN = { key: 'orchestration', label: 'Orchestration', dot: '#d1a03c' };
// failed tasks are surfaced in the Review column with a FAILED badge
const COLUMN_OF_STATUS = {
  backlog: 'backlog', ready: 'ready', running: 'running',
  code_review: 'code_review', validation: 'validation', failed: 'validation', done: 'done',
};
// A live task runs a claude child process — its card can't be dragged/edited
// and shows a spinner + stop button instead. A Code Review pass is a live child
// too (a fresh read-only reviewer session), so it counts here.
const isLive = (t) => t.status === 'running' || t.status === 'code_review';
const isGroomingLive = (g) => g.status === 'running';
const isOrchestrationLive = (o) => o.status === 'running';

const $ = (sel) => document.querySelector(sel);

// Modifier label for on-screen keyboard hints — ⌘ on macOS, "Ctrl" elsewhere.
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
const MOD = IS_MAC ? '⌘' : 'Ctrl';

// Inline SVG icon (Lucide, via icons.js). Returns trusted markup — insert it
// into templates directly, never through esc(). No emojis in the UI.
const icon = (name, opts) => (window.srpopoIcons ? window.srpopoIcons.svg(name, opts) : '');

export { $, COLUMNS, COLUMN_OF_STATUS, GROOMING_COLUMN, MOD, ORCH_COLUMN, icon, isAutoApprove, isElectron, isGroomingLive, isLive, isOrchestrationLive, pendingPermissions, setAutoApproveLocal, setPendingPermissions, state };
