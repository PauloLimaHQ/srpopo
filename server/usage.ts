/*
 * Local usage tracking: turns the token/cost data already present on every
 * `claude` CLI `result` event (`event.usage`, `event.modelUsage`,
 * `event.total_cost_usd` — the same "API-equivalent" figures the CLI itself
 * reports at the end of a session) into an append-only ledger and a set of
 * aggregates the Settings → Usage panel reads from.
 *
 * `total_cost_usd` is not a subscription bill — Sr. Popo never uses an API key
 * (see runner.childEnv) — it's Anthropic's per-session cost estimate computed
 * against API list pricing, the same number `claude` shows interactively. That
 * makes it directly comparable across models/projects/periods even though the
 * user isn't actually billed per token.
 */
import * as store from './store';
import type { Grooming, ModelUsageStat, Task, UsageEntry, UsageSummary } from './types';

// The subset of Task/Grooming fields a ledger row needs. Both lifecycles carry
// all of these, so entriesFromResult doesn't need to know which one it's
// looking at — only applyResult/applyGroomResult (which also decide whether to
// accumulate a per-model breakdown onto the record) do.
export interface UsageSource {
  id: string;
  title: string;
  repoId: string;
  repoName: string;
  model: string;
  resolvedModel: string | null;
}

function emptyStat(): ModelUsageStat {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0 };
}

// Turn one `result` event into one ledger row per model it touched. Recent CLI
// versions report `modelUsage` (a model -> {inputTokens,outputTokens,...,costUSD}
// map, since a run's subagents can use a different model than the main turn);
// older/edge-case events without it fall back to a single row against the
// source's resolved model so the run still counts.
function entriesFromResult(source: UsageSource, kind: UsageEntry['kind'], event: Record<string, unknown>): UsageEntry[] {
  const ts = (typeof event.ts === 'string' && event.ts) || store.now();
  const base = {
    ts,
    taskId: source.id,
    taskTitle: source.title,
    repoId: source.repoId,
    repoName: source.repoName,
    kind,
    durationMs: Number(event.duration_ms) || 0,
    numTurns: Number(event.num_turns) || 0,
  };

  const modelUsage = event.modelUsage as Record<string, Record<string, number>> | undefined;
  if (modelUsage && typeof modelUsage === 'object' && Object.keys(modelUsage).length) {
    return Object.entries(modelUsage).map(([model, u]) => ({
      ...base,
      model,
      costUsd: Number(u.costUSD) || 0,
      inputTokens: Number(u.inputTokens) || 0,
      outputTokens: Number(u.outputTokens) || 0,
      cacheReadInputTokens: Number(u.cacheReadInputTokens) || 0,
      cacheCreationInputTokens: Number(u.cacheCreationInputTokens) || 0,
    }));
  }

  const usage = (event.usage as Record<string, number>) || {};
  return [{
    ...base,
    model: source.resolvedModel || source.model || 'unknown',
    costUsd: Number(event.total_cost_usd) || 0,
    inputTokens: Number(usage.input_tokens) || 0,
    outputTokens: Number(usage.output_tokens) || 0,
    cacheReadInputTokens: Number(usage.cache_read_input_tokens) || 0,
    cacheCreationInputTokens: Number(usage.cache_creation_input_tokens) || 0,
  }];
}

// Folds ledger rows into a task's cumulative per-model breakdown — mirrors how
// runner.ts already accumulates task.costUsd across runs/resumes. Grooming
// cards have no such field (their spend is still fully captured in the
// ledger; there is just nothing on the card itself to accumulate onto).
function accumulate(task: Task, entries: UsageEntry[]): void {
  task.modelUsage = task.modelUsage || {};
  for (const e of entries) {
    const acc = task.modelUsage[e.model] || emptyStat();
    acc.inputTokens += e.inputTokens;
    acc.outputTokens += e.outputTokens;
    acc.cacheReadInputTokens += e.cacheReadInputTokens;
    acc.cacheCreationInputTokens += e.cacheCreationInputTokens;
    acc.costUsd += e.costUsd;
    task.modelUsage[e.model] = acc;
  }
}

// Called from runner.ts's `result` handler for every live dispatched run.
// Extends the task with a per-model cumulative breakdown and appends one
// immutable ledger row per model to data/usage.ndjson.
function applyResult(task: Task, event: Record<string, unknown>): void {
  const entries = entriesFromResult(task, 'run', event);
  accumulate(task, entries);
  for (const e of entries) store.appendUsage(e);
}

// Called from runner.ts's `result` handler for every live grooming run. Same
// ledger bookkeeping as applyResult, but grooming cards have no modelUsage
// field to accumulate onto (see accumulate's comment above).
function applyGroomResult(grooming: Grooming, event: Record<string, unknown>): void {
  const entries = entriesFromResult(grooming, 'groom', event);
  for (const e of entries) store.appendUsage(e);
}

// Called from runner.ts's `result` handler for every live "Ask Sr. Popo"
// session (see runner.ask). Ephemeral like a memory-distill session below —
// never stored as a Task or Grooming — so the caller builds a small
// UsageSource, using the question as the ledger row's "task title".
function applyAskResult(source: UsageSource, event: Record<string, unknown>): void {
  const entries = entriesFromResult(source, 'ask', event);
  for (const e of entries) store.appendUsage(e);
}

// Called from runner.ts's `result` handler for every background memory-
// distillation session (see runner.distillMemory). These are ephemeral — never
// stored as a Task or Grooming — so the caller builds a small UsageSource
// carrying the distill session's own id/title alongside the repo it ran in.
function applyMemoryResult(source: UsageSource, event: Record<string, unknown>): void {
  const entries = entriesFromResult(source, 'memory', event);
  for (const e of entries) store.appendUsage(e);
}

// One-time migration for tasks/groomings that ran before this ledger existed:
// replay every record's own NDJSON session log (store.appendLog keeps the raw
// stream-json events forever, keyed by the same id for both lifecycles) and
// rebuild ledger rows (+ task.modelUsage) from their `result` events. Guarded
// by the ledger file's existence, so this scans at most once per install no
// matter how many times the server boots.
function backfillIfNeeded(): void {
  if (store.usageLogExists()) return;
  let touched = false;
  for (const task of store.db.tasks) {
    const events = store.readLog(task.id) as Record<string, unknown>[];
    for (const event of events) {
      if (event && event.type === 'result') {
        const entries = entriesFromResult(task, 'run', event);
        accumulate(task, entries);
        for (const e of entries) store.appendUsage(e);
        touched = true;
      }
    }
  }
  for (const grooming of store.db.groomings) {
    const events = store.readLog(grooming.id) as Record<string, unknown>[];
    for (const event of events) {
      if (event && event.type === 'result') {
        for (const e of entriesFromResult(grooming, 'groom', event)) store.appendUsage(e);
        touched = true;
      }
    }
  }
  if (touched) store.save();
  store.touchUsageLog();
}

const PERIOD_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };
const DAY_MS = 24 * 60 * 60 * 1000;

function sumEntries(rows: UsageEntry[]) {
  const totals = { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  // A single `result` event can produce multiple rows (one per model), so count
  // a "run" once per (taskId, ts) pair rather than once per row.
  const seenRuns = new Set<string>();
  for (const r of rows) {
    totals.costUsd += r.costUsd;
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    totals.cacheReadInputTokens += r.cacheReadInputTokens;
    totals.cacheCreationInputTokens += r.cacheCreationInputTokens;
    seenRuns.add(`${r.taskId}:${r.ts}`);
  }
  return { ...totals, runs: seenRuns.size };
}

function groupBy<T, K extends string>(rows: T[], key: (r: T) => K): [K, T[]][] {
  const map = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = map.get(k);
    if (list) list.push(r); else map.set(k, [r]);
  }
  return [...map.entries()];
}

// Aggregates the ledger for the Usage panel: a period preset ('7d'|'30d'|'90d'
// default '30d'; anything else, including 'all', means the whole ledger),
// optionally scoped to one repo — totals, a model breakdown, a repo breakdown,
// a per-day series for the chart, and a cost/runs comparison against the same-
// length window immediately before the period (null for 'all', which has no
// natural "previous").
function computeSummary(opts: { period?: string; repoId?: string } = {}): UsageSummary {
  const period = opts.period && PERIOD_DAYS[opts.period] ? opts.period : (opts.period === 'all' ? 'all' : '30d');
  const days = PERIOD_DAYS[period] || null;
  const until = new Date();
  const since = days ? new Date(until.getTime() - days * DAY_MS) : null;

  const all = store.readUsage();
  const inWindow = (e: UsageEntry, from: Date | null, to: Date): boolean => {
    if (from && e.ts < from.toISOString()) return false;
    return e.ts <= to.toISOString();
  };

  let entries = all.filter((e) => inWindow(e, since, until));
  if (opts.repoId) entries = entries.filter((e) => e.repoId === opts.repoId);

  const totals = sumEntries(entries);

  let previous: { costUsd: number; runs: number } | null = null;
  let deltaPct: number | null = null;
  if (since && days) {
    const prevSince = new Date(since.getTime() - days * DAY_MS);
    let prevEntries = all.filter((e) => inWindow(e, prevSince, since));
    if (opts.repoId) prevEntries = prevEntries.filter((e) => e.repoId === opts.repoId);
    const prevTotals = sumEntries(prevEntries);
    previous = { costUsd: prevTotals.costUsd, runs: prevTotals.runs };
    if (prevTotals.costUsd > 0) deltaPct = ((totals.costUsd - prevTotals.costUsd) / prevTotals.costUsd) * 100;
    else if (totals.costUsd > 0) deltaPct = 100;
  }

  const byModel = groupBy(entries, (e) => e.model)
    .map(([model, rows]) => ({ model, ...sumEntries(rows) }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const byRepo = groupBy(entries, (e) => e.repoId)
    .map(([repoId, rows]) => ({ repoId, repoName: rows[0].repoName, ...sumEntries(rows) }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const byDayMap = new Map<string, { costUsd: number; runs: number }>();
  for (const e of entries) {
    const date = e.ts.slice(0, 10);
    const bucket = byDayMap.get(date) || { costUsd: 0, runs: 0 };
    bucket.costUsd += e.costUsd;
    bucket.runs += 1; // per-row is fine for the chart; a multi-model run reads as two thin bars on the same day
    byDayMap.set(date, bucket);
  }
  const byDay = [...byDayMap.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    period,
    since: since ? since.toISOString() : null,
    until: until.toISOString(),
    totals: { ...totals, tasks: new Set(entries.map((e) => e.taskId)).size },
    previous,
    deltaPct,
    byModel,
    byRepo,
    byDay,
  };
}

// Runs once, the first time this module is required (mirrors store.ts's own
// top-level db.json migration) — safe to call unconditionally on every boot
// since it's a no-op once the ledger file exists.
backfillIfNeeded();

export { applyResult, applyGroomResult, applyAskResult, applyMemoryResult, computeSummary, backfillIfNeeded };
