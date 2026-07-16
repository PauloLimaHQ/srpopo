# Security Policy

Sr. Popo runs entirely on your own machine, spawns a local agent CLI (`claude` or
`codex`), and can create git worktrees and (via add-ons) push branches and open pull
requests. Because it drives real tooling with your credentials, its security properties
matter.

## Design guarantees

- **Localhost only.** The embedded server binds to `127.0.0.1`. It is never exposed on a
  LAN or public interface, and there is no remote access surface.
- **No API key usage.** Every spawned task has its provider's key stripped from the
  environment — `ANTHROPIC_API_KEY` for Claude Code, `OPENAI_API_KEY` for Codex — so
  runs always use your interactive subscription login.
- **Local data only.** Repos, tasks, and full session logs live under your per-user data
  directory (`~/Library/Application Support/Sr. Popo/data` on macOS). Nothing is sent
  off your machine by Sr. Popo itself.
- **Sandboxed UI.** The Electron renderer runs with `contextIsolation` on and
  `nodeIntegration` off; it talks to the server over local HTTP through a minimal
  preload bridge.

Note that tasks you dispatch run a coding agent with the permissions you choose
(including `bypassPermissions`, and Codex's `danger-full-access` sandbox), which can
modify files, run commands, and push branches. Treat the prompts and permission modes
you use with the same care as running `claude` / `codex` yourself.

## Supported versions

Sr. Popo is pre-1.0; only the latest release on `main` is supported.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Instead, email the maintainer at **pflima92@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce (or a proof of concept), and
- any suggested remediation.

You can expect an acknowledgment within a few days. Please give a reasonable window to
release a fix before any public disclosure. Thank you for helping keep users safe.
