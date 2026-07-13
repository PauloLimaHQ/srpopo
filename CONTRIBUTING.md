# Contributing to Sr. Popo

Thanks for helping improve Sr. Popo! This is a small, local-first tool — contributions
that keep it **simple, dependency-light, and obviously safe** are the most welcome.

## Ground rules

- Sr. Popo runs entirely on the user's machine and drives their Claude **subscription**
  login — never an API key. Don't add anything that phones home or ships task content
  off-device.
- The server binds to `127.0.0.1` only. There is no auth layer; that binding is the
  security boundary. Don't loosen it.
- The Node-side code (`server/`, `electron/`, `tests/`) is TypeScript, compiled with
  `tsc` to `dist/` and run in dev with `tsx`. The browser UI in `public/` is
  intentionally dependency-free vanilla JS with **no build step** — please keep it that
  way (no frameworks, no bundler).
- `express` is the only runtime dependency. Everything TypeScript-related lives in
  `devDependencies`. Adding another runtime dependency needs a strong reason.

See [`CLAUDE.md`](./CLAUDE.md) for the full architecture map and the invariants any
change must preserve.

## Getting started

Requirements: Node.js 18+, the [Claude Code CLI](https://claude.com/claude-code) on your
PATH and logged in, and git.

```bash
npm install
npm run server   # http://localhost:7777 (web only)
# or
npm start        # the Electron desktop app
```

## Development workflow

1. Branch off `main` (`feat/…`, `fix/…`, or the `srpopo/…` branch Sr. Popo creates when
   you run a task in a worktree).
2. Make the smallest change that solves the problem. Match the surrounding style.
3. Gate every change on:
   ```bash
   npm run typecheck && npm run lint && npm test
   ```
4. Open a pull request against `main` and fill in the template. CI runs typecheck + lint
   + test and packages the app on macOS and Windows.

You can also dogfood the tool: register this repo in Sr. Popo and dispatch the change as
a task (worktree + self-review add-on). See the "Maintaining this repo with Claude"
section of [`CLAUDE.md`](./CLAUDE.md).

## Commit & PR style

- Conventional, imperative commit subjects (`fix: …`, `feat: …`, `docs: …`).
- Keep PRs focused; describe **what** changed and **why**, and note any user-visible or
  security-relevant impact.
- Include screenshots or a short clip for UI changes.

## Reporting bugs & ideas

Open an issue using the templates. For anything security-sensitive, follow
[`SECURITY.md`](./SECURITY.md) instead of filing a public issue.

## Code of Conduct

By participating you agree to uphold our [Code of Conduct](./CODE_OF_CONDUCT.md).
