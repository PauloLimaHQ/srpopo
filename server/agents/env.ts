/*
 * Shared, provider-agnostic environment scrubbing for spawned agent CLIs.
 *
 * Every backend (Claude, Codex) must run under the user's *subscription* login
 * and must not think it's a nested Claude Code session. Provider-specific secret
 * stripping (ANTHROPIC_API_KEY / OPENAI_API_KEY) lives in each adapter's own
 * childEnv on top of this base — see server/agents/claude.ts and codex.ts.
 */

// A copy of the current process env with the nested-session markers removed, so
// Sr. Popo can itself be launched from Claude Code without confusing the child
// (invariant #3). Provider adapters layer their own secret stripping on top.
export function baseChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}
