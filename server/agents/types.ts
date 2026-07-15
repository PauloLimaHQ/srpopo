/*
 * The agent-backend seam. `runner.ts` drives a task or grooming session through
 * an `AgentAdapter`, which owns everything provider-specific: the binary name,
 * subscription-only env stripping, the CLI args, and a `parseLine` normalizer
 * that turns one line of the child's JSONL stream into a `NormalizedEvent`.
 *
 * The runner stays provider-agnostic: it spawns `adapter.bin` with
 * `adapter.buildArgs(...)`, writes the prompt to stdin, and reacts only to the
 * normalized events — session id, subagent open/close, and the terminal result.
 * Adding a backend means adding an adapter; the runner does not change.
 */
import type { Grooming, Task, TaskAgent, LogEvent } from '../types';

// The terminal result of a session, normalized across providers. Built by an
// adapter's parseLine when it sees the run's final event (Claude `result`;
// Codex `turn.completed` / `turn.failed`). The runner applies these to the
// record and hands `usageEvent` to the usage ledger.
export interface NormalizedResult {
  // Did the run end in an error (non-zero-ish outcome)? Drives review vs failed.
  isError: boolean;
  // Added to the record's cumulative cost. Claude reports Anthropic's per-session
  // estimate; Codex subscription runs have no dollar figure, so this is 0 and the
  // UI shows "—" rather than a misleading $0 (see server/usage.ts + the board).
  costUsd: number;
  numTurns: number | null;
  durationMs: number | null;
  // The final agent text, used to build a failure message and (for grooming) to
  // parse the task spec. Empty when the provider doesn't surface it on the result.
  text: string;
  // A short human reason when isError (else null) — Claude `result`/`subtype`,
  // Codex `error.message`.
  errorReason: string | null;
  // The event shape the usage ledger reads (server/usage.ts). Claude passes its
  // own `result` event through untouched; Codex maps its token usage into the
  // same `{ usage, total_cost_usd, modelUsage }` schema so usage.ts needs no
  // per-provider branching.
  usageEvent: Record<string, unknown>;
}

// One line of the child's stream, normalized. `log` is always present — it is
// what the runner appends to the timeline/SSE verbatim (the parsed provider
// event, or a `{ type: 'raw' }` fallback when the line wasn't JSON). The rest is
// the cross-provider semantics the runner acts on; all optional.
export interface NormalizedEvent {
  // The LogEvent to record to the timeline, exactly as before the refactor.
  log: LogEvent;
  // Session identity, when this event carries it (Claude system/init, Codex
  // thread.started). Runner sets rec.sessionId/resolvedModel from it.
  session?: { sessionId?: string | null; model?: string | null };
  // Ids of subagent (Claude `Task` tool_use) blocks this event opens. The runner
  // owns the open-set bookkeeping; the adapter just reports what it saw.
  subagentsOpened?: string[];
  // Candidate ids (tool_result ids) that may close an open subagent.
  subagentsClosed?: string[];
  // Present only on the terminal result event.
  result?: NormalizedResult;
}

export interface AgentAdapter {
  // Which backend this is (matches Task.agent).
  readonly id: TaskAgent;
  // The binary spawned (overridable via env, e.g. CLAUDE_BIN / CODEX_BIN).
  readonly bin: string;
  // Human/CLI name used in fallback error messages ("<label> exited with code N").
  readonly label: string;
  // The full child environment for a run on `model`: the shared base env with
  // this provider's secret(s) stripped (subscription-only) plus any model env.
  childEnv(model: string | undefined): NodeJS.ProcessEnv;
  // CLI args for a dispatched task run (fresh, or a `resume` follow-up).
  buildArgs(task: Partial<Task>, resume: boolean): string[];
  // CLI args for a read-only grooming session.
  groomArgs(grooming: Pick<Grooming, 'model'>): string[];
  // Normalize one NDJSON line into a NormalizedEvent, or null for a blank line.
  parseLine(line: string): NormalizedEvent | null;
}
