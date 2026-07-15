/*
 * CodexAdapter — the OpenAI Codex CLI backend (`codex exec --json`). Like the
 * Claude adapter it is local-only and subscription-login (never an API key): the
 * user authenticates once with `codex login` (ChatGPT), and we strip
 * OPENAI_API_KEY from every spawned run so a stray key can't silently switch it
 * to metered API billing (the Codex analogue of invariant #2).
 *
 * VERIFIED SCHEMA (codex-cli 0.144.4, `codex exec --json`, captured live — do
 * not invent these shapes). Each stdout line is one JSON object:
 *   {"type":"thread.started","thread_id":"019f...-uuid"}        // session id
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{"id":"item_1","type":"command_execution",
 *        "command":"/bin/zsh -lc 'ls'","aggregated_output":"","exit_code":null,
 *        "status":"in_progress"}}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message",
 *        "text":"hello"}}                                        // assistant text
 *   {"type":"item.completed","item":{"id":"item_1","type":"command_execution",
 *        "command":"...","aggregated_output":"...","exit_code":0,
 *        "status":"completed"}}
 *   {"type":"turn.completed","usage":{"input_tokens":13005,
 *        "cached_input_tokens":9984,"output_tokens":5,
 *        "reasoning_output_tokens":0}}                           // success result
 * Failure path (e.g. bad model):
 *   {"type":"item.completed","item":{"id":"item_0","type":"error",
 *        "message":"Model metadata ... not found ..."}}          // non-fatal note
 *   {"type":"error","message":"..."}                             // top-level error
 *   {"type":"turn.failed","error":{"message":"..."}}             // failure result
 * Process exit code is 0 on success, 1 on failure. There is NO per-session dollar
 * cost and NO num_turns/duration_ms — subscription runs report tokens only.
 *
 * Prompt delivery: verified that `codex exec [--json] -` reads the prompt from
 * stdin (the runner writes it there and closes stdin), matching the Claude flow.
 * Resume: `codex exec resume <sessionId> -` streams the same JSONL and keeps the
 * original session's sandbox (it does NOT accept `--sandbox`, verified), so the
 * follow-up path only re-selects the model.
 */
import { baseChildEnv } from './env';
import type { AgentAdapter, NormalizedEvent, NormalizedResult } from './types';
import type { Grooming, Task } from '../types';

const CODEX_BIN = process.env.CODEX_BIN || 'codex';

// Map a task's permission mode onto a Codex sandbox level. Codex has no per-tool
// approval hook we can bridge (unlike Claude's --permission-prompt-tool), so
// safety comes from the sandbox instead — see "Known gaps" in the task.
// `codex exec` is headless by default: it never prompts for approval, running
// sandbox-permitted commands and simply returning denied ones to the model. So
// the sandbox level is the whole story (no --ask-for-approval flag — the exec
// subcommand doesn't accept one; verified).
function sandboxArgs(permissionMode: string | undefined): string[] {
  if (permissionMode === 'bypassPermissions') {
    // YOLO: no sandbox, no approvals. One combined, all-or-nothing flag.
    return ['--dangerously-bypass-approvals-and-sandbox'];
  }
  // 'plan' is a read-only intent; everything else may write within the workspace.
  const sandbox = permissionMode === 'plan' ? 'read-only' : 'workspace-write';
  return ['--sandbox', sandbox];
}

// CLI args for a dispatched Codex run. Fresh runs stream `codex exec --json`;
// a follow-up resumes the recorded session. The prompt is always read from stdin
// (the trailing `-`), so the runner's stdin write works unchanged.
function buildArgs(task: Partial<Task>, resume: boolean): string[] {
  const model: string[] = task.model && task.model !== 'default' ? ['-m', task.model] : [];
  if (resume && task.sessionId) {
    // Resume keeps the original sandbox; only the model may be re-selected.
    return ['exec', 'resume', task.sessionId, '--json', '--skip-git-repo-check', ...model, '-'];
  }
  return ['exec', '--json', '--skip-git-repo-check', ...sandboxArgs(task.permissionMode), ...model, '-'];
}

// Read-only args for a grooming session: research only, never a write. Mirrors
// the Claude adapter's read-only groom posture using the Codex sandbox.
function groomArgs(grooming: Pick<Grooming, 'model'>): string[] {
  const model: string[] = grooming.model && grooming.model !== 'default' ? ['-m', grooming.model] : [];
  return ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', ...model, '-'];
}

// Subscription-only env: strip OPENAI_API_KEY so a run always uses `codex login`
// (ChatGPT) auth, never a metered API key. The shared base already drops the
// nested-session markers. Codex has no custom-model env layer (that's a Claude/
// Bedrock concept), so `model` is unused here.
function childEnv(_model: string | undefined): NodeJS.ProcessEnv {
  const env = baseChildEnv();
  delete env.OPENAI_API_KEY;
  return env;
}

// Shape a Codex `turn.completed` usage object into the `{ usage, total_cost_usd,
// modelUsage }` schema server/usage.ts already reads, so the ledger needs no
// per-provider branching. Cost is 0 (no subscription dollar figure) and the
// cache-creation bucket is absent from Codex, so it maps to 0.
function usageEventFrom(usage: Record<string, any> | undefined): Record<string, unknown> {
  const u = usage || {};
  return {
    usage: {
      input_tokens: Number(u.input_tokens) || 0,
      output_tokens: Number(u.output_tokens) || 0,
      cache_read_input_tokens: Number(u.cached_input_tokens) || 0,
      cache_creation_input_tokens: 0,
    },
    total_cost_usd: 0,
    duration_ms: 0,
    num_turns: 0,
  };
}

function failedResult(reason: string | null): NormalizedResult {
  return {
    isError: true,
    costUsd: 0,
    numTurns: null,
    durationMs: null,
    text: '',
    errorReason: reason,
    usageEvent: usageEventFrom(undefined),
  };
}

// Normalize one line of `codex exec --json`. Only the terminal turn events carry
// result semantics; item.* events (agent messages, command executions, reasoning,
// non-fatal item errors) are logged verbatim for the timeline but drive nothing.
function parseLine(line: string): NormalizedEvent | null {
  if (!line.trim()) return null;
  // The parsed Codex JSONL event. Loosely typed (see claude.ts parseLine); `log`
  // records it verbatim and we only read the fields documented above.
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return { log: { type: 'raw', text: line } };
  }

  const out: NormalizedEvent = { log: event };
  switch (event.type) {
    case 'thread.started':
      // Codex doesn't echo the model on the session event; resolvedModel stays
      // whatever the task selected (or null for the account default).
      out.session = { sessionId: event.thread_id, model: null };
      break;
    case 'turn.completed':
      out.result = {
        isError: false,
        costUsd: 0,
        numTurns: null,
        durationMs: null,
        text: '',
        errorReason: null,
        usageEvent: usageEventFrom(event.usage),
      };
      break;
    case 'turn.failed':
      out.result = failedResult((event.error && event.error.message) || null);
      break;
    case 'error':
      // A top-level error event (distinct from a non-fatal item.type === 'error',
      // which is just logged). Treat it as a failure result.
      out.result = failedResult(typeof event.message === 'string' ? event.message : null);
      break;
    default:
      break;
  }
  return out;
}

export const CodexAdapter: AgentAdapter = {
  id: 'codex',
  bin: CODEX_BIN,
  label: 'codex',
  childEnv,
  buildArgs,
  groomArgs,
  parseLine,
};

export { CODEX_BIN, buildArgs, groomArgs, childEnv, parseLine, sandboxArgs };
