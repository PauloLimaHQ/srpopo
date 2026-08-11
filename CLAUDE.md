# CLAUDE.md

Guidance for Claude Code (and any AI agent) working in this repository.

## What Sr. Popo is

Sr. Popo is a **local orchestrator hub for coding-agent tasks**. You queue prompts
against your own git repositories on a Kanban board, dispatch them, and watch each
agent session stream live — tool calls, subagents, cost, and the final diff — from one
place. Each task picks its backend: **Claude Code** (the default), **OpenAI Codex**
or **xAI Grok** (see "Agent backends"). It runs entirely on the user's machine and
drives their existing **subscription** login (never an API key).

The whole point is to let a developer run **many agent sessions in parallel** and
review the results calmly, instead of babysitting one terminal at a time.

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
| `server/agents/types.ts` | The `AgentAdapter` interface + `NormalizedEvent`/`NormalizedResult`/`PromptDelivery` — the seam that lets a task run on `claude`, `codex` or `grok`. |
| `server/agents/claude.ts` | `ClaudeAdapter`: the `claude` CLI backend (bin, subscription env stripping, `buildArgs`/`groomArgs`, permission-bridge wiring, `stream-json` `parseLine`). A verbatim lift of the old inline runner behavior. |
| `server/agents/codex.ts` | `CodexAdapter`: the OpenAI Codex CLI backend (`codex exec --json`, stdin prompt, sandbox/approval mapping, `OPENAI_API_KEY` stripping, JSONL `parseLine`). |
| `server/agents/grok.ts` | `GrokAdapter`: the xAI Grok CLI backend (`grok --output-format streaming-json`, **temp-file prompt**, permission-mode mapping, `--allow` rules, `XAI_API_KEY` stripping, NDJSON `parseLine`). |
| `server/agents/env.ts` | Shared nested-session env scrubbing every adapter builds on. |
| `server/spawnCompat.ts` | `spawnCompat`: a `child_process.spawn` drop-in that also launches `.cmd`/`.bat` shims on Windows (npm-installed CLIs and editor launchers) by routing through a correctly-escaped `cmd.exe /d /s /c` — used everywhere a binary is launched by bare name instead of the raw `spawn`. |
| `server/store.ts` | JSON persistence (`db.json`) + append-only per-task NDJSON logs. |
| `server/tasks.ts` | Task lifecycle service (`createTask`/`dispatchTask` + capacity gate) shared by the REST API and the MCP server, so both queue/run tasks identically. |
| `server/mcp.ts` | **Board MCP server** (see "MCP server" below). Streamable-HTTP MCP endpoint mounted on the Express app at `POST /mcp` so outside MCP clients can drive the board while Sr. Popo runs. |
| `server/git.ts` | Worktree lifecycle (`git worktree add/remove`). |
| `server/desktop.ts` | Desktop hand-offs for the workspace quick actions: reveal a checkout in the OS file manager, or open it in the user's IDE (see "Workspace quick actions"). |
| `server/resources.ts` | Opt-in resource monitor: samples the OS process table and reports what the app and each live agent session cost this machine (see "Resource monitor"). |
| `server/github.ts` | `gh` CLI integration: read-only lookup of a task's pull request, its merge-safety check, the merge itself, and the `mergeable/<n>` grade label. |
| `server/reviewer.ts` | Meta-prompt + verdict parser for the **Code Review** stage (see "Code Review" below). |
| `server/pr-refresh.ts` | Background sweep that keeps validation-column tasks' PR status current (broadcasts a `pr` bus event on change) so a PR merged/closed outside Sr. Popo shows up without opening the task. |
| `server/bus.ts` | Server-Sent Events fan-out for the live board + timeline. |
| `server/addons.ts` | Catalog of opt-in task behaviors (see "Add-ons" below). |
| `server/personas.ts` | Catalog of expert-persona role preambles. |
| `server/permissions.ts` | In-memory registry of pending tool-approval prompts (see "Interactive permissions"). |
| `server/permission-mcp.js` | **Stays plain JS.** Standalone MCP stdio bridge `claude` spawns to ask before running a tool — kept JS so it runs without a TS loader in both dev and the packaged app. `tsc` copies it into `dist/` untouched (`allowJs`). |
| `server/groomer.ts` | Meta-prompt + result parser for "Brief an Idea" (see "Grooming" below). |
| `server/orchestrator.ts` | Meta-prompt + turn-status parser for the orchestrator (see "Goal Orchestration"). |
| `server/orchestrator-engine.ts` | Orchestrator engine: watches the bus and resumes a waiting orchestrator session when its worker tasks land. |
| `server/sentinels.ts` | Tolerant extraction of the sentinel-delimited JSON `groomer.ts`, `orchestrator.ts` and `reviewer.ts` end a turn with. |
| `server/types.ts` | Shared interfaces (`Task`, `Repo`, `Db`, `Decision`, …). Typing only. |
| `server/paths.ts` | Resolves the app root (`public/`, `assets/`, `build/`) from source or `dist/`. |
| `electron/main.ts` | macOS tray/menu-bar app shell; boots the server on a local port. |
| `electron/preload.ts` | Minimal, safe `contextBridge` (folder picker, base URL). |
| `public/` | Dependency-free vanilla-JS Kanban UI. No build step — native ES modules (see "The UI module layout"). |
| `public/app.js` | UI **entry only**: imports the feature modules, calls each one's `init()` in a fixed order, then `boot()`. Don't grow it — new behavior belongs in a feature module. |
| `public/core/` | What every feature needs: `state.js` (the shared board state, `$`, `icon`, column constants) and `api.js` (`api()`, `toast()`, `esc()`, `lookup()`). Imports nothing from `features/` — it is the bottom of the graph. |
| `public/features/` | One module per feature (`board.js`, `task-modal.js`, `drawer.js`, `pr.js`, `autonomous.js`, …). A feature change should touch one file here. |
| `public/icons.js` | Inline-SVG icon set (Lucide) + a tiny renderer/hydrator. Loaded as a **classic script before the module graph**, so it publishes `window.srpopoIcons` rather than exporting. The only source of UI glyphs — no emojis. |
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

`backlog` → `ready` → **`running`** → **`code_review`** → `validation` → `done`, with
`failed` as a side state. (Grooming cards are a separate entity with their own
lifecycle — see "Grooming" below — and live in their own locked, leftmost column.)

- **backlog / ready** — configured but not dispatched.
- **running** — a live `claude -p --output-format stream-json` process. Set only by
  `runner.dispatch`, never via `PATCH /api/tasks/:id` (the API rejects that on purpose).
- **code_review** — a **fresh, read-only reviewer session** grading the branch (see
  "Code Review" below). Like `running` it is a live child process and is therefore
  **runner-owned**: set only by `runner.codeReview`, never via `PATCH` (which rejects
  it and points at `POST /api/tasks/:id/code-review`).
- **validation** — the human validates and accepts the work: the diff, the log, and
  the code-review grade. This is the old `review` column, renamed; `store.ts` migrates
  a legacy `'review'` status to `'validation'` on load.
- **failed** — non-zero exit or `is_error` result; shown in Validation with a red badge.
- **done** — accepted by the user.

Dispatch runs the prompt fresh; a follow-up with an existing `sessionId` resumes the
same session (`claude --resume`). A worktree is materialized lazily on first dispatch
when `useWorktree` is set.

## Code Review: grading the branch before a human looks at it

The stage is **opt-in per task**: `task.autoCodeReview` (a checkbox in New Task, off
by default, editable via `PATCH`) is what lets a finished run flow on into
`code_review`. A task without it goes straight to `validation` — the stage costs one
extra short read-only session, so nothing pays for it unasked. Autonomous Mode forces
the flag on for the tasks it dispatches (`dispatchOne`), since it can only merge graded
work.

When it is on, a successful run parks the task in `validation` and then, **if the task
has an open pull request**, flows into `code_review` (`runner.maybeCodeReview`, called
next to `maybeDistill` in `dispatch`'s success branch). Every guard failing — the flag
off, no branch, no open PR, the parallel-session cap already reached — just leaves the
task in `validation`, with a `proc` log line when there was something to explain.
Nothing is ever retried. The manual route below ignores the flag: an explicit request
always reviews.

- **The run** (`runner.codeReview`) streams into the **same task card**: same NDJSON
  log, one more `runCount`, cost through `usage.applyResult`. It is a *different*
  session though, so it passes `trackSession: false` to `launch()` — `task.sessionId`
  must keep pointing at the implementing session or follow-ups and Autonomous Mode's
  review pass would resume the reviewer instead.
- **The prompt + parser** live in `server/reviewer.ts` (the single source of truth,
  like `groomer.ts` is for grooming): a fresh independent reviewer, read-only on the
  code, that reads the full diff plus surrounding code, posts **one** PR comment with
  `gh pr comment`, and closes its turn with `{ grade, summary, blockers, commentUrl }`
  between the `@@SRPOPO_REVIEW_*@@` sentinels. `reviewArgs` (in
  `server/agents/claude.ts`) allows only the research tools plus `git status` and
  `gh pr view/diff/comment` — never `Write`/`Edit`, never `--resume`, never the
  permission bridge, so anything else is auto-denied by the headless run.
- **The grade** is `1..5`: **1** must not be merged, **2** still not mergeable but
  better than 1, **3** mergeable with reservations, **4** mergeable with only nits,
  **5** good to go. It is recorded in two places — `task.codeReview` (rendered as a
  chip on the card and a verdict block in the drawer) and a `mergeable/<n>` **PR
  label** written by the *server* (`github.setMergeableLabel`, which creates the label
  if missing and removes the other four grades). The agent owns the comment, the
  server owns the label; the reviewer is deliberately not given `gh pr edit`/`gh label`.
- **However it ends** — verdict, unparsable output, failure, or a user stop — the card
  lands in `validation`, never `failed`: the implementation succeeded and the human
  still has to validate it. A review run never triggers another review.
- **Any** dispatch (fresh or a resume — follow-up, review pass, conflict fix) clears
  `task.codeReview`: the verdict describes a diff the run is about to change. It comes
  back on the next code review. A code-review run doesn't go through `dispatch`, so it
  never clears its own verdict.

**Starting one by hand.** `POST /api/tasks/:id/code-review` is the manual equivalent
(the board's `Code Review` action, and dropping a card on the Code Review column):
`404` unknown task, `409` while a run is live, `409 Code Review needs an open pull
request`, `409` at the parallel-session cap. There is no way to fake the status —
`PATCH /api/tasks/:id` accepts only `backlog | ready | validation | done | failed`.

**Autonomous Mode gates its merge on the grade.** Settings > `minMergeGrade`
(`DEFAULT_SETTINGS`, default **4**, validated as an integer 1..5 in
`PATCH /api/settings`) is the lowest grade the engine will merge. In `mergeFlow`, before
the PR check: an ungraded task is sent through `deps.codeReview` once and revisited when
it lands back in `validation`; a task graded below the minimum is never merged — it is
settled with the reason `left-in-validation:grade-<n>` and left for the human. The
engine also treats `code_review` exactly like `running` in `onBus` (still in flight), so
it never drops ownership of a task while the reviewer holds the card.

## Agent backends (Claude, Codex & Grok)

A task carries `task.agent` (`'claude'` — the default — `'codex'` or `'grok'`).
`runner.ts` is provider-agnostic: it picks an **`AgentAdapter`** (`server/agents/*`)
by `task.agent` and reacts only to `NormalizedEvent`s the adapter's `parseLine`
produces. The adapter owns everything provider-specific — the binary, the
subscription-only env stripping, `buildArgs`/`groomArgs`, how the prompt is
delivered, and the JSONL normalizer. Adding a backend means adding an adapter; the
runner doesn't change. Every backend keeps Sr. Popo's ergonomics: local-only,
**subscription login (never an API key)**, streamed to the board, no new runtime
dependency.

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
- **`GrokAdapter`** — `grok --output-format streaming-json` (subscription auth is
  `grok login`). Strips `XAI_API_KEY`. Three things make it the odd one out:
  - **The prompt is not on stdin.** Grok's headless mode ignores piped stdin (it
    falls through to the TUI and dies with "Device not configured"), so the adapter
    implements the optional `AgentAdapter.promptArgs` hook: it writes the prompt to
    a **0600 temp file** outside the repo and returns `--prompt-file <path>` plus a
    `cleanup` the runner calls when the child exits. `--prompt-file` rather than an
    inline `-p` on purpose — a framed prompt can exceed the OS argv limit (32 KB for
    a whole Windows command line), which would break the biggest tasks. This is the
    only reason `launch()` knows about prompt delivery at all; every other backend
    takes the default stdin path.
  - **Permission modes map almost 1:1** (Grok takes `acceptEdits` / `plan` /
    `bypassPermissions` verbatim), with one deliberate translation: Sr. Popo's
    `default` means "ask", and a headless run has nobody to ask, so it becomes Grok's
    **`dontAsk`** — which *denies* anything outside the allow-list instead of waiting
    on a prompt that can never be shown. That reproduces `claude -p`'s auto-deny.
    `plan` additionally gets `--sandbox read-only`; a **resume never re-passes
    `--sandbox`**, because Grok pins a session's profile at creation and refuses a
    resume that passes a different one. Like Codex there is no per-tool approval
    hook, so the board's Allow/Deny prompt UI is hidden for Grok tasks.
  - `--allow` takes **one rule per flag** but understands the same `Tool(pattern)`
    syntax Claude does (`--allowedTools` is a documented compat alias), so the task's
    merged allow-list — user patterns + package-manager defaults + add-on tools —
    carries over verbatim via `claude.effectiveAllowedTools`.
  Its streaming JSON has **no tool-call events** (only `text`/`thought` deltas, `end`,
  `error`), so a Grok run has no subagent tracking and its timeline is the response
  text; the board folds consecutive deltas into one block. The **session id arrives on
  `end`**, i.e. at the end of the run, so a run that dies earlier can't be resumed.
  Its spend fields already use the exact names `server/usage.ts` reads, so the `end`
  event goes to the ledger untouched — but a subscription run usually reports **no
  dollar cost** (Grok stamps cost for API-key traffic), and an absent cost means
  "unreported", never free, so the UI shows "—" plus tokens whenever `costUsd` is 0.

The Codex JSONL schema (`thread.started` → session id, `item.completed`,
`turn.completed`/`turn.failed`) was verified against a live `codex exec --json`
run — see the header comment in `server/agents/codex.ts` for the captured shapes.
Grok's flags, its headless-vs-TUI stdin behavior and its `error` event were verified
against a live `grok 0.2.114`; its **success-path `end` event is the documented
shape, not a captured one** (the machine it was written on wasn't signed in to Grok)
— `server/agents/grok.ts`'s header says exactly which is which. If you change that
parsing, re-verify against a signed-in run.

## Non-negotiable invariants

Breaking any of these is a security or trust regression — call it out loudly if a task
would require it.

1. **Bind to `127.0.0.1` only.** Never expose the server on `0.0.0.0` or a LAN address.
   There is no auth layer; localhost binding *is* the security boundary.
2. **Never use an API key.** Each backend's adapter strips its provider key from every
   spawned task — `ANTHROPIC_API_KEY` for Claude, `OPENAI_API_KEY` for Codex,
   `XAI_API_KEY` for Grok — so runs always use the subscription login (`claude` /
   `codex login` / `grok login`). Keep them stripped.
3. **Strip nested-session env** (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`) so Sr. Popo can
   itself be launched from Claude Code without confusing the child. Shared by every
   backend (`server/agents/env.ts`).
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
  framework, served static. That invariant is unchanged by the TS migration, and
  unchanged by the ES-module split: the browser resolves the imports itself.
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

## The UI module layout (why `public/` is many small files)

The board used to be one 6,300-line `app.js`. It was the single worst file in the
repo to work in: **65% of all commits touched it**, and because a feature's markup
lived in `index.html` and its styling in `styles.css`, **58% of commits touched two
or more of those three files**. Every parallel change collided.

It is now **native ES modules** — still no bundler, no build step, no runtime
dependency. `index.html` loads the entry with `<script type="module" src="app.js">`,
and the browser resolves the graph.

- **`core/state.js`** — the shared `state` object, `$`, `icon`, the column
  constants, and the small predicates over them (`isLive`, `pendingPermissions`).
  It imports nothing from `features/`; keep it that way.
- **`core/api.js`** — `api()`, `toast()`, `esc()`, `lookup()`.
- **`features/<name>.js`** — one feature each. A feature module owns its rendering,
  its event wiring, and its modal.
- **`app.js`** — wiring only. It imports each feature's `init` and calls them.

**The `init()` contract.** A module's load-time side effects (the
`addEventListener` wiring) must live inside an exported `init()`, never at module
top level. Module evaluation order follows the import graph, which changes as
imports change; the `init()` call order in `app.js` is explicit and stable, and
some of those handlers are order-sensitive (several `document`-level `click` and
`keydown` listeners). **Keep the `init()` calls in `app.js` in their current
order** unless you have a specific reason, and add new ones at the position the
feature's wiring should run.

**Working here:** a feature change should touch one file under `features/`. If it
needs a second, that usually means the boundary is wrong — or that the thing you
are adding belongs in `core/`. Note that exports are **read-only bindings**: a
module that needs another module's mutable state changed must call a setter
(see `setSavedAttachments` in `features/task-modal.js`), not assign to the import.

`styles.css` and `index.html` are **not yet split** — that is the next phase, and
until then a feature's markup and CSS still live in those two shared files.

## Add-ons: how to extend task behavior

`server/addons.ts` is the single source of truth for optional per-task behaviors
(e.g. "open a PR at the end", "self-review the diff"). Each entry drives **both** the
UI chip (`GET /api/addons`) and the extra prompt text injected at dispatch. To add
one, append an entry with `{ id, label, short?, hint, icon?, instruction, allow?,
hidden? }` — nothing else changes. The `instruction` is appended to the user's prompt,
so write it as a clear, standalone directive to Claude; `label` doubles as that block's
heading, while `short` + `icon` (a `public/icons.js` glyph) are what the New Task
modal's chip row renders. The optional `allow` array lists the `--allowedTools`
patterns the behavior needs auto-approved (e.g. the "open a PR" add-on allows `gh` and
git commit/push) so the headless run doesn't silently finish without doing the work;
`runner.effectiveAllowedTools` merges these on top of the task's own allow-list and the
safe package-manager defaults (`DEFAULT_ALLOWED_TOOLS`: npm/pnpm/yarn) at dispatch.

`hidden: true` keeps an add-on out of `catalog()` — it stays applicable by id but is
never offered as a checkbox. `code_review` is the one such entry: it isn't a per-task
choice any more, but Autonomous Mode (`REQUIRED_ADDONS`) and the orchestrator's worker
recipe still apply it, so it must keep working.

## Personas (who the agent is)

`server/personas.ts` is the matching catalog for the *start* of the prompt — an expert
role preamble prepended by `framing.framePrompt`. A task either names its personas
(`task.personas`, chosen in the modal's picker) **or** sets `task.autoPersona`, which
swaps `personas.preambleFor` for `personas.autoPreamble()`: the catalog is handed to
the run and it picks its own hat before starting. The two are mutually exclusive — when
`autoPersona` is on, `personas` is kept (so toggling it off restores the selection) but
ignored at dispatch, and the board's card chip shows one or the other, never both.

## Interactive permissions (ask instead of auto-deny)

This whole section is **Claude-only**: `--permission-prompt-tool` is a `claude` CLI
feature, and neither Codex nor Grok exposes an approval hook to bridge (see "Agent
backends"), so their runs are governed by a sandbox / permission mode instead and the
board hides the Allow/Deny UI, the "asks" chip and AUTO MODE for them (one predicate,
`hasPermissionBridge`, in `public/core/api.js`).

A headless `claude -p` run auto-**denies** any tool it isn't told to allow, so a task
can otherwise "finish" without doing the work. `promptPermissions` defaults to `true`
for every task — there's no UI toggle for it, since the only case where you *don't*
want the run to ask is `bypassPermissions` (YOLO), which already skips the prompt on
its own. When set, the run **asks the user** before running an unapproved tool.
Whitelisted tools (task allow-list, add-on `allow`, defaults) still auto-approve; only
the leftovers prompt. Skipped under `bypassPermissions`. Unattended paths that have no
human to answer (autonomous mode's dispatch/review passes, `server/autonomous.ts`)
force it to `false` explicitly.

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
  turning it on approves the whole pending backlog at once. Process-local, but **sticky
  per task**: it deliberately survives `rejectForTask` (a stop, or a run ending to await
  another turn), so redispatching or resuming the same task keeps auto-approve on
  instead of re-prompting — it only turns off via an explicit toggle or
  `permissions.forgetTask` (called when a task is archived, to stop the set growing
  forever). Surfaced on `GET /api/state` as `autoApprovePermissions` plus a live
  `permission`/`action:'auto'` broadcast.

Note: `--permission-prompt-tool` is a stable but undocumented CLI flag; the request/reply
shapes here match what the CLI expects. If you change the bridge protocol, re-verify the
handshake against a real run — the smoke suite covers the pieces but not the live CLI.

## Workspace quick actions (terminal / file manager / IDE)

The workspace header carries the "work on this here" escape hatches, all acting on a
**checkout** — the repo root, or one of the live worktrees listed in the Workspace details
modal (each row has the same three buttons):

- **Terminal** — the in-app shell (`server/terminal.ts`), docked at the bottom.
- **Reveal** — the OS file manager (`open` / `explorer` / `xdg-open`).
- **Open in IDE** — VS Code or a JetBrains IDE.

**How they're surfaced.** Only **Terminal** is a labeled button in the header; Reveal, Open
in IDE, Project memory and Workspace details live behind the adjacent **"…" overflow menu**
(`#workspace-menu`, a `.quick-menu` like the "New Task ▾" one), where each gets a written
name and a line of what it does. They were once five unlabeled glyphs fused into a segmented
pill, which read as a toggle group and said nothing about what any of them did — don't put
a new workspace action back into the header as a bare icon; add a `.quick-menu-item` to that
menu (and, if it's worth a keystroke, a `paletteCommands()` entry under `state.view.repoId`,
where all five are also reachable from ⌘K).

The last two live in `server/desktop.ts` and are exposed as `POST /api/repos/:id/reveal`
and `POST /api/repos/:id/editor` (plus `GET /api/desktop`, which tells the board what this
OS calls its file manager and which editors are actually installed, so the buttons can be
labeled honestly — "Reveal in Finder", "Open in WebStorm"). All three routes resolve their
target through `resolveRepoTarget`, which accepts only the repo root or a path `git
worktree list` reports — these routes can't be pointed at an arbitrary filesystem location.

Editors are launched **server-side**, never from the renderer, so the actions behave the
same in the Electron app and in a browser tab. `desktop.ts` resolves a launcher by scanning
`PATH` plus JetBrains Toolbox's generated-scripts directory (usually absent from a GUI app's
`PATH`), and falls back to `open -a` on the macOS app bundle — so an IDE installed without a
CLI launcher still opens. When neither exists the route 400s with the message that says how
to install the launcher; the board toasts it verbatim. To support another editor, append one
entry to `EDITORS` — nothing else changes.

The chosen IDE is `Settings > defaultEditor` (Settings → General → External tools). It
starts empty: the first click on **Open in IDE** opens an anchored picker of the detected
editors and remembers the pick as the default, so the button works without a detour through
Settings. `POST /api/repos/:id/editor` returns **409** (not 400) when no editor is
configured — that's the board's signal to open the picker rather than toast an error.

## Appearance: two layouts for the same board

Settings → General → **Appearance** holds the two device-local UI preferences.
Both live in `localStorage`, never in `db.json` — the desktop app and a phone
paired over the LAN each keep their own (and there is no server round-trip to
change one).

- **Theme** — `srpopo.theme`: System / Light / Dark, read by an inline `<head>`
  script so the first paint already matches.
- **Layout** — `srpopo.layout`: `classic` (the default: the Super View grid plus
  one repo's board) or `sidebar`, an **experimental** shell that adds a persistent
  project rail left of that same view. Applied by `applyLayout()` in `public/features/theme.js`,
  which sets `body[data-layout]` and shows/empties `#sidebar`; `toggleLayout()` backs
  the ⌘K "Toggle Layout" command.

The **project sidebar** (`renderSidebar` and friends in `public/features/sidebar.js`) lists every
repository with its cards grouped by board column — grooming and orchestration cards
included, empty columns dropped — under an "All projects" entry that returns to the
Super View. It is **navigation only**: clicking a project enters that workspace,
clicking a card opens the same drawer, right-clicking a task opens the same context
menu. Nothing there can change a task's state — no drag-and-drop, no dispatch — so the
board stays the single place work moves. It re-renders off `renderBoard()`, the same
choke point the board uses (a no-op in the classic layout), preserving its scroll
position and which projects are unfolded. The classic layout is untouched by all of it:
with `layout=classic` the rail is hidden *and* emptied.

## Resource monitor (how much of this machine we're using)

Running several agents at once is the whole point of Sr. Popo, so the board can show
what that costs: `server/resources.ts` samples the OS process table and reports CPU +
memory for **this app** and for **each live agent session**, attributed per
task/grooming/orchestration/ask card.

- **Opt-in.** `Settings > resourceMonitor` (Settings → General → Resource monitor,
  default **off**). Nothing is sampled while it's off — `GET /api/resources` answers
  `{ enabled: false }` rather than an error, which is also what tells the board to hide
  its chip. Turning it off calls `resources.reset()` so a re-enable starts from a clean
  CPU baseline instead of a stale delta.
- **How it's attributed.** `runner.liveChildren()` hands over the pid of every live
  agent child (the shared `running` map, so tasks *and* grooming/orchestration/ask
  sessions). Each child's **subtree** is that session's usage; the rest of the tree
  rooted at `process.pid` — board, server, in-app terminals, Electron helpers — is the
  app's. The two partition the same tree, so nothing is double-counted.
- **Units.** CPU is a share of the machine's **total** capacity (all cores), so the
  system, app, and session numbers are comparable. Memory is RSS summed per process
  (shared pages count once per process) — the same caveat every activity monitor has.
- **Platforms.** `ps` on macOS/Linux; a `Get-CimInstance Win32_Process` query on
  Windows, where per-process CPU is derived from cumulative-time deltas (so a cold
  start takes a throwaway baseline first). A platform that can't answer degrades to
  `null` figures plus a `note`, never a failed request.
- **UX.** A top-bar chip (`#btn-resources`) next to the health chip shows
  `CPU · memory` for app + agents and warms/reddens with machine load; clicking it
  opens the breakdown panel (`#resource-panel`). Poll-based, not SSE — this is sampled
  state, not an event: 6s with just the chip, 2s while the panel is open, paused on a
  hidden tab, and parked after a few failed polls until the SSE stream reconnects.
  The panel is a passive read-out; stopping a session is still the card's job.

No new runtime dependency, nothing persisted, nothing leaves the machine (invariant #4).

## What a session is allowed to cost this machine

Running many agents at once is the point, so a single session must not be free to
grow into the whole machine. Two controls in `server/agents/claude.ts` bound what
one `claude` child costs; both apply to *every* Claude session (dispatch, grooming,
Code Review, orchestration, memory distillation, Ask), and both are in Settings →
General → Concurrency / Agent isolation.

- **Per-session memory budget** (`Settings.sessionMemoryMb`, default `'auto'`).
  The `claude` CLI ships as a **Bun/JavaScriptCore binary, not Node** — `NODE_OPTIONS`
  and `--max-old-space-size` do nothing to it, and JSC sizes its GC heuristics against
  the RAM it thinks the machine has. Every parallel session therefore assumes it may
  grow into all of it, which is how a busy board ends up swapping. `memoryEnv()` hands
  each child `BUN_JSC_forceRAMSize` (the working lever — it collects earlier) plus
  `BUN_JSC_gcMaxHeapSize` at 2× as a ceiling. Both names are validated by the binary
  (an unknown `BUN_JSC_*` makes it exit), so they're supported knobs, not guesses.
  `'auto'` is 40% of RAM split across `maxParallelSessions`, clamped to 1–6 GB; `0`
  turns the budget off; an explicit `BUN_JSC_*` in the environment always wins.
- **MCP isolation** (`Settings.isolateMcpServers`, default **on**). Every arg builder
  ends with `--strict-mcp-config` (`mcpIsolationArgs()`), so a session loads only the
  MCP servers *we* register — the permission bridge for a task, the board server for an
  orchestration, none at all for grooming and Code Review. Without it each session also
  connects to the developer's own global/project MCP servers: a child process per local
  one, per session, and every one of their tools described in every request. Measured on
  a typical install, that was **122 tools from 7 servers vs 29 with isolation on**.
  Turning it off is the escape hatch for a task that genuinely needs them.

Neither is a hard stop — a runaway session is still a runaway session, just a bounded
one. Killing it is `runner.stop`'s job, and the resource monitor above is where you
watch for it.

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

## Goal Orchestration: "Orchestrate a Goal"

Another **installable plugin** (`orchestration` in `server/plugins.ts`) — the
"Orchestrate a Goal" button and the board's Orchestration column only surface once
it's installed. (`store.ts` migrates the plugin's old internal id, `hive`, to
`orchestration` on load, so an existing install isn't silently dropped.)

An orchestration is its own entity (`db.orchestrations`, `Orchestration` in `types.ts`)
with its own REST routes (`/api/orchestrations/...`) and lifecycle: **draft** (gray) →
**running** (purple, set only by `runner.orchestrate`) → **waiting** (blue — watching
worker tasks) or **awaiting** (amber — it asked the developer something) →
**finished** (green) or **failed** (red). Like a grooming card it never leaves its
locked column; the status only recolors it in place.

The **orchestrator** is a read-only `claude -p` session scoped to one repo and one
high-level goal. It plans, and **workers do all the editing** — it is given the
grooming research tools plus Sr. Popo's own board tools and nothing else
(`orchestrateArgs` in `server/agents/claude.ts`), so a write tool is auto-denied by the
headless run. It reaches the board through the **`/mcp` server** (`server/mcp.ts`),
registered via `--mcp-config` as an **HTTP** MCP server named `board` pointing at the
app's own `127.0.0.1` base URL — verified against a live `claude` CLI, so no stdio
proxy is needed. Never confuse that name with the per-task permission bridge
(`srpopo`); the orchestrator gets no permission bridge and no worktree.

Every orchestrator turn ends with ONE JSON object between `@@SRPOPO_ORCH_START@@` /
`@@SRPOPO_ORCH_END@@` (parsed by `orchestrator.parseStatus`): `waiting` (with the
worker task ids to watch), `question`, `done`, or `blocked`.
`server/orchestrator-engine.ts` is the engine: it subscribes to the SSE bus and, when
a watched worker reaches `validation`/`done`/`failed` (the last covering Autonomous Mode's
merge → done, with `code_review` deliberately *not* terminal — a worker being graded is still
in flight), debounces a few seconds and **resumes the same session** with a status digest from
`orchestrator.statusPrompt`. It never resumes a session that is already running,
re-arms `waiting` orchestrations from the store on boot
(`orchestratorEngine.start()` in `index.start`), and hard-stops an orchestrator after
`orchestratorEngine.MAX_TURNS` turns. To change how goals are orchestrated, edit
`orchestrator.ts`; to change when the orchestrator wakes up, edit
`orchestrator-engine.ts`.

**Autonomous hand-off.** `POST /api/orchestrations/:id/run` takes an optional
`{ autonomous: { budgetUsd, reviewMode } }`: it starts an Autonomous Mode session for
the repo first, and the orchestrator is told to create `ready` tasks with the engine's
`REQUIRED_ADDONS` and let it dispatch/review/merge them. Without it the orchestrator
runs in manual mode — it dispatches its own tasks and a human merges.

## Maintaining this repo with Claude (the meta-workflow)

Sr. Popo is built to maintain itself. Prefer this loop for non-trivial changes:

1. **Register this repo** in Sr. Popo (📁 Repos) and open a **New Task** with a focused
   prompt. Enable **Worktree** so work runs isolated on a `srpopo/<slug>` branch.
2. Turn on the **"self code review"** add-on for anything non-trivial, and the
   **"open a PR"** add-on when you want the run to finish with a `gh pr create`.
3. **Dispatch**, then read the streamed session in the **Validation** column: the
   diff, the tool calls, the Code Review grade, and the final cost/turns before
   accepting.
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
  credentials being configured. This means macOS auto-update can download and
  verify a new version, but Squirrel.Mac (the native installer electron-updater
  drives on macOS) refuses to actually apply it without a real Developer ID
  signature — an ad-hoc-signed build fails that step silently in the background.
  `electron/main.ts` detects the failure and swaps the "Relaunch to update"
  banner for a manual-download link (`srpopo:update-install-failed`) instead of
  leaving a button that does nothing. Don't "fix" it by ignoring the error.
