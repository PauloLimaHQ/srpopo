/*
 * Workspace (per-repo) settings — the single source of truth for them, in the
 * same mold as server/addons.ts and server/personas.ts.
 *
 * A workspace's settings are *defaults*, never overrides. They do two things:
 *   - name the branch a worktree task is cut on (`branchTemplate`), and
 *   - prefill the fields of a new task / grooming created in that repo.
 * A task's own value always wins, and the app-wide `Settings` (merge strategy,
 * minimum merge grade, autonomous budget, …) are untouched by any of this.
 *
 * Every field is optional and an absent key means "no opinion — use Sr. Popo's
 * built-in default", so `configured()` is a plain "is anything set?" test and an
 * existing db.json loads unchanged (see RepoSettings in server/types.ts).
 *
 * Deliberately does NOT import server/runner.ts (that would close an import
 * cycle through tasks.ts): `allowedTools` is kept as a trimmed string, and
 * tasks.createTask already runs runner.normalizeAllowedTools over whatever it
 * receives.
 */

import { db } from './store';
import * as addons from './addons';
import * as personas from './personas';
import type { GroomingTarget, RepoSettings, TaskAgent } from './types';

// Backends a workspace may default to. Kept in step with tasks.sanitizeAgent;
// an unknown value is dropped rather than rejected, so a stray setting can never
// produce an unrunnable task.
const AGENTS: TaskAgent[] = ['claude', 'codex', 'grok'];
const PERMISSION_MODES = ['acceptEdits', 'bypassPermissions', 'plan', 'default'];
const GROOM_TARGETS: GroomingTarget[] = ['backlog', 'ready', 'auto'];

// A trimmed non-empty string, or undefined — which is how a key gets omitted
// entirely instead of persisted as '' (i.e. "configured to nothing").
function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

// A boolean only when the key is actually present and boolean-ish: an absent or
// null value must stay absent so an untouched checkbox doesn't persist `false`.
function bool(input: Record<string, unknown>, key: string): boolean | undefined {
  if (!(key in input) || input[key] === null || input[key] === undefined) return undefined;
  return !!input[key];
}

function oneOf<T extends string>(value: unknown, allowed: T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined;
}

// Build a clean RepoSettings from a raw request body. Unknown keys are dropped,
// invalid values are dropped (never an error — see the module comment), and any
// key that is absent, null, or an empty/whitespace string is omitted, so `{}`
// really means "this workspace is unconfigured".
function sanitize(input: unknown): RepoSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const raw = input as Record<string, unknown>;
  const out: RepoSettings = {};

  const branchTemplate = str(raw.branchTemplate);
  if (branchTemplate) out.branchTemplate = branchTemplate;
  const baseBranch = str(raw.baseBranch);
  if (baseBranch) out.baseBranch = baseBranch;

  const agent = oneOf(raw.agent, AGENTS);
  if (agent) out.agent = agent;
  const model = str(raw.model);
  if (model) out.model = model;
  const permissionMode = oneOf(raw.permissionMode, PERMISSION_MODES);
  if (permissionMode) out.permissionMode = permissionMode;

  const useWorktree = bool(raw, 'useWorktree');
  if (useWorktree !== undefined) out.useWorktree = useWorktree;
  const autoCodeReview = bool(raw, 'autoCodeReview');
  if (autoCodeReview !== undefined) out.autoCodeReview = autoCodeReview;
  const autoPersona = bool(raw, 'autoPersona');
  if (autoPersona !== undefined) out.autoPersona = autoPersona;

  const chosenAddons = addons.sanitize(raw.addons);
  if (chosenAddons.length) out.addons = chosenAddons;
  const chosenPersonas = personas.sanitize(raw.personas);
  if (chosenPersonas.length) out.personas = chosenPersonas;

  const allowedTools = str(raw.allowedTools);
  if (allowedTools) out.allowedTools = allowedTools;

  const groomModel = str(raw.groomModel);
  if (groomModel) out.groomModel = groomModel;
  const groomTarget = oneOf(raw.groomTarget, GROOM_TARGETS);
  if (groomTarget) out.groomTarget = groomTarget;

  return out;
}

// This repo's settings, or `{}` for an unknown/unconfigured repo — so callers
// can read a key off the result without a null check.
function forRepo(repoId: string): RepoSettings {
  return db.repos.find((r) => r.id === repoId)?.settings || {};
}

// Whether the workspace has anything configured at all. Drives both "delete the
// key on save" server-side and "ignore the browser's last-used memory" in the
// New Task modal.
function configured(s: RepoSettings): boolean {
  return !!s && Object.keys(s).length > 0;
}

// Characters git refuses in a ref name (plus the control range), stripped rather
// than rejected so a half-typed template still yields a usable branch.
// eslint-disable-next-line no-control-regex -- stripping control chars is the point
const ILLEGAL = /[\x00-\x1f\x7f~^:?*[\\]/g;

/**
 * Resolve a branch template into a legal git ref.
 *
 * Substitutes `{slug}`, `{id}` and `{date}` (YYYY-MM-DD), then sanitizes the
 * result: whitespace collapses to `-`, characters git rejects are stripped,
 * repeated `/` and `-` collapse, and leading/trailing `/` `.` (and a trailing
 * `.lock`) are trimmed off. Case is left alone.
 *
 * Returns null when the template is blank or sanitizes down to nothing, so the
 * caller falls back to the built-in `srpopo/<slug>-<id>` name.
 *
 * Uniqueness is deliberately NOT handled here: a template that omits `{id}` and
 * `{slug}` can resolve to the same branch for two tasks, and `git worktree add`
 * then fails loudly through the existing dispatch error path. The modal's hint
 * warns about it.
 */
function resolveBranchName(template: string, ctx: { slug: string; id: string }): string | null {
  if (typeof template !== 'string' || !template.trim()) return null;
  const date = new Date().toISOString().slice(0, 10);
  let name = template
    .replace(/\{slug\}/g, ctx.slug || '')
    .replace(/\{id\}/g, ctx.id || '')
    .replace(/\{date\}/g, date);

  name = name
    // Whitespace first (it becomes a separator), then the characters git simply
    // refuses — stripping those can itself create a `..`, so dots collapse after.
    .replace(/\s+/g, '-')
    .replace(ILLEGAL, '')
    .replace(/\.{2,}/g, '.') // git rejects `..` anywhere in a ref
    .replace(/\/{2,}/g, '/')
    .replace(/-{2,}/g, '-');
  // A trailing `.lock` is reserved, and a ref can't start or end with `/` or `.`.
  while (name.endsWith('.lock')) name = name.slice(0, -'.lock'.length);
  name = name.replace(/^[/.]+/, '').replace(/[/.]+$/, '');
  return name || null;
}

export { configured, forRepo, resolveBranchName, sanitize };
