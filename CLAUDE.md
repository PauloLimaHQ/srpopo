# CLAUDE.md

Guidance for Claude Code (and any AI agent) working in this repository.

## What Sr. Popo is

Sr. Popo is a **local orchestrator hub for Claude Code tasks**. You queue prompts
against your own git repositories on a Kanban board, dispatch them, and watch each
`claude` CLI session stream live — tool calls, subagents, cost, and the final diff —
from one place. It runs entirely on the user's machine and drives their existing
Claude **subscription** login (never an API key).

The whole point is to let a developer run **many Claude Code sessions in parallel**
and review the results calmly, instead of babysitting one terminal at a time.

Ship changes that keep it: **local-first, dependency-light, and obviously safe.**

## Repository map

The Node-side code (`server/**`, `electron/**`, `tests/**`) is **TypeScript**,
compiled by `tsc` to `dist/` and run in dev with [`tsx`](https://tsx.is) (no
pre-compile step in dev). `public/**` stays vanilla browser JavaScript, served
static with **no build step** (see Conventions).

| Path | Role |
|---|---|
| `server/index.ts` | Express REST API + static UI host. Binds `127.0.0.1` only. |
| `server/runner.ts` | Spawns/kills an agent CLI and streams its output. Provider-agnostic: it drives an `AgentAdapter` and reacts to normalized events (see "Agent backends"). |
| `server/agents/types.ts` | The `AgentAdapter` interface + `NormalizedEvent`/`NormalizedResult` — the seam that lets a task run on `claude` or `codex`. |
| `server/agents/claude.ts` | `ClaudeAdapter`: the `claude` CLI backend (bin, subscription env stripping, `buildArgs`/`groomArgs`, permission-bridge wiring, `stream-json` `parseLine`). A verbatim lift of the old inline runner behavior. |
| `server/agents/codex.ts` | `CodexAdapter`: the OpenAI Codex CLI backend (`codex exec --json`, stdin prompt, sandbox/approval mapping, `OPENAI_API_KEY` stripping, JSONL `parseLine`). |
| `server/agents/env.ts` | Shared nested-session env scrubbing both adapters build on. |
| `server/store.ts` | JSON persistence (`db.json`) + append-only per-task NDJSON logs. |
| `server/tasks.ts` | Task lifecycle service (`createTask`/`dispatchTask` + capacity gate) shared by the REST API and the MCP server, so both queue/run tasks identically. |
| `server/mcp.ts` | **Board MCP server** (see "MCP server" below). Streamable-HTTP MCP endpoint mounted on the Express app at `POST /mcp` so outside MCP clients can drive the board while Sr. Popo runs. |
| `server/git.ts` | Worktree lifecycle (`git worktree add/remove`). |
| `server/github.ts` | Read-only `gh` CLI lookup of a task's pull request. |
| `server/bus.ts` | Server-Sent Events fan-out for the live board + timeline. |
| `server/addons.ts` | Catalog of opt-in task behaviors (see "Add-ons" below). |
| `server/personas.ts` | Catalog of expert-persona role preambles. |
| `server/permissions.ts` | In-memory registry of pending tool-approval prompts (see "Interactive permissions"). |
| `server/permission-mcp.js` | **Stays plain JS.** Standalone MCP stdio bridge `claude` spawns to ask before running a tool — kept JS so it runs without a TS loader in both dev and the packaged app. `tsc` copies it into `dist/` untouched (`allowJs`). |
| `server/groomer.ts` | Meta-prompt + result parser for "Brief an Idea" (see "Grooming" below). |
| `server/types.ts` | Shared interfaces (`Task`, `Repo`, `Db`, `Decision`, …). Typing only. |
| `server/paths.ts` | Resolves the app root (`public/`, `assets/`, `build/`) from source or `dist/`. |
| `electron/main.ts` | macOS tray/menu-bar app shell; boots the server on a local port. |
| `electron/preload.ts` | Minimal, safe `contextBridge` (folder picker, base URL). |
| `public/` | Dependency-free vanilla-JS Kanban UI (`app.js`, `index.html`, `styles.css`). No build step. |
| `public/icons.js` | Inline-SVG icon set (Lucide) + a tiny renderer/hydrator. The only source of UI glyphs — no emojis. |
| `tests/smoke.test.ts` | `node:test` smoke suite, run via `tsx`. |
| `tsconfig.json` | `tsc` config: CommonJS output → `dist/`, `strict`, `rootDir: "."`. |
| `dist/` | Compiled JS (gitignored). What Electron + electron-builder load. |

## Commands

```bash
npm start          # build (tsc) then launch the Electron desktop app (dev, fixed port 7777)
npm run server     # plain web server only, via tsx — http://localhost:7777
npm run server:dev # server with tsx watch reload
npm run build      # tsc → compile server/ + electron/ to dist/
npm run typecheck  # tsc --noEmit (type-check only, no output)
npm run lint       # ESLint (flat config, eslint.config.js — TS + public/ JS)
npm test           # node:test smoke suite, run through tsx
npm run pack       # build, then unpacked app (quick local check)
npm run dist:mac   # build, then signed-less macOS .dmg/.zip → release/
npm run dist:win   # build, then Windows installer → release/
```

Always run `npm run typecheck && npm run lint && npm test` before proposing a
change is done. `npm run server` / `npm test` run the TypeScript directly with
`tsx` (no build needed); the Electron and `dist:*`/`pack` scripts compile to
`dist/` first.

## The task lifecycle (the product's core "workflow")

A task moves through fixed board columns. Preserve these names and semantics — the
UI, the API, and `runner.ts` all agree on them:

`backlog` → `ready` → **`running`** → `review` → `done`, with `failed` as a side
state. (Grooming cards are a separate entity with their own lifecycle — see
"Grooming" below — and live in their own locked, leftmost column.)

- **backlog / ready** — configured but not dispatched.
- **running** — a live `claude -p --output-format stream-json` process. Set only by
  `runner.dispatch`, never via `PATCH /api/tasks/:id` (the API rejects that on purpose).
- **review** — finished successfully; the user inspects the diff/log.
- **failed** — non-zero exit or `is_error` result; shown in Review with a red badge.
- **done** — accepted by the user.

Dispatch runs the prompt fresh; a follow-up with an existing `sessionId` resumes the
same session (`claude --resume`). A worktree is materialized lazily on first dispatch
when `useWorktree` is set.

## Agent backends (Claude & Codex)

A task carries `task.agent` (`'claude'` — the default — or `'codex'`). `runner.ts`
is provider-agnostic: it picks an **`AgentAdapter`** (`server/agents/*`) by
`task.agent` and reacts only to `NormalizedEvent`s the adapter's `parseLine`
produces. The adapter owns everything provider-specific — the binary, the
subscription-only env stripping, `buildArgs`/`groomArgs`, and the JSONL
normalizer. Adding a backend means adding an adapter; the runner doesn't change.
Both backends keep Sr. Popo's ergonomics: local-only, **subscription login (never
an API key)**, streamed to the board, no new runtime dependency.

- **`ClaudeAdapter`** — `claude -p --output-format stream-json`. Strips
  `ANTHROPIC_API_KEY`; owns the interactive permission bridge
  (`--permission-prompt-tool`, see "Interactive permissions"). Behavior is a
  verbatim lift of the old inline runner code, so Claude runs are unchanged.
- **`CodexAdapter`** — `codex exec --json` (subscription auth is `codex login`).
  Strips `OPENAI_API_KEY`. Prompt is delivered on **stdin** (trailing `-`);
  resume maps onto `codex exec resume <sessionId>`. `permissionMode` maps onto a
  Codex **sandbox** (`--sandbox read-only|workspace-write|danger-full-access` +
  `--ask-for-approval never`), since Codex has no per-tool approval hook — the
  board's Allow/Deny prompt UI is hidden for Codex tasks (safety is the sandbox).
  Grooming always runs on Claude. Codex subscription runs report **tokens, not a
  dollar cost**, so the usage ledger records tokens with `costUsd: 0` and the UI
  shows "—" for cost rather than a misleading $0.

The Codex JSONL schema (`thread.started` → session id, `item.completed`,
`turn.completed`/`turn.failed`) was verified against a live `codex exec --json`
run — see the header comment in `server/agents/codex.ts` for the captured shapes.

## Non-negotiable invariants

Breaking any of these is a security or trust regression — call it out loudly if a task
would require it.

1. **Bind to `127.0.0.1` only.** Never expose the server on `0.0.0.0` or a LAN address.
   There is no auth layer; localhost binding *is* the security boundary.
2. **Never use an API key.** Each backend's adapter strips its provider key from every
   spawned task — `ANTHROPIC_API_KEY` for Claude, `OPENAI_API_KEY` for Codex — so runs
   always use the subscription login (`claude` / `codex login`). Keep them stripped.
3. **Strip nested-session env** (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`) so Sr. Popo can
   itself be launched from Claude Code without confusing the child. Shared by both
   backends (`server/agents/env.ts`).
4. **Data stays local and per-user.** `SRPOPO_DATA_DIR` (Electron `userData`) holds
   `db.json` + `logs/`. Don't send task content anywhere off-machine.
5. **Renderer stays sandboxed.** `contextIsolation: true`, `nodeIntegration: false`.
   The UI talks to the server over HTTP; the preload bridge stays minimal.

## Conventions

- **TypeScript, CommonJS output** for all Node-side code (`server/**`,
  `electron/**`, `tests/**`), Node 18+. `tsconfig.json` emits `module: commonjs`
  so `require`/`module.exports` still resolve exactly as before — `dist/` must
  stay loadable the same way today's JS is. Write ESM `import`/`export` in the
  `.ts` sources; keep `strict` on and type things properly. Dev/test run via
  `tsx` (no pre-compile); `tsc` builds `dist/` for Electron and packaging.
  Exception: `server/permission-mcp.js` stays plain JS (it's spawned as a
  standalone Node process and must run without a TS loader).
- **`public/**` stays vanilla browser JS with no build step** — no bundler, no
  framework, served static. That invariant is unchanged by the TS migration.
- **Keep runtime dependencies minimal.** `express` is the only entry in
  `dependencies`. Everything TypeScript-related (`typescript`, `tsx`,
  `typescript-eslint`, `@types/*`) is a **devDependency** — nothing new ships at
  runtime. Don't add a frontend framework.
- 2-space indent, single quotes, semicolons — match the existing files and ESLint.
- **No emojis in the UI — use icons.** Glyphs come from `public/icons.js`, a small
  inline-SVG set of [Lucide](https://lucide.dev) icons (the same open source set
  shadcn/ui uses; ISC-licensed, inlined so there's no icon font, network fetch, or
  build step). They inherit `currentColor`, so they theme for free. In static HTML
  drop a placeholder — `<span class="i" data-icon="play"></span>` — that
  `hydrate()` fills on load; in dynamic markup call `srpopoIcons.svg('play')`
  inside the template string (its output is trusted markup — never pass it through
  `esc()`). Need a new glyph? Add one entry to the `ICONS` map in `icons.js`. Emojis
  are still acceptable where SVG can't reach — e.g. OS notification text — but avoid
  them there too when a plain phrase reads just as well.
- Persist state through `store.save()` and broadcast changes via `bus.broadcast()` so
  every connected board updates live. New task fields go in the object built in
  `POST /api/tasks` (and, if user-editable, the `allowed` list in `PATCH`).
- Prefer small, single-purpose modules in `server/`; keep the API thin.

## Add-ons: how to extend task behavior

`server/addons.ts` is the single source of truth for optional per-task behaviors
(e.g. "open a PR at the end", "self-review the diff"). Each entry drives **both** the
UI checkbox (`GET /api/addons`) and the extra prompt text injected at dispatch. To add
one, append an entry with `{ id, label, hint, instruction, allow? }` — nothing else
changes. The `instruction` is appended to the user's prompt, so write it as a clear,
standalone directive to Claude. The optional `allow` array lists the `--allowedTools`
patterns the behavior needs auto-approved (e.g. the "open a PR" add-on allows `gh` and
git commit/push) so the headless run doesn't silently finish without doing the work;
`runner.effectiveAllowedTools` merges these on top of the task's own allow-list and the
safe package-manager defaults (`DEFAULT_ALLOWED_TOOLS`: npm/pnpm/yarn) at dispatch.

## Interactive permissions (ask instead of auto-deny)

A headless `claude -p` run auto-**denies** any tool it isn't told to allow, so a task
can otherwise "finish" without doing the work. When a task has `promptPermissions` set
(the default; a New-Task checkbox toggles it), the run instead **asks the user** before
running an unapproved tool. Whitelisted tools (task allow-list, add-on `allow`, defaults)
still auto-approve; only the leftovers prompt. Skipped under `bypassPermissions`.

The wiring:
- **`runner.buildArgs`** adds `--permission-prompt-tool mcp__srpopo__approve` and a
  `--mcp-config` that registers **`server/permission-mcp.js`** — a tiny, dependency-free
  MCP **stdio** bridge (newline-delimited JSON-RPC 2.0). It runs as plain Node even
  inside the packaged Electron binary via `ELECTRON_RUN_AS_NODE=1`.
- When `claude` needs approval it calls the bridge's `approve` tool; the bridge POSTs
  `{ tool_name, input }` to `POST /api/tasks/:id/permission` (the server's base URL is
  handed to the runner via `runner.setBaseUrl` on boot) and **blocks** on the response.
- That endpoint registers a pending request in **`server/permissions.ts`**, broadcasts a
  `permission` event, and holds the connection open until the user answers. The board
  renders Allow/Deny; `POST /api/tasks/:id/permissions/:reqId` resolves it. The reply to
  the bridge is the CLI's contract: `{ behavior:'allow', updatedInput? }` or
  `{ behavior:'deny', message }`. Unanswered prompts auto-deny after 30 minutes; a
  stopped/exited run (`runner` exit → `permissions.rejectForTask`) or a dropped bridge
  connection (`res` close) denies any still pending.
- Pending prompts are **process-local and never persisted** — they only make sense while
  the `claude` child is alive. `GET /api/state` annotates each task with its live
  `pendingPermissions` so a reconnecting board rebuilds the prompts.
- **Auto-approve ("AUTO MODE").** While a run is live the user can flip it into
  auto-approve (a drawer toggle, or **Shift+Tab** with the task's drawer focused).
  `POST /api/tasks/:id/auto-approve` calls `permissions.setAutoApprove`: any tool that
  would otherwise prompt is allowed immediately (still logged with `reason:'auto'`), and
  turning it on approves the whole pending backlog at once. Also process-local — cleared
  by `rejectForTask` when the run ends — and surfaced on `GET /api/state` as
  `autoApprovePermissions` plus a live `permission`/`action:'auto'` broadcast.

Note: `--permission-prompt-tool` is a stable but undocumented CLI flag; the request/reply
shapes here match what the CLI expects. If you change the bridge protocol, re-verify the
handshake against a real run — the smoke suite covers the pieces but not the live CLI.

## MCP server: drive the board from outside

Sr. Popo exposes its own board as an **MCP server** for as long as it's running, so
an outside MCP client — e.g. a separate Claude Code session — can list, create,
dispatch, and stop tasks. It's mounted straight onto the Express app at `POST /mcp`
using MCP's **Streamable HTTP** transport (`server/mcp.ts`); connect with:

```bash
claude mcp add --transport http srpopo http://127.0.0.1:7777/mcp
```

Don't confuse this with `server/permission-mcp.js`: that one is a per-task **stdio**
bridge the CLI spawns to *ask the user* about a tool; this one is a long-lived
**HTTP** server that *lets a client drive the board*. Both are hand-rolled JSON-RPC
2.0 to keep the app dependency-light — no MCP SDK.

- **Tools:** `list_repos`, `list_tasks`, `get_task`, `create_task`, `dispatch_task`,
  `stop_task`. They go through `server/tasks.ts` (the same code path as the REST
  routes), so a task queued over MCP is identical to one queued from the board.
- **Stateless** — no `Mcp-Session-Id`; a client just POSTs each JSON-RPC message and
  gets a single JSON reply (or `202` for a notification-only batch). `GET`/`DELETE
  /mcp` return `405` (no server-initiated stream, no sessions).
- **No new security boundary.** There's no auth — the endpoint rides the same
  `127.0.0.1`-only bind as `/api`, which *is* the boundary (invariant #1). It exposes
  exactly the task-control power the local REST API already does. Keep it localhost.
- To add a tool, append a `TOOL_DEFS` entry (name + JSON `inputSchema`) and a `case`
  in `callTool`; the pure `respond()` handler and the smoke tests cover the protocol.

## Grooming: "Brief an Idea"

Grooming is an **installable plugin** (`grooming` in `server/plugins.ts`) — the
"Brief an Idea" button, the board's Grooming column, and `POST /api/groomings` only
surface once it's installed. (The Linear import routes through the same pipeline but
is gated on its own plugin, not this one.)

A grooming is **not a task** — it's its own entity (`db.groomings`, `Grooming` in
`types.ts`) with its own lifecycle and REST routes (`/api/groomings/...`): **draft**
(gray, parked) → **running** (purple, set only by `runner.groom`) → **awaiting**
(amber — see below) → **finished** (green) or **failed**. Its card never leaves the
Grooming column — the first, locked column on the board (no drag in or out); the
status only recolors the card in place. Finished cards link to the tasks they spawned
and can be archived or deleted (deletion also drops the session log; spawned tasks are
independent and are kept).

Running a card kicks off a **read-only** `claude -p` session in the repo (only
research tools are auto-approved — see `groomArgs`; no worktree is ever created and
nothing is written, so there's nothing on disk to clean up). Its job is to think the
idea through and propose **one or more** self-contained task prompts.
`server/groomer.ts` owns the meta-prompt and the parser that recovers the
`{ tasks: [{ title, prompt, ready }] }` spec (emitted between `@@SRPOPO_SPEC_*@@`
sentinels). On success `spawnGroomedTasks` (in `index.ts`) creates the tasks — in
`backlog` or `ready` per the card's `target` (`backlog` | `ready` | `auto`, where
`auto` honors each spec's own `ready` flag) — and the card finishes with their ids on
`grooming.taskIds`; each spawned task keeps the original idea on `task.brief` and a
back-pointer on `task.groomingId`. To change how ideas are groomed, edit
`groomer.ts` — it is the single source of truth for that flow.

**Clarification loop (`awaiting`).** Rather than always inferring, the session may
pause and ask the developer to clarify a genuine decision (scope, product behavior, a
fork in the approach) before writing a spec. It emits `{ questions: [{ question,
options, allowText }] }` between the same sentinels (parsed by `groomer.parseQuestions`,
checked before `parseResult`); each question can carry suggested `options` and/or a
free-text answer (`allowText`), mirroring Claude Desktop's ask-with-choices prompt.
The card lands in `awaiting` with the questions on `grooming.questions` and its
`sessionId` **kept** (the only grooming state that keeps one), and the drawer renders a
form. Answering `POST /api/groomings/:id/answers` builds `groomer.answersPrompt(...)`
and **resumes** the same session (`runner.groom` with a `resumePrompt` → `claude
--resume`), which then finishes (or, rarely, asks again). An `awaiting` card survives a
server restart (the claude session is resumable); `POST /api/groomings/:id/run`
re-grooms from scratch, discarding the pending questions.

## Maintaining this repo with Claude (the meta-workflow)

Sr. Popo is built to maintain itself. Prefer this loop for non-trivial changes:

1. **Register this repo** in Sr. Popo (📁 Repos) and open a **New Task** with a focused
   prompt. Enable **Worktree** so work runs isolated on a `srpopo/<slug>` branch.
2. Turn on the **"self code review"** add-on for anything non-trivial, and the
   **"open a PR"** add-on when you want the run to finish with a `gh pr create`.
3. **Dispatch**, then review the streamed session in the **Review** column: read the
   diff, the tool calls, and the final cost/turns before accepting.
4. Locally, whether the change came from Sr. Popo or a direct session, gate it on:
   ```bash
   npm run typecheck && npm run lint && npm test
   ```
5. Keep commits small and conventional; open a PR (see `CONTRIBUTING.md`). CI
   (`.github/workflows/ci.yml`) re-runs typecheck/lint/test and packages on macOS + Windows.

When you (Claude) work here directly: make the smallest change that satisfies the task,
respect the invariants above, run lint + test, and summarize the diff and any risks.

## Gotchas

- Orphaned `running` tasks from a crash are auto-marked `failed` on server start
  (`store.js`) — don't "fix" that by resurrecting them as running.
- `db.json` is written atomically (temp file + rename) and debounced; go through
  `store.save()` rather than writing it directly.
- The packaged app runs from a read-only bundle — never write inside the app dir; use
  `SRPOPO_DATA_DIR`.
- Builds are unsigned for now; don't add signing/notarization steps without the
  credentials being configured.
