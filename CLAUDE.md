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

| Path | Role |
|---|---|
| `server/index.js` | Express REST API + static UI host. Binds `127.0.0.1` only. |
| `server/runner.js` | Spawns/kills the `claude` CLI, parses its `stream-json` session feed. |
| `server/store.js` | JSON persistence (`db.json`) + append-only per-task NDJSON logs. |
| `server/git.js` | Worktree lifecycle (`git worktree add/remove`). |
| `server/bus.js` | Server-Sent Events fan-out for the live board + timeline. |
| `server/addons.js` | Catalog of opt-in task behaviors (see "Add-ons" below). |
| `server/groomer.js` | Meta-prompt + result parser for "Brief an Idea" (see "Grooming" below). |
| `electron/main.js` | macOS tray/menu-bar app shell; boots the server on a local port. |
| `electron/preload.js` | Minimal, safe `contextBridge` (folder picker, base URL). |
| `public/` | Dependency-free vanilla-JS Kanban UI (`app.js`, `index.html`, `styles.css`). |
| `tests/` | `node --test` smoke suite. |

## Commands

```bash
npm start          # launch the Electron desktop app (dev, fixed port 7777)
npm run server     # plain web server only, http://localhost:7777
npm run server:dev # server with --watch reload
npm run lint       # ESLint (flat config, eslint.config.js)
npm test           # node --test smoke suite
npm run pack       # unpacked app build (quick local check)
npm run dist:mac   # signed-less macOS .dmg/.zip → release/
npm run dist:win   # Windows installer → release/
```

Always run `npm run lint && npm test` before proposing a change is done.

## The task lifecycle (the product's core "workflow")

A task moves through fixed board columns. Preserve these names and semantics — the
UI, the API, and `runner.js` all agree on them:

`backlog` → `ready` → **`running`** → `review` → `done`, with **`grooming`** as an
entry state (from "Brief an Idea") and `failed` as a side state.

- **grooming** — a live, read-only `claude -p` session (`runner.groom`) that rewrites
  a rough idea into a well-formed prompt; on success the task moves to `ready`. Like
  `running`, it is set only by the runner, never via `PATCH /api/tasks/:id`.
- **backlog / ready** — configured but not dispatched.
- **running** — a live `claude -p --output-format stream-json` process. Set only by
  `runner.dispatch`, never via `PATCH /api/tasks/:id` (the API rejects that on purpose).
- **review** — finished successfully; the user inspects the diff/log.
- **failed** — non-zero exit or `is_error` result; shown in Review with a red badge.
- **done** — accepted by the user.

Dispatch runs the prompt fresh; a follow-up with an existing `sessionId` resumes the
same session (`claude --resume`). A worktree is materialized lazily on first dispatch
when `useWorktree` is set.

## Non-negotiable invariants

Breaking any of these is a security or trust regression — call it out loudly if a task
would require it.

1. **Bind to `127.0.0.1` only.** Never expose the server on `0.0.0.0` or a LAN address.
   There is no auth layer; localhost binding *is* the security boundary.
2. **Never use an API key.** `runner.childEnv()` strips `ANTHROPIC_API_KEY` from every
   spawned task so runs always use the subscription login. Keep it stripped.
3. **Strip nested-session env** (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`) so Sr. Popo can
   itself be launched from Claude Code without confusing the child.
4. **Data stays local and per-user.** `SRPOPO_DATA_DIR` (Electron `userData`) holds
   `db.json` + `logs/`. Don't send task content anywhere off-machine.
5. **Renderer stays sandboxed.** `contextIsolation: true`, `nodeIntegration: false`.
   The UI talks to the server over HTTP; the preload bridge stays minimal.

## Conventions

- **CommonJS** (`require`/`module.exports`), Node 18+. No ESM, no TypeScript.
- **Keep runtime dependencies minimal.** `express` is the only one. Do not add a
  frontend framework or a build step — the UI is intentionally vanilla JS served static.
- 2-space indent, single quotes, semicolons — match the existing files and ESLint.
- Persist state through `store.save()` and broadcast changes via `bus.broadcast()` so
  every connected board updates live. New task fields go in the object built in
  `POST /api/tasks` (and, if user-editable, the `allowed` list in `PATCH`).
- Prefer small, single-purpose modules in `server/`; keep the API thin.

## Add-ons: how to extend task behavior

`server/addons.js` is the single source of truth for optional per-task behaviors
(e.g. "open a PR at the end", "self-review the diff"). Each entry drives **both** the
UI checkbox (`GET /api/addons`) and the extra prompt text injected at dispatch. To add
one, append an entry with `{ id, label, hint, instruction }` — nothing else changes.
The `instruction` is appended to the user's prompt, so write it as a clear, standalone
directive to Claude.

## Grooming: "Brief an Idea"

`POST /api/briefs` (a rough idea + a repo) creates a task in the `grooming` state and
kicks off `runner.groom`. That runs a **read-only** `claude -p` session in the repo
(only research tools are auto-approved — see `groomArgs`, no worktree, never a write)
whose whole job is prompt engineering: explore the code, then rewrite the idea into a
self-contained task prompt. `server/groomer.js` owns the meta-prompt and the parser
that recovers the `{ title, prompt }` spec (emitted between `@@SRPOPO_SPEC_*@@`
sentinels). On success the task lands in `ready` with the groomed prompt; the original
idea is preserved on `task.brief`. To change how ideas are groomed, edit `groomer.js` —
it is the single source of truth for that flow.

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
   npm run lint && npm test
   ```
5. Keep commits small and conventional; open a PR (see `CONTRIBUTING.md`). CI
   (`.github/workflows/ci.yml`) re-runs lint/test and packages on macOS + Windows.

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
