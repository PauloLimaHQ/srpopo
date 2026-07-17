/*
 * Canonical per-backend model vocabularies, and the complexity -> model
 * mapping used to suggest an execution model for a groomed task. Kept as a
 * single source of truth so a suggestion never crosses backends — a Claude
 * task only ever gets a Claude model name, a Codex task only ever gets a
 * Codex model name, regardless of which model happened to run the grooming
 * session itself (e.g. grooming with the pricier "fable" doesn't mean the
 * spawned tasks should all execute on fable — most only need "sonnet").
 */

import type { TaskAgent } from './types';

export type TaskComplexity = 'simple' | 'standard' | 'complex';

// Ascending cost/capability tier per backend. Mirrors the <option> lists in
// public/index.html and the color ramp in public/app.js's modelClass (fable
// reads reddest — the most expensive — down to haiku).
const CLAUDE_TIER_MODEL: Record<TaskComplexity, string> = {
  simple: 'haiku',
  standard: 'sonnet',
  complex: 'opus',
};

// Codex has no documented capability ordering in this repo beyond the three
// named options in public/index.html; "fable"-equivalent top-tier spend is
// deliberately not auto-suggested for either backend (a human opts into it).
const CODEX_TIER_MODEL: Record<TaskComplexity, string> = {
  simple: 'gpt-5.6-luna',
  standard: 'gpt-5.6-sol',
  complex: 'gpt-5.6-terra',
};

// Suggest an execution model for `agent` given a task's judged complexity.
// Always resolves within that backend's own vocabulary.
export function suggestModel(agent: TaskAgent, complexity: TaskComplexity | undefined | null): string {
  const tiers = agent === 'codex' ? CODEX_TIER_MODEL : CLAUDE_TIER_MODEL;
  return tiers[complexity || 'standard'] || tiers.standard;
}
