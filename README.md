# 🧞 Sr. Popo

A local orchestrator hub for **Claude Code** tasks across all your repositories.
Queue tasks on a Kanban board, drag them to **Running** to dispatch, and watch live
session logs — tool calls, subagents, cost — from one place.

Runs entirely on your machine and uses your **Claude subscription** (it spawns the
`claude` CLI with your existing login — no API key is ever used; `ANTHROPIC_API_KEY`
is explicitly stripped from task environments).

Sr. Popo is a native **macOS desktop app** (Electron). It lives in the **menu bar
(tray)** — click the lamp icon to show/hide the board, and it keeps running in the
background so your tasks aren't interrupted when you close the window.

## Requirements

- Node.js 18+
- [Claude Code CLI](https://claude.com/claude-code) installed and logged in (`claude` on your PATH)
- git

## Run (development)

```bash
npm install
npm start          # compiles TypeScript (tsc) then launches the Electron app
```

The embedded server binds to `127.0.0.1` (port `7777` in dev, a free port when
packaged). To run the plain web server instead (no desktop shell) — this runs the
TypeScript directly with [`tsx`](https://tsx.is), no build step needed:

```bash
npm run server     # http://localhost:7777
npm run server:dev # same, with watch reload
```

Options: `CLAUDE_BIN=/path/to/claude npm start`

The Node-side code (`server/`, `electron/`, `tests/`) is **TypeScript**; the
browser UI in `public/` stays vanilla JS with no build step.

## Build

```bash
npm run dist:mac   # → release/  macOS .dmg + .zip (arm64 + x64)
npm run dist:win   # → release/  Windows .exe installer + .zip (x64)
npm run pack       # unpacked app for quick local testing
```

Output lands in `release/`. Builds are **unsigned** for now (open-source tool):

- **macOS** — on first launch right-click the app → **Open** to bypass Gatekeeper.
- **Windows** — SmartScreen may warn on an unsigned installer; choose *More info →
  Run anyway*.

To sign/notarize later, add credentials to `package.json > build.mac` / `build.win`.

## Type-check, lint & test

```bash
npm run typecheck  # tsc --noEmit (type-check only)
npm run lint       # ESLint (flat config in eslint.config.js — TS + public/ JS)
npm test           # node:test smoke suite (tests/), run through tsx
npm run build      # tsc → compile server/ + electron/ to dist/
```

## Continuous integration & releases

GitHub Actions drive CI and releases (see `.github/workflows/`):

- **CI** (`ci.yml`) — on every push/PR to `main`: installs deps, runs `lint` and
  `test`, and packages the app on macOS + Windows to verify it builds.
- **Release** (`release.yml`) — when you **publish a GitHub Release**, it builds the
  unsigned macOS and Windows installers and attaches them to that release. You can
  also trigger it manually (**workflow_dispatch**) to build installers as workflow
  artifacts without cutting a release.

To cut a release: bump `version` in `package.json`, tag it, and publish a GitHub
Release for that tag — the workflow uploads the installers automatically.

## Menu bar / tray

- The custom lamp icon sits in the macOS menu bar (a template image, so it adapts
  to light/dark).
- **Click** it to toggle the window. **Right-click** for *Open Sr. Popo*,
  *Open in Browser*, and *Quit*.
- Closing the window hides it to the tray (the app keeps running). Use tray →
  *Quit* (or ⌘Q while focused) to fully exit, which also stops any live `claude`
  processes.

Data lives in `~/Library/Application Support/Sr. Popo/data` (`db.json` + `logs/`).

## How it works

1. **📁 Repos** — register the local git repositories you work in.
2. **＋ New Task** — pick a repo, write the prompt, choose:
   - **Model**: account default / sonnet / opus / haiku
   - **Permissions**: `acceptEdits` (recommended), bypass-all, plan-only
   - **Worktree**: run isolated in `~/.srpopo/worktrees/<repo>--<task>` on branch `srpopo/<task>`
3. **Dispatch** — drag the card into the **Running** column (or hit *Create & Run*).
   Sr. Popo spawns `claude -p --output-format stream-json` in the repo/worktree and
   streams everything live.
4. **Review** — successful runs land in **Review**; failures show in the same column
   with a red badge. Click any card for the full session timeline: prompts, assistant
   messages, every tool call with input/output, **subagents** grouped and tracked
   live, and the final result with duration/turns/cost.
5. **Follow-up** — finished tasks keep their session. Type in the composer at the
   bottom of the detail panel (or drag the card back to Running) and Claude resumes
   with full context (`--resume`).
6. When you're happy, drag to **Done**, then *Remove worktree* / *Archive* from the
   detail panel. Merge the `srpopo/*` branch however you normally would.

Run as many tasks in parallel as you like — each is an independent `claude` process.

## Board columns

| Column | Meaning |
|---|---|
| Backlog | Ideas / not ready |
| Ready | Configured, waiting for dispatch |
| Running | Live `claude` process (spinner, elapsed time, active subagent count, stop button) |
| Review | Finished — check the diff/log (failures show here with a FAILED badge) |
| Done | Accepted |

## Storage

- `data/db.json` — repos + tasks
- `data/logs/<taskId>.ndjson` — full session event log per task (append-only, survives restarts)
- `~/.srpopo/worktrees/` — task worktrees

## Architecture

- `server/index.ts` — Express API + static UI (binds to 127.0.0.1 only)
- `server/runner.ts` — spawns/kills `claude` CLI processes, parses the stream-json session feed
- `server/git.ts` — worktree lifecycle
- `server/bus.ts` — SSE fan-out for live board + timeline updates
- `server/addons.ts` — catalog of opt-in task behaviors (self-review, open a PR, …)
- `public/` — dependency-free vanilla JS UI (no build step)

The Node-side is TypeScript (`tsx` in dev, `tsc` → `dist/` for builds); `public/`
is served static as-is.

For the full architecture map, invariants, and conventions, see [`CLAUDE.md`](./CLAUDE.md) —
it's the guide Claude Code (and contributors) follow when working in this repo.

## Contributing

Sr. Popo is open source (MIT) and built to be maintained with Claude Code itself.

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — dev setup, workflow, commit/PR style.
- [`CLAUDE.md`](./CLAUDE.md) — architecture, invariants, and the Claude-driven
  maintenance loop (register this repo in Sr. Popo, dispatch changes in a worktree,
  self-review, open a PR).
- [`SECURITY.md`](./SECURITY.md) — design guarantees and how to report a vulnerability.
- [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) — community expectations.

Every change is gated on `npm run typecheck && npm run lint && npm test`; CI re-runs all three and packages the
app on macOS + Windows.

## License

[MIT](./LICENSE) © Paulo Lima
