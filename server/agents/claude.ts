/*
 * ClaudeAdapter — the `claude` CLI backend. This is a near-verbatim lift of the
 * behavior that used to live inline in server/runner.ts: the binary name, the
 * subscription-only env stripping, the custom-model env, the `--allowedTools`
 * merging, buildArgs/groomArgs, the interactive permission-bridge wiring, and
 * the NDJSON `stream-json` parsing. Keeping it here (behind the AgentAdapter
 * seam) leaves Claude runs byte-for-byte identical while letting other backends
 * plug in — see server/agents/codex.ts.
 */
import path from 'path';

import { db } from '../store';
import * as addons from '../addons';
import * as repoSpecs from '../repoSpecs';
import { baseChildEnv } from './env';
import type { AgentAdapter, NormalizedEvent } from './types';
import type { Grooming, Task } from '../types';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// Tools every dispatched task gets auto-approved. The common package managers are
// safe, near-universal build steps (install, lint, test, build); allowing them by
// default means a run doesn't silently finish without doing the work just because
// `acceptEdits` would have blocked the Bash call. Add-ons layer their own tools on
// top of these (see addons.allowedToolsFor).
const DEFAULT_ALLOWED_TOOLS = ['Bash(npm:*)', 'Bash(pnpm:*)', 'Bash(yarn:*)'];

// Interactive permission prompting (see permissions.ts + permission-mcp.js). When
// a task opts in, we register our MCP bridge and tell the CLI to route any tool it
// would otherwise auto-deny through it, so the user can approve from the board.
const MCP_SERVER_NAME = 'srpopo';
const PERMISSION_TOOL = `mcp__${MCP_SERVER_NAME}__approve`;
// The bridge stays plain JavaScript so it runs without a TS loader when the CLI
// spawns it as a standalone Node process (in dev under tsx and in the packaged
// app). It sits beside the compiled runner in both source (server/) and compiled
// (dist/server/) layouts. In source this file is server/agents/claude.ts, so the
// bridge is one directory up.
const PERMISSION_MCP_SCRIPT = path.join(__dirname, '..', 'permission-mcp.js');

// The server's own base URL, set once the port is known (see index.start). The
// permission bridge POSTs approval requests back here.
let baseUrl: string | null = null;
function setBaseUrl(url: string): void { baseUrl = url; }
function resolvedBaseUrl(): string {
  return baseUrl || `http://127.0.0.1:${process.env.PORT || 7777}`;
}

// The `--mcp-config` JSON that registers the permission bridge for a task. The
// bridge runs as plain Node even inside the packaged Electron binary via
// ELECTRON_RUN_AS_NODE, and learns where to POST via SRPOPO_APPROVAL_URL.
function permissionMcpConfig(task: Partial<Task>): string {
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: process.execPath,
        args: [PERMISSION_MCP_SCRIPT],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          SRPOPO_APPROVAL_URL: `${resolvedBaseUrl()}/api/tasks/${task.id}/permission`,
        },
      },
    },
  });
}

// Base child env for a claude run: the shared nested-session strip plus the
// subscription-only guard (never let an API key leak into task runs — invariant #2).
function childEnv(): NodeJS.ProcessEnv {
  const env = baseChildEnv();
  delete env.ANTHROPIC_API_KEY;
  return env;
}

// Extra environment variables for a run whose model is a user-defined custom
// model (Settings → Models) — e.g. `CLAUDE_CODE_USE_BEDROCK=1` and the AWS region
// for an Amazon Bedrock model. Empty for the built-in models. Matched by the id
// passed to `--model`; the first custom model with that id wins. ANTHROPIC_API_KEY
// is already stripped from the stored env (server/index.ts) but is re-guarded here
// so invariant #2 holds regardless of how the entry got into db.json.
function modelEnv(model: string | undefined): NodeJS.ProcessEnv {
  if (!model || model === 'default') return {};
  const custom = (db.settings.customModels || []).find((m) => m.model === model);
  if (!custom || !custom.env) return {};
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(custom.env)) {
    if (k === 'ANTHROPIC_API_KEY') continue;
    out[k] = v;
  }
  return out;
}

// The full environment a run's `claude` child gets: the base childEnv() plus any
// custom-model vars (modelEnv) on top. ANTHROPIC_API_KEY is dropped by both, so a
// custom model can never restore it — invariant #2 holds regardless of model.
function buildTaskEnv(model: string | undefined): NodeJS.ProcessEnv {
  return { ...childEnv(), ...modelEnv(model) };
}

// Normalize a free-text allow-list into a clean comma-joined string for
// `--allowedTools`. Patterns may contain spaces (e.g. `Bash(npm run lint:*)`),
// so we split only on commas and newlines — never spaces.
function normalizeAllowedTools(value: unknown): string {
  if (typeof value !== 'string') return '';
  const list = value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return list.join(',').slice(0, 2000);
}

// Merge any number of allow-list sources (comma/newline strings or arrays of
// patterns) into one deduped, comma-joined `--allowedTools` value. Order is
// preserved and the total is capped like normalizeAllowedTools.
function mergeAllowedTools(...sources: unknown[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const src of sources) {
    const list = Array.isArray(src) ? src : String(src || '').split(/[,\n]/);
    for (const raw of list) {
      const tool = String(raw).trim();
      if (tool && !seen.has(tool)) {
        seen.add(tool);
        out.push(tool);
      }
    }
  }
  return out.join(',').slice(0, 2000);
}

// For a task imported from a repo spec whose repo declares an index command, the
// tool that runs it (e.g. `Bash(node:*)`) so the spec-completion step can
// regenerate the index headless — the same auto-approve treatment add-ons get.
function specAllowedTools(task: Partial<Task>): string[] {
  if (!task.specOrigin || !task.repoPath) return [];
  const tool = repoSpecs.indexCommandTool(repoSpecs.readSpecConfig(task.repoPath));
  return tool ? [tool] : [];
}

// The full set of tools auto-approved for a dispatched task: the user's own
// allow-list, the safe package-manager defaults, whatever the selected add-ons
// need to run (e.g. `gh` + git for "open a PR"), and — for a spec import — the
// repo's declared index command.
function effectiveAllowedTools(task: Partial<Task>): string {
  return mergeAllowedTools(
    task.allowedTools,
    DEFAULT_ALLOWED_TOOLS,
    addons.allowedToolsFor(task.addons),
    specAllowedTools(task),
  );
}

function buildArgs(task: Partial<Task>, resume: boolean): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (task.model && task.model !== 'default') args.push('--model', task.model);
  if (task.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  else if (task.permissionMode && task.permissionMode !== 'default') args.push('--permission-mode', task.permissionMode);
  const allow = effectiveAllowedTools(task);
  if (allow) args.push('--allowedTools', allow);
  // Opt-in: route otherwise-denied tools to an interactive approval prompt rather
  // than auto-denying them. Skipped under bypassPermissions (nothing to prompt).
  if (task.promptPermissions && task.permissionMode !== 'bypassPermissions') {
    args.push('--permission-prompt-tool', PERMISSION_TOOL);
    args.push('--mcp-config', permissionMcpConfig(task));
  }
  if (resume && task.sessionId) args.push('--resume', task.sessionId);
  return args;
}

// Read-only args for a grooming session: it explores the repo to write better
// prompts but must never modify it. Only the safe research tools are auto-
// approved in this headless run, so any write tool is denied. `resume` continues
// the same session after the developer answers its clarifying questions.
function groomArgs(grooming: Pick<Grooming, 'model' | 'sessionId'>, resume = false): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (grooming.model && grooming.model !== 'default') args.push('--model', grooming.model);
  args.push('--allowedTools', 'Read,Grep,Glob,Bash(git log:*),Bash(git diff:*),Bash(git show:*)');
  if (resume && grooming.sessionId) args.push('--resume', grooming.sessionId);
  return args;
}

// Normalize one line of the `claude --output-format stream-json` feed. This is a
// faithful extraction of the switch that used to live in runner.launch:
//   system/init  -> sessionId + resolved model
//   assistant    -> `Task` tool_use opens a subagent
//   user         -> tool_result closes a subagent
//   result       -> cost/turns/duration + final text + isError
// The runner logs `log` verbatim, exactly as it recorded the parsed event before.
function parseLine(line: string): NormalizedEvent | null {
  if (!line.trim()) return null;
  // The parsed stream-json event. Loosely typed: the CLI's shapes are a moving
  // target and we only read a handful of fields; `log` records it verbatim.
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return { log: { type: 'raw', text: line } };
  }

  const out: NormalizedEvent = { log: event };
  if (event.type === 'system' && event.subtype === 'init') {
    out.session = { sessionId: event.session_id, model: event.model };
  } else if (event.type === 'assistant') {
    const blocks = (event.message && event.message.content) || [];
    const opened: string[] = [];
    for (const b of blocks) {
      if (b.type === 'tool_use' && b.name === 'Task' && !event.parent_tool_use_id) opened.push(b.id);
    }
    if (opened.length) out.subagentsOpened = opened;
  } else if (event.type === 'user') {
    const blocks = (event.message && event.message.content) || [];
    if (Array.isArray(blocks)) {
      const closed: string[] = [];
      for (const b of blocks) {
        if (b.type === 'tool_result') closed.push(b.tool_use_id);
      }
      if (closed.length) out.subagentsClosed = closed;
    }
  } else if (event.type === 'result') {
    out.result = {
      isError: !!event.is_error,
      costUsd: event.total_cost_usd || 0,
      numTurns: event.num_turns,
      durationMs: event.duration_ms,
      text: typeof event.result === 'string' ? event.result : '',
      errorReason: (event.result || event.subtype) || null,
      // The raw result event carries usage/modelUsage/total_cost_usd, which the
      // ledger reads directly — pass it through untouched.
      usageEvent: event,
    };
  }
  return out;
}

export const ClaudeAdapter: AgentAdapter = {
  id: 'claude',
  bin: CLAUDE_BIN,
  label: 'claude',
  childEnv: buildTaskEnv,
  buildArgs,
  groomArgs,
  parseLine,
};

export {
  CLAUDE_BIN,
  DEFAULT_ALLOWED_TOOLS,
  PERMISSION_TOOL,
  setBaseUrl,
  childEnv,
  buildTaskEnv,
  buildArgs,
  groomArgs,
  normalizeAllowedTools,
  mergeAllowedTools,
  effectiveAllowedTools,
  parseLine,
};
