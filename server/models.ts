/*
 * Canonical per-backend model vocabularies, and the complexity -> model
 * mapping used to suggest an execution model for a groomed task. Kept as a
 * single source of truth so a suggestion never crosses backends — a Claude
 * task only ever gets a Claude model name, a Codex task a Codex one and a Grok
 * task a Grok one, regardless of which model happened to run the grooming
 * session itself (e.g. grooming with the pricier "fable" doesn't mean the
 * spawned tasks should all execute on fable — most only need "sonnet").
 */

import type { TaskAgent } from './types';

export type TaskComplexity = 'simple' | 'standard' | 'complex';

// Ascending cost/capability tier per backend. Mirrors the <option> lists in
// public/index.html and the color ramp in public/core/api.js's modelClass (fable
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

// Grok publishes only two models worth pointing coding work at, so the ramp has
// two rungs rather than three: `grok-build` is the agent-tuned coding model and
// carries the everyday work, while `grok-4.5` (the CLI's own default for a new
// session, and the bigger general reasoning model) is reserved for the tasks
// judged complex.
const GROK_TIER_MODEL: Record<TaskComplexity, string> = {
  simple: 'grok-build',
  standard: 'grok-build',
  complex: 'grok-4.5',
};

const TIER_MODELS: Record<TaskAgent, Record<TaskComplexity, string>> = {
  claude: CLAUDE_TIER_MODEL,
  codex: CODEX_TIER_MODEL,
  grok: GROK_TIER_MODEL,
};

// Suggest an execution model for `agent` given a task's judged complexity.
// Always resolves within that backend's own vocabulary.
export function suggestModel(agent: TaskAgent, complexity: TaskComplexity | undefined | null): string {
  const tiers = TIER_MODELS[agent] || CLAUDE_TIER_MODEL;
  return tiers[complexity || 'standard'] || tiers.standard;
}
