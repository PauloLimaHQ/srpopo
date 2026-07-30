/*
 * GrokAdapter — the xAI Grok CLI backend (`grok --output-format streaming-json`).
 * Like the Claude and Codex adapters it is local-only and subscription-login
 * (never an API key): the user authenticates once with `grok login`, and we strip
 * XAI_API_KEY from every spawned run so a stray key can't silently switch it to
 * metered API billing (the Grok analogue of invariant #2).
 *
 * VERIFIED AGAINST grok 0.2.114 (macOS arm64) — the shipped CLI docs in
 * `~/.grok/docs/user-guide/14-headless-mode.md`, corroborated by probing the real
 * binary. What was confirmed by running it:
 *   - Every flag this file emits parses and engages headless mode. An unaccepted
 *     value fails loudly instead (`--permission-mode nonsense` exits 2 with
 *     "[possible values: default, acceptEdits, auto, dontAsk, bypassPermissions,
 *     plan]"), so the accepted set below is not guesswork.
 *   - `--prompt-file <path>` triggers headless mode, and the prompt does NOT come
 *     from stdin: piping one with no prompt flag falls through to the TUI and dies
 *     with "Error: Device not configured (os error 6)". Hence promptArgs() below.
 *   - The failure event shape and exit status: a line
 *     {"type":"error","message":"Not signed in. ..."} on stdout, process exit 1.
 * The success path could NOT be captured live (this machine isn't signed in to
 * Grok), so the `end` event's shape below is the documented one:
 *   {"type":"text","data":"Here's"}                    // response chunk (a delta)
 *   {"type":"thought","data":"Analyzing ..."}          // reasoning
 *   {"type":"end","stopReason":"EndTurn","sessionId":"abc123","requestId":"xyz",
 *        "num_turns":7,"usage":{"input_tokens":7210,
 *        "cache_read_input_tokens":41000,"output_tokens":1893,
 *        "reasoning_tokens":412,"total_tokens":50103},
 *        "modelUsage":{"grok-build":{"inputTokens":7210,"outputTokens":1893,
 *        "cacheReadInputTokens":41000,"modelCalls":7,"costUSD":0.0127}},
 *        "total_cost_usd":0.0127}                      // always the LAST event
 *   {"type":"error","message":"..."}                   // failure result
 * Grok may also emit `max_turns_reached` and `auto_compact_*` (both present as
 * strings in the binary); the docs call the list non-exhaustive, so parseLine
 * switches on `type` and logs anything else verbatim.
 *
 * Two consequences of that schema worth knowing before changing this file:
 *   1. There are NO tool-call events — only text/thought/end/error and the
 *      notices above. So a Grok run has no subagent bookkeeping (nothing reports
 *      one) and its timeline is the response text, not a tool trace.
 *   2. The session id arrives on `end`, i.e. at the very END of the run, not on a
 *      start event like Claude's system/init or Codex's thread.started. A run that
 *      dies before `end` therefore records no session id and can't be resumed —
 *      which is the honest outcome, since there's nothing to resume onto.
 * Unlike Codex, Grok's spend fields already use the exact field names
 * server/usage.ts reads, so the `end` event is passed to the ledger untouched
 * (see usageEvent below) — no per-provider mapping.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { effectiveAllowedTools } from './claude';
import { baseChildEnv } from './env';
import type { AgentAdapter, NormalizedEvent, NormalizedResult, PromptDelivery } from './types';
import type { Grooming, Task } from '../types';

const GROK_BIN = process.env.GROK_BIN || 'grok';

// Grok streams the same newline-delimited JSON for every kind of session.
const STREAM_ARGS = ['--output-format', 'streaming-json'];

// Grok's internal tool ids for the read-only research set. Note these are NOT
// Claude's tool names — Grok's `--tools` allowlist takes internal ids (the shell
// tool is `run_terminal_cmd`, not `bash`), so the research trio is spelled
// read_file/grep/list_dir rather than Read/Grep/Glob.
const RESEARCH_TOOLS = 'read_file,grep,list_dir';

// Map a task's permission mode onto Grok's. The two vocabularies overlap almost
// exactly (Grok accepts default | acceptEdits | auto | dontAsk |
// bypassPermissions | plan), with one deliberate translation: Sr. Popo's
// 'default' means "ask", and a headless run has nobody to ask — Grok has no
// approval hook we can bridge the way Claude's --permission-prompt-tool lets us
// (see "Interactive permissions" in CLAUDE.md). `dontAsk` is the mode that
// *denies* anything outside the allow-list instead of prompting for it, so it
// reproduces what `claude -p` does headlessly rather than leaving a run stuck on
// a prompt that can never be shown.
function permissionArgs(permissionMode: string | undefined, resume: boolean): string[] {
  const mode = !permissionMode || permissionMode === 'default' ? 'dontAsk' : permissionMode;
  const args = ['--permission-mode', mode];
  // "Plan only" means "don't touch the repo", so back the mode with Grok's
  // kernel-enforced read-only sandbox rather than trusting the mode alone (Grok
  // documents `plan` as accepted-for-compatibility, not as a write block).
  // Never on a resume: Grok pins a session's sandbox profile when the session is
  // created and REFUSES a resume that passes a different one, so omitting
  // --sandbox — which reuses the saved profile — is the only safe thing here.
  if (mode === 'plan' && !resume) args.push('--sandbox', 'read-only');
  return args;
}

// Grok's `--allow` takes ONE rule per flag (repeatable) and understands the same
// `Tool(pattern)` syntax Claude does — `--allowedTools` is a documented compat
// alias and `Bash(cmd:*)` prefix matching is explicitly supported. So a task's
// merged allow-list carries over verbatim, one --allow each: the user's own
// patterns, the safe package-manager defaults, whatever the selected add-ons need
// (e.g. `gh` + git for "open a PR"), and a spec import's index command.
function allowArgs(task: Partial<Task>): string[] {
  const args: string[] = [];
  for (const rule of effectiveAllowedTools(task).split(',')) {
    if (rule) args.push('--allow', rule);
  }
  return args;
}

// CLI args for a dispatched Grok run. The prompt is NOT here — it travels in a
// temp file appended by promptArgs(), since Grok's headless mode ignores stdin.
// `task.promptPermissions` is deliberately unused: there is no per-tool approval
// hook to route to the board, so safety is the permission mode plus the allow
// rules above (the board hides the Allow/Deny UI for Grok tasks, as it does for
// Codex).
function buildArgs(task: Partial<Task>, resume: boolean): string[] {
  const args = [...STREAM_ARGS];
  if (task.model && task.model !== 'default') args.push('-m', task.model);
  args.push(...permissionArgs(task.permissionMode, resume));
  args.push(...allowArgs(task));
  if (resume && task.sessionId) args.push('--resume', task.sessionId);
  return args;
}

// Read-only args for a grooming session: research only, never a write. Mirrors the
// other adapters' read-only groom posture with a `--tools` allowlist plus the
// read-only sandbox, and `dontAsk` so nothing outside that set can prompt.
// (Grooming always runs on Claude today — see runner.groom — so this exists for
// interface parity; it stays consistent with buildArgs' resume handling anyway.)
function groomArgs(grooming: Pick<Grooming, 'model' | 'sessionId'>, resume = false): string[] {
  const args = [...STREAM_ARGS];
  if (grooming.model && grooming.model !== 'default') args.push('-m', grooming.model);
  args.push('--tools', RESEARCH_TOOLS, '--permission-mode', 'dontAsk');
  // Same resume rule as permissionArgs: the session's saved profile wins.
  if (resume && grooming.sessionId) args.push('--resume', grooming.sessionId);
  else args.push('--sandbox', 'read-only');
  return args;
}

/**
 * Hand the prompt to Grok. Its headless mode does not read piped stdin (verified
 * — see the header), so the prompt has to arrive as an argument. We write it to a
 * temp FILE and pass `--prompt-file` rather than inlining it with `-p`: prompts
 * here are user-written and framed with a persona preamble and add-on
 * instructions, and a large one would blow the OS argv limit — 32 KB for a whole
 * Windows command line, 128 KB for a single argv entry on Linux — which `-p`
 * would turn into a spawn failure on exactly the biggest, most valuable tasks.
 *
 * The file goes in the OS temp dir, never in the repo (it must not show up in the
 * worktree or the task's diff), is mode 0600 because a prompt is the user's own
 * task content in a directory that can be world-readable, and is deleted by the
 * `cleanup` the runner calls once the child is gone.
 */
function promptArgs(prompt: string): PromptDelivery {
  const file = path.join(os.tmpdir(), `srpopo-grok-${crypto.randomUUID()}.md`);
  fs.writeFileSync(file, prompt, { mode: 0o600 });
  return {
    args: ['--prompt-file', file],
    cleanup: () => fs.rmSync(file, { force: true }),
  };
}

// Subscription-only env: strip XAI_API_KEY so a run always uses the `grok login`
// credentials, never a metered API key. The shared base already drops the
// nested-session markers. Grok has no custom-model env layer in Sr. Popo (that's
// a Claude/Bedrock concept), so `model` is unused here.
function childEnv(_model: string | undefined): NodeJS.ProcessEnv {
  const env = baseChildEnv();
  delete env.XAI_API_KEY;
  return env;
}

// Best-effort resolved model for the card's chip. `end` doesn't echo the model,
// but modelUsage is keyed by the models the turn actually billed, so the busiest
// key is the main agent's (subagents can add their own rows).
function mainModel(modelUsage: Record<string, any> | undefined): string | null {
  const rows = Object.entries(modelUsage || {});
  if (!rows.length) return null;
  let best = rows[0];
  for (const row of rows) {
    if ((Number(row[1] && row[1].modelCalls) || 0) > (Number(best[1] && best[1].modelCalls) || 0)) best = row;
  }
  return best[0];
}

// Grok's spend fields use the same names server/usage.ts already reads
// (usage.input_tokens / cache_read_input_tokens / output_tokens, num_turns, and
// modelUsage.*.{inputTokens,outputTokens,cacheReadInputTokens,costUSD}), so the
// terminal event is handed to the ledger untouched, exactly as the Claude adapter
// passes its `result` through. Fields Grok doesn't report (duration_ms,
// cache_creation_input_tokens) are simply absent and read as 0 there.
function resultFrom(event: Record<string, any>, isError: boolean): NormalizedResult {
  return {
    isError,
    // Present only when the server stamped a complete cost — Grok omits it on the
    // OAuth/subscription path far more often than not, and omits it entirely when
    // the cost was partial. Absent means "unreported", never "free", which is why
    // the board shows "—" rather than $0 for a Grok run with no cost (see app.js).
    costUsd: Number(event.total_cost_usd) || 0,
    numTurns: typeof event.num_turns === 'number' ? event.num_turns : null,
    durationMs: null, // Grok's end event carries no duration
    // Grok streams the response as `text` deltas and repeats none of it on `end`.
    // Reassembling it would mean holding per-run state in this module-level
    // adapter, which several concurrent runs share — so, like the Codex adapter,
    // the result carries no text. Nothing that runs on Grok needs it: dispatch
    // only reads errorReason, and grooming / code review / ask / memory (the
    // flows that parse result text) always run on Claude.
    text: '',
    errorReason: isError ? (typeof event.message === 'string' ? event.message : null) : null,
    usageEvent: event,
  };
}

// Normalize one line of `grok --output-format streaming-json`. Only `end` and
// `error` carry result semantics; text/thought/max_turns_reached/auto_compact_*
// are logged verbatim for the timeline and drive nothing.
function parseLine(line: string): NormalizedEvent | null {
  if (!line.trim()) return null;
  // The parsed Grok event. Loosely typed (see claude.ts parseLine); `log` records
  // it verbatim and we only read the fields documented in the header.
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return { log: { type: 'raw', text: line } };
  }

  const out: NormalizedEvent = { log: event };
  switch (event.type) {
    case 'end':
      // The one event that is both the session identity and the result: Grok
      // reports its session id only here, at the end of the run.
      out.session = { sessionId: event.sessionId, model: mainModel(event.modelUsage) };
      out.result = resultFrom(event, false);
      break;
    case 'error':
      // A prompt-level failure. It may carry frozen spend fields when usage was
      // already recorded, so it goes through the same passthrough as `end`.
      out.result = resultFrom(event, true);
      break;
    default:
      break;
  }
  return out;
}

export const GrokAdapter: AgentAdapter = {
  id: 'grok',
  bin: GROK_BIN,
  label: 'grok',
  childEnv,
  buildArgs,
  groomArgs,
  promptArgs,
  parseLine,
};

export { GROK_BIN, RESEARCH_TOOLS, buildArgs, groomArgs, childEnv, parseLine, promptArgs, permissionArgs, allowArgs };
