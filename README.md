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
npm start          # launches the Electron app
```

The embedded server binds to `127.0.0.1` (port `7777` in dev, a free port when
packaged). To run the plain web server instead (no desktop shell):

```bash
npm run server     # http://localhost:7777
```

Options: `CLAUDE_BIN=/path/to/claude npm start`

## Build a Mac app

```bash
npm run dist       # → release/  (.dmg + .zip, arm64 + x64)
npm run pack       # unpacked .app for quick local testing
```

Output lands in `release/`. The build is unsigned by default — on first launch
right-click the app → **Open** to bypass Gatekeeper, or add signing/notarization
credentials to `package.json > build.mac`.

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

- `server/index.js` — Express API + static UI (binds to 127.0.0.1 only)
- `server/runner.js` — spawns/kills `claude` CLI processes, parses the stream-json session feed
- `server/git.js` — worktree lifecycle
- `server/bus.js` — SSE fan-out for live board + timeline updates
- `public/` — dependency-free vanilla JS UI
