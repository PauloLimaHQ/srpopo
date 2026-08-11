import test from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Keep the store's on-disk writes out of the repo during tests. Set BEFORE any
// server module is required (the requires below are deliberately lazy so the
// store reads this env var, not the repo default).
process.env.SRPOPO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'srpopo-test-'));

test('store exposes id/now helpers', () => {
  const store = require('../server/store');
  assert.match(store.id(), /^[0-9a-f]{10}$/, 'id() should be 10 hex chars');
  assert.match(store.now(), /^\d{4}-\d{2}-\d{2}T/, 'now() should be an ISO timestamp');
  assert.ok(store.db && Array.isArray(store.db.tasks), 'db.tasks should be an array');
  assert.ok(Array.isArray(store.db.groomings), 'db.groomings should be an array (backfilled)');
});

test('store: settings default to notifications + sounds on and are backfilled', () => {
  const store = require('../server/store');
  assert.ok(store.db.settings && typeof store.db.settings === 'object', 'db.settings is an object');
  assert.strictEqual(store.db.settings.notifications, true, 'notifications default on');
  assert.strictEqual(store.db.settings.sounds, true, 'sounds default on');
  assert.strictEqual(store.DEFAULT_SETTINGS.notifications, true, 'DEFAULT_SETTINGS is exported');
  assert.strictEqual(store.DEFAULT_SETTINGS.sounds, true, 'sounds default is exported');
  assert.strictEqual(store.db.settings.maxParallelSessions, 3, 'maxParallelSessions defaults to 3');
  assert.strictEqual(store.DEFAULT_SETTINGS.maxParallelSessions, 3, 'maxParallelSessions default is exported');
  assert.strictEqual(store.db.settings.autoResolveConflicts, false, 'autoResolveConflicts defaults off');
  assert.strictEqual(store.DEFAULT_SETTINGS.autoResolveConflicts, false, 'autoResolveConflicts default is exported');
  assert.strictEqual(store.db.settings.assignPrToSelf, false, 'assignPrToSelf defaults off');
  assert.strictEqual(store.DEFAULT_SETTINGS.assignPrToSelf, false, 'assignPrToSelf default is exported');
});

test('addons: pull_request instruction only self-assigns when Settings > assignPrToSelf is on', () => {
  const store = require('../server/store');
  const addons = require('../server/addons');
  const prev = store.db.settings.assignPrToSelf;
  try {
    store.db.settings.assignPrToSelf = false;
    const off = addons.instructionsFor(['pull_request']);
    assert.ok(!off.includes('--assignee @me'), 'no self-assign instruction when the setting is off');

    store.db.settings.assignPrToSelf = true;
    const on = addons.instructionsFor(['pull_request']);
    assert.ok(on.includes('--assignee @me'), 'self-assign instruction appended when the setting is on');
  } finally {
    store.db.settings.assignPrToSelf = prev;
  }
});

test('addons: instructionsFor swaps in the draft-PR wording only when prDraft is set', () => {
  const addons = require('../server/addons');

  const ready = addons.instructionsFor(['pull_request'], { prDraft: false });
  assert.ok(ready.includes('gh pr create'), 'default instruction opens a normal PR');
  assert.ok(!ready.includes('--draft'), 'no --draft flag when prDraft is off');

  const draft = addons.instructionsFor(['pull_request'], { prDraft: true });
  assert.ok(draft.includes('--draft'), 'draft instruction opens the PR with --draft');

  // Unaffected add-ons ignore the option entirely.
  const other = addons.instructionsFor(['code_review'], { prDraft: true });
  assert.ok(!other.includes('--draft'), 'prDraft has no effect on other add-ons');
});

test('server modules load without throwing', () => {
  assert.doesNotThrow(() => {
    require('../server/git');
    require('../server/bus');
    require('../server/runner');
    require('../server/addons');
    require('../server/personas');
    require('../server/groomer');
    require('../server/github');
    require('../server/linear');
    require('../server/repoSpecs');
    require('../server/plugins');
    require('../server/tasks');
    require('../server/mcp');
    require('../server/index');
  });
});

test('plugins: catalog lists Linear and sanitize keeps only known ids', () => {
  const plugins = require('../server/plugins');
  const ids = plugins.catalog().map((p: { id: string }) => p.id);
  assert.ok(ids.includes('linear'), 'Linear is in the marketplace catalog');
  assert.ok(ids.includes('grooming'), 'Idea Grooming is in the marketplace catalog');
  assert.ok(plugins.isKnown('linear'), 'isKnown recognizes a catalog id');
  assert.strictEqual(plugins.isKnown('nope'), false, 'isKnown rejects unknown ids');
  assert.deepStrictEqual(plugins.sanitize(['linear', 'bogus']), ['linear'], 'unknown ids dropped');
  assert.deepStrictEqual(plugins.sanitize('not-an-array'), [], 'non-array yields []');
  assert.deepStrictEqual(plugins.sanitize(['linear', 'linear']), ['linear'], 'ids deduped');
});

test('plugins: catalog lists Repository Specs and sanitize keeps it', () => {
  const plugins = require('../server/plugins');
  const ids = plugins.catalog().map((p: { id: string }) => p.id);
  assert.ok(ids.includes('repo-specs'), 'Repository Specs is in the marketplace catalog');
  assert.ok(plugins.isKnown('repo-specs'), 'isKnown recognizes repo-specs');
  assert.deepStrictEqual(plugins.sanitize(['repo-specs', 'bogus']), ['repo-specs'], 'unknown ids dropped alongside it');
});

test('store: remote access defaults off with an empty token, and is backfilled', () => {
  const store = require('../server/store');
  assert.strictEqual(store.db.settings.remoteAccess, false, 'remote access defaults off');
  assert.strictEqual(store.db.settings.remoteAccessToken, '', 'no token until first enabled');
  assert.strictEqual(store.DEFAULT_SETTINGS.remoteAccess, false, 'default is exported');
  assert.strictEqual(store.DEFAULT_SETTINGS.remoteAccessToken, '', 'token default is exported');
});

test('index: GET /api/settings exposes remote flags over localhost but never the raw token', async () => {
  const store = require('../server/store');
  const index = require('../server/index');
  const prevOn = store.db.settings.remoteAccess;
  const prevTok = store.db.settings.remoteAccessToken;
  store.db.settings.remoteAccess = true;
  store.db.settings.remoteAccessToken = 'deadbeefdeadbeefdeadbeef';
  const { server, port } = await index.start(0); // localhost bind; always allowed
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`);
    assert.strictEqual(res.status, 200, 'localhost is allowed even with remote access on');
    const body = await res.json();
    assert.strictEqual(body.remoteAccess, true, 'derived remoteAccess flag is exposed');
    assert.strictEqual(body.remoteAccessConfigured, true, 'derived configured flag is exposed');
    assert.ok(!('remoteAccessToken' in body), 'the raw token is never in the public settings');
    assert.strictEqual(JSON.stringify(body).includes('deadbeef'), false, 'the token value never leaks');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.db.settings.remoteAccess = prevOn;
    store.db.settings.remoteAccessToken = prevTok;
  }
});

test('index: PATCH /api/settings sanitizes custom models — drops invalid rows and strips ANTHROPIC_API_KEY', async () => {
  const store = require('../server/store');
  const index = require('../server/index');
  const prev = store.db.settings.customModels;
  const { server, port } = await index.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customModels: [
          { label: 'Bedrock', model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'sk-leak' } },
          { label: '', model: 'no-label-dropped', env: {} }, // invalid: no label
        ],
      }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.customModels.length, 1, 'the row without a label is dropped');
    const m = body.customModels[0];
    assert.strictEqual(m.label, 'Bedrock');
    assert.ok(m.id, 'a stable id is minted');
    assert.strictEqual(m.env.CLAUDE_CODE_USE_BEDROCK, '1', 'plain env is kept');
    assert.ok(!('ANTHROPIC_API_KEY' in m.env), 'invariant #2: the API key is never stored on a custom model');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.db.settings.customModels = prev;
  }
});

test('runner: a task on a custom model layers its env onto the child but never restores ANTHROPIC_API_KEY', () => {
  const store = require('../server/store');
  const runner = require('../server/runner');
  const prev = store.db.settings.customModels;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  store.db.settings.customModels = [
    { id: 'cm1', label: 'Bedrock', model: 'bedrock-model-id', env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1', ANTHROPIC_API_KEY: 'sk-leak' } },
  ];
  process.env.ANTHROPIC_API_KEY = 'sk-ambient';
  try {
    const env = runner.buildTaskEnv('bedrock-model-id');
    assert.strictEqual(env.CLAUDE_CODE_USE_BEDROCK, '1', 'the custom model env is applied');
    assert.strictEqual(env.AWS_REGION, 'us-east-1');
    assert.ok(!('ANTHROPIC_API_KEY' in env), 'invariant #2: neither the ambient nor the custom key survives');
    const builtin = runner.buildTaskEnv('opus');
    assert.ok(!('CLAUDE_CODE_USE_BEDROCK' in builtin), 'a built-in model gets no custom env');
  } finally {
    store.db.settings.customModels = prev;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test('index: toggling remote access re-binds the live server, staying reachable over localhost', async () => {
  const store = require('../server/store');
  const index = require('../server/index');
  const prevOn = store.db.settings.remoteAccess;
  const prevTok = store.db.settings.remoteAccessToken;
  store.db.settings.remoteAccess = false;
  store.db.settings.remoteAccessToken = '';
  const { server, port } = await index.start(0); // starts on 127.0.0.1 (remote off)
  try {
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200, 'reachable with remote off');

    // Turn remote access on: the PATCH generates a token and, on response finish,
    // re-binds the listener (to 0.0.0.0). The server must stay reachable over
    // localhost across the re-bind, and a token must now exist.
    const patched = await (await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remoteAccess: true }),
    })).json();
    assert.strictEqual(patched.remoteAccess, true, 'PATCH reports remote access on');
    assert.strictEqual(patched.remoteAccessConfigured, true, 'a token was generated on enable');
    assert.ok(store.db.settings.remoteAccessToken.length >= 32, 'the token is a decent-length secret');

    // Give the re-bind (scheduled on response finish) a moment to complete.
    await new Promise((r) => setTimeout(r, 600));
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200, 'still reachable after re-bind');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.db.settings.remoteAccess = prevOn;
    store.db.settings.remoteAccessToken = prevTok;
  }
});

test('index: authorizeRemote gates LAN requests by token (off → open, on → token or localhost)', () => {
  const store = require('../server/store');
  const index = require('../server/index');
  const prevOn = store.db.settings.remoteAccess;
  const prevTok = store.db.settings.remoteAccessToken;
  const TOKEN = 'a'.repeat(48);
  try {
    // Off (the default): every request is allowed, no cookie set — today's behavior.
    store.db.settings.remoteAccess = false;
    store.db.settings.remoteAccessToken = '';
    let d = index._authorizeRemote({ local: false, cookieToken: '', headerToken: '', queryToken: '' });
    assert.deepStrictEqual(d, { allow: true }, 'remote off allows a LAN request with no token');

    // On: localhost is always allowed, never prompted, no cookie set.
    store.db.settings.remoteAccess = true;
    store.db.settings.remoteAccessToken = TOKEN;
    d = index._authorizeRemote({ local: true, cookieToken: '', headerToken: '', queryToken: '' });
    assert.deepStrictEqual(d, { allow: true }, 'localhost is always allowed');

    // On + LAN + no token → denied.
    d = index._authorizeRemote({ local: false, cookieToken: '', headerToken: '', queryToken: '' });
    assert.strictEqual(d.allow, false, 'a LAN request without a token is denied');

    // On + LAN + wrong token → denied (guards the timingSafeEqual length mismatch).
    d = index._authorizeRemote({ local: false, cookieToken: 'short', headerToken: '', queryToken: '' });
    assert.strictEqual(d.allow, false, 'a wrong-length token is denied without throwing');
    d = index._authorizeRemote({ local: false, cookieToken: 'b'.repeat(48), headerToken: '', queryToken: '' });
    assert.strictEqual(d.allow, false, 'a same-length wrong token is denied');

    // On + LAN + valid cookie → allowed, and no Set-Cookie (already the cookie).
    d = index._authorizeRemote({ local: false, cookieToken: TOKEN, headerToken: '', queryToken: '' });
    assert.deepStrictEqual(d, { allow: true }, 'a valid cookie token is allowed without re-setting it');

    // On + LAN + valid Authorization header → allowed, and the cookie is set so
    // subsequent EventSource requests (which can't send headers) authenticate.
    d = index._authorizeRemote({ local: false, cookieToken: '', headerToken: TOKEN, queryToken: '' });
    assert.strictEqual(d.allow, true, 'a valid bearer token is allowed');
    assert.ok(d.setCookie && d.setCookie.includes('srpopo_token=') && /HttpOnly/i.test(d.setCookie)
      && /SameSite=Lax/i.test(d.setCookie), 'header token persists an HttpOnly SameSite=Lax cookie');

    // On + LAN + valid ?token= query → allowed, and the cookie is set.
    d = index._authorizeRemote({ local: false, cookieToken: '', headerToken: '', queryToken: TOKEN });
    assert.strictEqual(d.allow, true, 'a valid query token is allowed');
    assert.ok(d.setCookie && d.setCookie.includes('srpopo_token='), 'query token persists the cookie');
  } finally {
    store.db.settings.remoteAccess = prevOn;
    store.db.settings.remoteAccessToken = prevTok;
  }
});

test('index: parseCookies parses a Cookie header by hand; lanAddresses lists IPv4 strings', () => {
  const index = require('../server/index');
  assert.deepStrictEqual(index._parseCookies('a=1; srpopo_token=xyz; b=2').srpopo_token, 'xyz');
  assert.deepStrictEqual(index._parseCookies(undefined), {}, 'no header yields an empty map');
  assert.deepStrictEqual(index._parseCookies('novalue').novalue, undefined, 'a valueless part is skipped');
  const lan = index._lanAddresses();
  assert.ok(Array.isArray(lan), 'lanAddresses returns an array');
  assert.ok(lan.every((ip: string) => typeof ip === 'string' && !ip.includes(':')), 'entries are IPv4 strings');
});

test('git: listBranches/createBranch/checkoutBranch and worktree base off a chosen branch', async () => {
  const git = require('../server/git');
  const { execFileSync } = require('child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'srpopo-git-'));
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args]).toString().trim();
  g('init', '-q');
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 't');
  g('commit', '-q', '--allow-empty', '-m', 'init');
  const trunk = g('rev-parse', '--abbrev-ref', 'HEAD');
  g('branch', 'develop');

  const listed = await git.listBranches(repo);
  assert.strictEqual(listed.current, trunk, 'current branch is reported');
  assert.ok(listed.branches.includes('develop') && listed.branches.includes(trunk), 'both branches listed');

  // createBranch cuts from HEAD and checks the new branch out.
  const now = await git.createBranch(repo, 'feature/x');
  assert.strictEqual(now, 'feature/x', 'new branch is checked out');
  assert.strictEqual((await git.listBranches(repo)).current, 'feature/x');
  assert.strictEqual(await git.checkoutBranch(repo, 'develop'), 'develop', 'checkoutBranch switches back');

  // A worktree with a baseBranch is cut from that branch, not the current HEAD.
  const wt = await git.addWorktree(repo, 'tid', 'slug', null, 'feature/x');
  assert.strictEqual(wt.branch, 'srpopo/slug-tid');
  const base = execFileSync('git', ['-C', wt.wtPath, 'merge-base', 'HEAD', 'feature/x']).toString().trim();
  assert.strictEqual(base, g('rev-parse', 'feature/x'), 'worktree is based on feature/x');
  await git.removeWorktree(repo, wt.wtPath);

  // A duplicate branch name fails loudly rather than silently succeeding.
  await assert.rejects(() => git.createBranch(repo, 'feature/x'), 'creating an existing branch throws');
});

// The Move-to-Done flow removes a worktree right after merging, and `git
// worktree remove` deregisters the worktree even when it can't delete every
// file under it (a build daemon writing into the checkout is the usual
// culprit) — exiting non-zero all the same. Treating that as a failure left the
// task pointing at a worktree that no longer existed and blocked the move, and
// the retry then hit "is not a working tree" instead.
test('git: removeWorktree survives a partial delete and is idempotent', async () => {
  const git = require('../server/git');
  const { execFileSync } = require('child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'srpopo-wt-rm-'));
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args]).toString().trim();
  g('init', '-q');
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 't');
  g('commit', '-q', '--allow-empty', '-m', 'init');

  // A clean removal reports nothing left on disk.
  const clean = await git.addWorktree(repo, 'clean', 'slug');
  assert.strictEqual(await git.isWorktreeRegistered(repo, clean.wtPath), true, 'the worktree is registered');
  assert.deepStrictEqual(await git.removeWorktree(repo, clean.wtPath), { leftover: false }, 'nothing left behind');
  assert.strictEqual(await git.isWorktreeRegistered(repo, clean.wtPath), false, 'and it is deregistered');

  // Removing it again is a no-op rather than "is not a working tree".
  assert.deepStrictEqual(await git.removeWorktree(repo, clean.wtPath), { leftover: false }, 'a second removal succeeds');

  // A directory git can't empty (no write permission) makes `git worktree
  // remove` exit non-zero *after* deregistering the worktree: the removal still
  // counts, and the surviving files are reported rather than swallowed. Only
  // assertable where file modes actually block a delete — not on Windows, and
  // not as root, which ignores them.
  const modesApply = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0);
  if (modesApply) {
    const stuck = await git.addWorktree(repo, 'stuck', 'slug');
    const locked = path.join(stuck.wtPath, 'cache');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'f.bin'), 'x');
    fs.chmodSync(locked, 0o500);
    try {
      assert.deepStrictEqual(await git.removeWorktree(repo, stuck.wtPath), { leftover: true }, 'leftover files are reported');
      assert.strictEqual(await git.isWorktreeRegistered(repo, stuck.wtPath), false, 'the worktree is gone from git');
    } finally {
      fs.chmodSync(locked, 0o700);
      fs.rmSync(stuck.wtPath, { recursive: true, force: true });
    }
  }
});

test('github: module exports prForTask, mergePrForTask, and a pure parsePrList helper', () => {
  const github = require('../server/github');
  assert.strictEqual(typeof github.prForTask, 'function', 'prForTask is exported');
  assert.strictEqual(typeof github.mergePrForTask, 'function', 'mergePrForTask is exported');
  assert.strictEqual(typeof github.parsePrList, 'function', 'parsePrList is exported');
});

test('github: a task with no branch resolves to no-branch without invoking gh', async () => {
  const github = require('../server/github');
  // No branch means we must never spawn `gh`; a bogus path would fail loudly if we did.
  const res = await github.prForTask({ branch: null, repoPath: '/nonexistent/repo' });
  assert.deepStrictEqual(res, { pr: null, reason: 'no-branch' });
});

test('github: merging a branch-less task resolves to no-pr without invoking gh', async () => {
  const github = require('../server/github');
  // With no branch there is no PR to look up, so mergePrForTask must short-circuit
  // (via prForTask's no-branch) rather than spawn `gh pr merge` on a bogus path.
  const res = await github.mergePrForTask({ branch: null, repoPath: '/nonexistent/repo' });
  assert.deepStrictEqual(res, { ok: false, reason: 'no-branch' });
});

test('github: classifyPrCheck grades merge-safety over sample gh payloads', () => {
  const github = require('../server/github');

  const green = { state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] };
  assert.strictEqual(github.classifyPrCheck(green), 'green', 'open + mergeable + passing checks is green');

  // No CI configured at all counts as "not failing" → still green.
  assert.strictEqual(
    github.classifyPrCheck({ state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [] }),
    'green',
    'no checks configured is treated as green',
  );

  // A check still running → pending (never merge).
  assert.strictEqual(
    github.classifyPrCheck({ ...green, statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '' }] }),
    'pending',
    'an in-progress check is pending',
  );

  // A failed check → failing regardless of mergeability.
  assert.strictEqual(
    github.classifyPrCheck({ ...green, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }),
    'failing',
    'a failed check is failing',
  );
  // Older commit-status shape ({ state }) is understood too.
  assert.strictEqual(
    github.classifyPrCheck({ ...green, statusCheckRollup: [{ state: 'ERROR' }] }),
    'failing',
    'a commit-status ERROR is failing',
  );

  // Draft / closed / branch-protection-blocked → blocked (leave for the human).
  assert.strictEqual(github.classifyPrCheck({ ...green, isDraft: true }), 'blocked', 'draft is blocked');
  assert.strictEqual(github.classifyPrCheck({ ...green, state: 'MERGED' }), 'blocked', 'already-merged/closed is blocked');
  assert.strictEqual(github.classifyPrCheck({ ...green, mergeStateStatus: 'BLOCKED' }), 'blocked', 'branch-protection blocked is blocked');

  // A real merge conflict with main gets its own status, distinct from 'blocked',
  // so server/conflicts.ts knows it's the one case a resume can actually fix.
  assert.strictEqual(github.classifyPrCheck({ ...green, mergeable: 'CONFLICTING' }), 'conflicts', 'conflicting mergeable is conflicts');
  assert.strictEqual(github.classifyPrCheck({ ...green, mergeStateStatus: 'DIRTY' }), 'conflicts', 'dirty merge state is conflicts');

  // Mergeability not yet computed → pending, not green.
  assert.strictEqual(github.classifyPrCheck({ ...green, mergeable: 'UNKNOWN' }), 'pending', 'unknown mergeability is pending');

  // Garbage → no-pr (never a false green).
  assert.strictEqual(github.classifyPrCheck(null), 'no-pr', 'null is no-pr');
  assert.strictEqual(github.classifyPrCheck('nope'), 'no-pr', 'non-object is no-pr');
});

test('github: prCheckForTask short-circuits a branch-less task to no-pr without invoking gh', async () => {
  const github = require('../server/github');
  assert.strictEqual(typeof github.prCheckForTask, 'function', 'prCheckForTask is exported');
  const res = await github.prCheckForTask({ branch: null, repoPath: '/nonexistent/repo' });
  assert.deepStrictEqual(res, { status: 'no-pr', reason: 'no-branch', pr: null });
});

test('github: parsePrList normalizes a gh payload and handles the empty list', () => {
  const github = require('../server/github');

  // Success: first PR, state lower-cased, draftness kept separate.
  const payload = JSON.stringify([
    { number: 42, url: 'https://github.com/o/r/pull/42', state: 'OPEN', title: 'Add X', isDraft: true, updatedAt: '2026-07-13T00:00:00Z' },
  ]);
  assert.deepStrictEqual(github.parsePrList(payload), {
    number: 42,
    url: 'https://github.com/o/r/pull/42',
    title: 'Add X',
    state: 'open',
    isDraft: true,
    updatedAt: '2026-07-13T00:00:00Z',
  });

  // Empty list / non-array / garbage → null (never a partial PR).
  assert.strictEqual(github.parsePrList('[]'), null, 'empty list yields null');
  assert.strictEqual(github.parsePrList('not json'), null, 'unparsable yields null');
  assert.strictEqual(github.parsePrList('{}'), null, 'non-array yields null');
  assert.strictEqual(github.parsePrList(JSON.stringify([{ url: 'x' }])), null, 'a PR without a number is rejected');
});

test('conflicts: module exports resolveConflicts/sweep and a follow-up prompt', () => {
  const conflicts = require('../server/conflicts');
  assert.strictEqual(typeof conflicts.resolveConflicts, 'function', 'resolveConflicts is exported');
  assert.strictEqual(typeof conflicts.sweep, 'function', 'sweep is exported');
  assert.strictEqual(typeof conflicts.start, 'function', 'start is exported');
  assert.match(conflicts.CONFLICT_PROMPT, /conflict/i, 'the follow-up prompt mentions conflicts');
});

test('conflicts: resolveConflicts is a no-op for a task with no session to resume', () => {
  const conflicts = require('../server/conflicts');
  const task = { id: 'no-session-task', sessionId: null, resolvingConflicts: false };
  assert.strictEqual(conflicts.resolveConflicts(task), false, 'no sessionId means nothing to resume');
  assert.strictEqual(task.resolvingConflicts, false, 'the label is never set for a run that never started');
});

test('conflicts: sweep is a no-op when the setting is off, even with a conflicting task in validation', async () => {
  const store = require('../server/store');
  const conflicts = require('../server/conflicts');
  const prev = store.db.settings.autoResolveConflicts;
  store.db.settings.autoResolveConflicts = false;
  const task = {
    id: 'sweep-off-task', archived: false, status: 'validation', resolvingConflicts: false,
    branch: 'feature/x', sessionId: 'sess-1',
  };
  store.db.tasks.push(task);
  try {
    await conflicts.sweep();
    assert.strictEqual(task.resolvingConflicts, false, 'nothing is dispatched while the setting is off');
  } finally {
    store.db.tasks.pop();
    store.db.settings.autoResolveConflicts = prev;
  }
});

test('pr-refresh: module exports sweep and start', () => {
  const prRefresh = require('../server/pr-refresh');
  assert.strictEqual(typeof prRefresh.sweep, 'function', 'sweep is exported');
  assert.strictEqual(typeof prRefresh.start, 'function', 'start is exported');
});

test('pr-refresh: sweep ignores tasks with no branch, archived tasks, and non-validation tasks', async () => {
  const bus = require('../server/bus');
  const prRefresh = require('../server/pr-refresh');
  const tasks = [
    mkTask('pr-nb', 'validation', 'repoA'), // no branch resolved yet
    mkTask('pr-ar', 'validation', 'repoA', { branch: 'feature/x', archived: true }),
    mkTask('pr-rd', 'ready', 'repoA', { branch: 'feature/y' }),
  ];
  const restore = withStore(tasks, 10);
  const seen: unknown[] = [];
  const unsubscribe = bus.subscribe((msg: unknown) => seen.push(msg));
  try {
    await prRefresh.sweep();
    assert.deepStrictEqual(seen, [], 'none of these tasks are eligible, so no gh lookup or broadcast happens');
  } finally {
    unsubscribe();
    restore();
  }
});

test('pr-refresh: sweep broadcasts a pr event once per change, keyed off a nonexistent worktree so gh fails fast and deterministically', async () => {
  const bus = require('../server/bus');
  const prRefresh = require('../server/pr-refresh');
  // A cwd that can't exist makes the `gh` spawn fail immediately with ENOENT
  // regardless of whether this machine has `gh` installed/authenticated —
  // deterministic and fast, same trick as the module's own no-branch tests.
  const task = mkTask('pr-1', 'validation', 'repoA', { branch: 'feature/x', repoPath: '/tmp/srpopo-test-does-not-exist' });
  const restore = withStore([task], 10);
  const seen: Array<{ type?: string; taskId?: string; result?: unknown }> = [];
  const unsubscribe = bus.subscribe((msg: { type?: string; taskId?: string; result?: unknown }) => seen.push(msg));
  try {
    await prRefresh.sweep();
    const first = seen.filter((m) => m.type === 'pr');
    assert.strictEqual(first.length, 1, 'one pr event for the one eligible task');
    assert.strictEqual(first[0].taskId, 'pr-1');
    assert.deepStrictEqual(first[0].result, { pr: null, reason: 'gh-missing' });

    // Sweeping again with an unchanged result should not re-broadcast.
    await prRefresh.sweep();
    assert.strictEqual(seen.filter((m) => m.type === 'pr').length, 1, 'an unchanged result does not re-broadcast');
  } finally {
    unsubscribe();
    restore();
  }
});

test('linear: module exports non-throwing fetchers and pure parse helpers', () => {
  const linear = require('../server/linear');
  for (const fn of ['listMyIssues', 'getIssue', 'parseIssue', 'parseIssueList', 'briefFromIssue']) {
    assert.strictEqual(typeof linear[fn], 'function', `${fn} is exported`);
  }
});

test('linear: listMyIssues resolves to no-token without a configured key (no network)', async () => {
  const store = require('../server/store');
  const linear = require('../server/linear');
  const prev = store.db.settings.linearApiToken;
  store.db.settings.linearApiToken = ''; // a real fetch here would fail loudly
  try {
    assert.deepStrictEqual(await linear.listMyIssues(), { ok: false, reason: 'no-token' });
    assert.deepStrictEqual(await linear.getIssue('ABC-123'), { ok: false, reason: 'no-token' });
    assert.deepStrictEqual(await linear.getIssue(''), { ok: false, reason: 'not-found' });
  } finally {
    store.db.settings.linearApiToken = prev;
  }
});

test('linear: parseIssueList normalizes, sorts by updatedAt desc, and handles junk', () => {
  const linear = require('../server/linear');

  const payload = {
    data: {
      viewer: {
        assignedIssues: {
          nodes: [
            { id: 'u1', identifier: 'ABC-1', title: 'Older', url: 'https://l/ABC-1', updatedAt: '2026-07-01T00:00:00Z', state: { name: 'Todo' } },
            { id: 'u2', identifier: 'ABC-2', title: 'Newer', url: 'https://l/ABC-2', updatedAt: '2026-07-10T00:00:00Z', state: { name: 'In Progress' } },
            { title: 'no id — dropped' },
          ],
        },
      },
    },
  };
  assert.deepStrictEqual(linear.parseIssueList(payload), [
    { id: 'u2', identifier: 'ABC-2', title: 'Newer', url: 'https://l/ABC-2', state: 'In Progress', updatedAt: '2026-07-10T00:00:00Z' },
    { id: 'u1', identifier: 'ABC-1', title: 'Older', url: 'https://l/ABC-1', state: 'Todo', updatedAt: '2026-07-01T00:00:00Z' },
  ]);

  // Empty / malformed payloads yield [] (never a throw or a partial row).
  assert.deepStrictEqual(linear.parseIssueList({}), []);
  assert.deepStrictEqual(linear.parseIssueList(null), []);
  assert.deepStrictEqual(linear.parseIssueList({ data: { viewer: { assignedIssues: { nodes: 'nope' } } } }), []);
});

test('linear: parseIssue reads both the issue and issues.nodes shapes; briefFromIssue keeps origin', () => {
  const linear = require('../server/linear');

  // Direct `issue(id:)` shape, with comments normalized.
  const byId = {
    data: {
      issue: {
        identifier: 'ENG-42', title: 'Fix the thing', description: 'It is broken.', url: 'https://l/ENG-42',
        state: { name: 'Todo' },
        comments: { nodes: [
          { body: 'Repro here', createdAt: '2026-07-02T00:00:00Z', user: { name: 'Ada' } },
          { body: '   ', createdAt: '2026-07-03T00:00:00Z', user: { name: 'Blank' } }, // empty → dropped
        ] },
      },
    },
  };
  const issue = linear.parseIssue(byId);
  assert.deepStrictEqual(issue, {
    identifier: 'ENG-42', title: 'Fix the thing', description: 'It is broken.', url: 'https://l/ENG-42',
    state: 'Todo',
    comments: [{ body: 'Repro here', author: 'Ada', createdAt: '2026-07-02T00:00:00Z' }],
  });

  // The identifier-lookup shape (issues.nodes[0]) parses the same way.
  const byIdent = { data: { issues: { nodes: [{ identifier: 'ENG-9', title: 'T', url: 'https://l/ENG-9', state: { name: 'Done' } }] } } };
  assert.strictEqual(linear.parseIssue(byIdent).identifier, 'ENG-9');

  // Missing / malformed issue → null.
  assert.strictEqual(linear.parseIssue({ data: { issue: null } }), null);
  assert.strictEqual(linear.parseIssue({}), null);
  assert.strictEqual(linear.parseIssue({ data: { issue: { title: 'no identifier' } } }), null);

  // briefFromIssue leads with the identifier + URL so the origin is preserved.
  const brief = linear.briefFromIssue(issue);
  assert.match(brief, /^Linear issue ENG-42 — https:\/\/l\/ENG-42/, 'identifier + url lead the brief');
  assert.match(brief, /# Fix the thing/, 'title is included');
  assert.match(brief, /It is broken\./, 'description is included');
  assert.match(brief, /Repro here/, 'comment body is included');
});

// A spec-root file with the full required frontmatter, which is the only shape
// discoverSpecs lists.
const specFile = (number: string, title: string) =>
  `---\nnumber: "${number}"\ntitle: "${title}"\nstatus: draft\ncreated: 2026-06-06\n---\n\n# ${title}\n\nBody.\n`;

test('repoSpecs: discoverSpecs lists spec-root .md files with full frontmatter, and nothing else', () => {
  const repoSpecs = require('../server/repoSpecs');
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'srpopo-specs-'));

  fs.mkdirSync(path.join(repoPath, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(repoPath, 'specs', '0001-add-dark-mode.md'), specFile('0001', 'Add Dark Mode'));
  fs.mkdirSync(path.join(repoPath, '.specs'), { recursive: true });
  fs.writeFileSync(path.join(repoPath, '.specs', '0002-local-idea.md'), specFile('0002', 'Local Idea'));

  // Ignored: not a markdown extension.
  fs.writeFileSync(path.join(repoPath, 'specs', 'notes.txt'), 'not a spec');
  // Ignored: no frontmatter at all — a generated index, not a dispatchable spec.
  fs.writeFileSync(path.join(repoPath, 'specs', 'README.md'), '# Specs\n\n- 0001 Add Dark Mode\n');
  // Ignored: frontmatter, but missing the required `created:`.
  fs.writeFileSync(path.join(repoPath, 'specs', '0003-partial.md'),
    '---\nnumber: "0003"\ntitle: "Partial"\nstatus: draft\n---\n# Partial\n');
  // Ignored: a conforming spec, but nested in a subfolder rather than the root.
  fs.mkdirSync(path.join(repoPath, 'specs', 'research'), { recursive: true });
  fs.writeFileSync(path.join(repoPath, 'specs', 'research', '0004-nested.md'), specFile('0004', 'Nested'));

  const found = repoSpecs.discoverSpecs(repoPath);
  assert.deepStrictEqual(
    found.map((f: { path: string }) => f.path),
    ['specs/0001-add-dark-mode.md', '.specs/0002-local-idea.md'],
    'only the two conforming spec-root files, ascending by number',
  );
  assert.deepStrictEqual(
    found.map((f: { title: string }) => f.title),
    ['Add Dark Mode', 'Local Idea'],
  );

  // An absent specs dir (repo with neither root) yields [].
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'srpopo-specs-bare-'));
  assert.deepStrictEqual(repoSpecs.discoverSpecs(bare), [], 'no specs/ or .specs/ dir yields no results');
});

test('repoSpecs: readSpec rejects path traversal and missing files', () => {
  const repoSpecs = require('../server/repoSpecs');
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'srpopo-specs-read-'));
  fs.mkdirSync(path.join(repoPath, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(repoPath, 'specs', 'idea.md'), '# Idea\n\nDo the thing.');

  const ok = repoSpecs.readSpec(repoPath, 'specs/idea.md');
  assert.deepStrictEqual(ok, { ok: true, content: '# Idea\n\nDo the thing.' });

  assert.deepStrictEqual(
    repoSpecs.readSpec(repoPath, '../../etc/passwd'),
    { ok: false, reason: 'invalid-path' },
    'traversal above the repo is rejected',
  );
  assert.deepStrictEqual(
    repoSpecs.readSpec(repoPath, '/etc/passwd'),
    { ok: false, reason: 'invalid-path' },
    'an absolute path override is rejected',
  );
  assert.deepStrictEqual(
    repoSpecs.readSpec(repoPath, 'specs/../../../etc/passwd'),
    { ok: false, reason: 'invalid-path' },
    'a path that resolves outside the spec roots via .. is rejected',
  );
  assert.deepStrictEqual(
    repoSpecs.readSpec(repoPath, 'specs/does-not-exist.md'),
    { ok: false, reason: 'not-found' },
    'a nonexistent but otherwise-valid relative path is not-found',
  );
});

test('repoSpecs: referencePrompt points at the spec instead of pasting it', () => {
  const repoSpecs = require('../server/repoSpecs');
  const prompt = repoSpecs.referencePrompt('specs/0084-add-auth.md');
  assert.match(prompt, /Read the spec at `specs\/0084-add-auth\.md` and implement it\./);
  assert.ok(!prompt.includes('@specs/'), 'no CLI-specific @-mention: the backend is switchable to Codex');
  assert.ok(prompt.length < 1000, 'stays a short instruction rather than a copy of the spec');
});

test('repoSpecs: inlinePrompt carries the text for a spec the run cannot open', () => {
  const repoSpecs = require('../server/repoSpecs');
  const prompt = repoSpecs.inlinePrompt('.specs/active/idea.md', '# Idea\n\nDo the thing.');
  assert.ok(prompt.includes('# Idea\n\nDo the thing.'), 'the spec body travels in the prompt');
  assert.match(prompt, /`\.specs\/active\/idea\.md`/, 'still names the path it came from');
  assert.match(prompt, /not\n?checked into git/, 'explains why the text is inlined');
});

// The tracked check is what decides reference-vs-inline at import, and getting it
// backwards points a run at a file that isn't in its worktree — so exercise it
// against a real git repo rather than a stub.
test('git: isTracked distinguishes committed specs from git-ignored ones', async () => {
  const git = require('../server/git');
  const { execFileSync } = require('child_process');
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'srpopo-tracked-'));
  const run = (...args: string[]) => execFileSync('git', ['-C', repoPath, ...args], { stdio: 'pipe' });
  run('init', '-q');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');

  fs.mkdirSync(path.join(repoPath, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(repoPath, 'specs', 'tracked.md'), '# Tracked');
  fs.mkdirSync(path.join(repoPath, '.specs'), { recursive: true });
  fs.writeFileSync(path.join(repoPath, '.specs', 'ignored.md'), '# Ignored');
  fs.writeFileSync(path.join(repoPath, '.gitignore'), '.specs/\n');
  run('add', 'specs/tracked.md', '.gitignore');
  run('commit', '-qm', 'add spec');

  assert.strictEqual(await git.isTracked(repoPath, 'specs/tracked.md'), true);
  assert.strictEqual(
    await git.isTracked(repoPath, '.specs/ignored.md'), false,
    'a git-ignored spec is absent from a worktree, so it must not be referenced by path',
  );
  assert.strictEqual(await git.isTracked(repoPath, 'specs/nope.md'), false, 'a missing path is not tracked');
  assert.strictEqual(
    await git.isTracked(os.tmpdir(), 'specs/tracked.md'), false,
    'a non-repo answers false rather than throwing',
  );
});

test('repoSpecs: parseFrontmatter reads key/value pairs and never throws', () => {
  const repoSpecs = require('../server/repoSpecs');
  const fm = repoSpecs.parseFrontmatter('---\nnumber: "0084"\nstatus: draft\ntitle: Add Auth\n---\n# Ignored\n');
  assert.deepStrictEqual(fm, { number: '0084', status: 'draft', title: 'Add Auth' }, 'quotes stripped, all keys read');
  assert.deepStrictEqual(repoSpecs.parseFrontmatter('# Just a heading\n\nBody.'), {}, 'no frontmatter yields {}');
  assert.deepStrictEqual(repoSpecs.parseFrontmatter(''), {}, 'empty input yields {}');
});

test('repoSpecs: discoverSpecs reads frontmatter, prefers title, and sorts by number', () => {
  const repoSpecs = require('../server/repoSpecs');
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'srpopo-specs-fm-'));
  fs.mkdirSync(path.join(repoPath, 'specs'), { recursive: true });

  fs.writeFileSync(path.join(repoPath, 'specs', '0084-add-auth.md'),
    '---\nnumber: "0084"\nstatus: draft\ntitle: Add Authentication\ncreated: 2026-06-06\n---\n# Different Heading\n\nBody.');
  fs.writeFileSync(path.join(repoPath, 'specs', '0012-logging.md'),
    '---\nnumber: "0012"\nstatus: implemented\ntitle: Structured Logging\ncreated: 2026-05-01\n---\n# Different Heading\n');

  const found = repoSpecs.discoverSpecs(repoPath);
  assert.deepStrictEqual(found.map((f: { number: string }) => f.number), ['0012', '0084'], 'ascending by number');
  const auth = found.find((f: { number: string }) => f.number === '0084');
  assert.strictEqual(auth.title, 'Add Authentication', 'frontmatter title beats the # heading');
  assert.strictEqual(auth.status, 'draft');
  assert.strictEqual(auth.created, '2026-06-06');
  const log = found.find((f: { number: string }) => f.number === '0012');
  assert.strictEqual(log.title, 'Structured Logging');
  assert.strictEqual(log.status, 'implemented');
});

test('repoSpecs: readSpecConfig reads specs/.spec-config.json, else {}', () => {
  const repoSpecs = require('../server/repoSpecs');
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'srpopo-specs-cfg-'));
  fs.mkdirSync(path.join(repoPath, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(repoPath, 'specs', '.spec-config.json'),
    JSON.stringify({ indexCommand: 'node specs/generate-index.mjs', actionableStatuses: ['draft', 'wip'] }));

  const config = repoSpecs.readSpecConfig(repoPath);
  assert.strictEqual(config.indexCommand, 'node specs/generate-index.mjs');
  assert.deepStrictEqual(config.actionableStatuses, ['draft', 'wip']);
  assert.strictEqual(repoSpecs.indexCommandTool(config), 'Bash(node:*)', 'tool derives from the command binary');

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'srpopo-specs-cfg-bare-'));
  assert.deepStrictEqual(repoSpecs.readSpecConfig(bare), {}, 'no config file yields {}');
  assert.strictEqual(repoSpecs.indexCommandTool({}), null, 'no command yields no tool');
});

test('framing: framePrompt appends a spec-completion block only for spec imports', () => {
  const framing = require('../server/framing');

  // Plain-markdown repo: generic "update the spec file" directive, no index step.
  const plainRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'srpopo-frame-plain-'));
  fs.mkdirSync(path.join(plainRepo, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(plainRepo, 'specs', 'idea.md'), '# Idea\n\nDo it.');
  const plainTask = { id: 'a', prompt: 'Body', personas: [], addons: [], attachments: [],
    repoPath: plainRepo, specOrigin: { path: 'specs/idea.md' } };
  const plainFramed = framing.framePrompt(plainTask);
  assert.ok(plainFramed.includes('# Spec completion'), 'has the completion header');
  assert.ok(plainFramed.includes('specs/idea.md'), 'names the spec path');
  assert.ok(plainFramed.includes('If the spec file tracks a status'), 'generic update directive');
  assert.ok(!plainFramed.includes('regenerate the spec index'), 'no index step without config');

  // Frontmatter-driven repo with a declared index command: full block.
  const fwRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'srpopo-frame-fw-'));
  fs.mkdirSync(path.join(fwRepo, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(fwRepo, 'specs', '0084-auth.md'), '---\nnumber: "0084"\nstatus: draft\n---\n# Auth\n');
  fs.writeFileSync(path.join(fwRepo, 'specs', '.spec-config.json'),
    JSON.stringify({ indexCommand: 'node specs/generate-index.mjs' }));
  const fwTask = { id: 'b', prompt: 'Body', personas: [], addons: [], attachments: [],
    repoPath: fwRepo, specOrigin: { path: 'specs/0084-auth.md' } };
  const fwFramed = framing.framePrompt(fwTask);
  assert.ok(fwFramed.trimEnd().endsWith('same commit/PR.'), 'the completion block ends the prompt');
  assert.ok(fwFramed.includes('`status:` to `implemented`'), 'frontmatter status directive');
  assert.ok(fwFramed.includes('node specs/generate-index.mjs'), 'names the repo index command');

  // No spec origin: prompt is untouched.
  const plain = framing.framePrompt({ id: 'c', prompt: 'Body', personas: [], addons: [], attachments: [] });
  assert.ok(!plain.includes('# Spec completion'), 'ordinary tasks get no completion block');

  // The runner auto-approves the declared index command's tool for a spec import.
  const runner = require('../server/runner');
  assert.ok(runner.effectiveAllowedTools(fwTask).split(',').includes('Bash(node:*)'), 'index tool auto-approved');
  assert.ok(!runner.effectiveAllowedTools(plainTask).includes('Bash(node:*)'), 'no index tool without config');
});

test('runner: allowedTools normalizes and maps to --allowedTools', () => {
  const runner = require('../server/runner');

  // Splits on commas/newlines, trims, drops empties, rejoins with commas.
  assert.strictEqual(
    runner.normalizeAllowedTools('Bash(npm run lint:*)\n Bash(npm test:*) ,'),
    'Bash(npm run lint:*),Bash(npm test:*)',
  );
  assert.strictEqual(runner.normalizeAllowedTools(''), '', 'empty string yields ""');
  assert.strictEqual(runner.normalizeAllowedTools(undefined), '', 'non-string yields ""');

  // buildArgs appends the flag; the user's tools lead, then the safe defaults.
  const withAllow = runner.buildArgs(
    { permissionMode: 'acceptEdits', allowedTools: 'Bash(npm test:*)' },
    false,
  );
  const i = withAllow.indexOf('--allowedTools');
  assert.ok(i !== -1, '--allowedTools should be present');
  const value = withAllow[i + 1];
  assert.ok(value.startsWith('Bash(npm test:*),'), 'user tools come first');
  for (const def of runner.DEFAULT_ALLOWED_TOOLS) {
    assert.ok(value.includes(def), `default ${def} is auto-approved`);
  }
  assert.ok(withAllow.includes('--permission-mode') && withAllow.includes('acceptEdits'),
    'permission mode is still emitted');

  // Package managers are allowed by default even when the user sets nothing.
  const noAllow = runner.buildArgs({ permissionMode: 'acceptEdits' }, false);
  const j = noAllow.indexOf('--allowedTools');
  assert.ok(j !== -1, 'defaults still emit the flag with no user tools');
  assert.deepStrictEqual(
    noAllow[j + 1].split(','),
    runner.DEFAULT_ALLOWED_TOOLS,
    'exactly the defaults when nothing else is selected',
  );
});

test('runner: mergeAllowedTools dedupes across sources and add-ons layer in', () => {
  const runner = require('../server/runner');

  // Strings and arrays merge; duplicates and blanks are dropped; order preserved.
  assert.strictEqual(
    runner.mergeAllowedTools('Bash(npm:*), Read', ['Read', 'Edit'], ' '),
    'Bash(npm:*),Read,Edit',
  );

  // Selecting "open a PR" auto-approves gh + git on top of the defaults.
  const args = runner.buildArgs(
    { permissionMode: 'acceptEdits', addons: ['pull_request'] },
    false,
  );
  const value = args[args.indexOf('--allowedTools') + 1];
  assert.ok(value.includes('Bash(gh:*)'), 'gh is auto-approved for the PR add-on');
  assert.ok(value.includes('Bash(git push:*)'), 'git push is auto-approved for the PR add-on');
  assert.ok(value.includes('Bash(npm:*)'), 'package-manager defaults are still present');
});

test('runner: runningCount tracks isRunning and starts at zero', () => {
  const runner = require('../server/runner');
  assert.strictEqual(runner.runningCount(), 0, 'no tasks running at module load');
  assert.strictEqual(runner.isRunning('nonexistent'), false);
});

test('runner: promptPermissions wires the approval MCP bridge (and skips it on bypass)', () => {
  const runner = require('../server/runner');

  const on = runner.buildArgs({ id: 'abc123', permissionMode: 'acceptEdits', promptPermissions: true }, false);
  const ti = on.indexOf('--permission-prompt-tool');
  assert.ok(ti !== -1, '--permission-prompt-tool is present when opted in');
  assert.strictEqual(on[ti + 1], runner.PERMISSION_TOOL, 'points at the srpopo approve tool');
  const ci = on.indexOf('--mcp-config');
  assert.ok(ci !== -1, '--mcp-config registers the bridge');
  const cfg = JSON.parse(on[ci + 1]);
  assert.ok(cfg.mcpServers && cfg.mcpServers.srpopo, 'config declares the srpopo server');
  assert.match(cfg.mcpServers.srpopo.env.SRPOPO_APPROVAL_URL, /\/api\/tasks\/abc123\/permission$/, 'bridge points back at this task');

  // Opting in is a no-op under bypassPermissions — there is nothing to prompt for.
  const bypass = runner.buildArgs({ id: 'abc123', permissionMode: 'bypassPermissions', promptPermissions: true }, false);
  assert.ok(!bypass.includes('--permission-prompt-tool'), 'no prompt tool under bypass');
  assert.ok(bypass.includes('--dangerously-skip-permissions'), 'bypass still skips permissions');

  // Off by opt-out.
  const off = runner.buildArgs({ id: 'abc123', permissionMode: 'acceptEdits', promptPermissions: false }, false);
  assert.ok(!off.includes('--permission-prompt-tool'), 'no prompt tool when not opted in');
});

test('claude adapter: every session is isolated from the user\'s own MCP servers', () => {
  const runner = require('../server/runner');
  const claude = require('../server/agents/claude');
  const store = require('../server/store');

  assert.strictEqual(store.DEFAULT_SETTINGS.isolateMcpServers, true, 'MCP isolation defaults on');

  const prev = store.db.settings.isolateMcpServers;
  try {
    store.db.settings.isolateMcpServers = true;
    // Each builder isolates: a task keeps its own permission bridge, an
    // orchestration its board server, and grooming/review end up with none.
    const task = runner.buildArgs({ id: 'abc123', permissionMode: 'acceptEdits', promptPermissions: true }, false);
    assert.ok(task.includes('--strict-mcp-config'), 'a dispatched task is isolated');
    assert.ok(task.includes('--mcp-config'), 'and still registers the permission bridge');
    assert.ok(claude.groomArgs({ model: 'default', sessionId: null }).includes('--strict-mcp-config'), 'grooming is isolated');
    assert.ok(claude.reviewArgs({ model: 'default', agent: 'claude' }).includes('--strict-mcp-config'), 'code review is isolated');
    const orch = claude.orchestrateArgs({ model: 'default', sessionId: null }, false);
    assert.ok(orch.includes('--strict-mcp-config'), 'an orchestration is isolated');
    assert.ok(orch.includes('--mcp-config'), 'and still registers the board server');

    // The escape hatch: off means the flag is gone everywhere, nothing else moves.
    store.db.settings.isolateMcpServers = false;
    assert.ok(!runner.buildArgs({ id: 'abc123', permissionMode: 'acceptEdits' }, false).includes('--strict-mcp-config'));
    assert.ok(!claude.groomArgs({ model: 'default', sessionId: null }).includes('--strict-mcp-config'));
    assert.ok(!claude.reviewArgs({ model: 'default', agent: 'claude' }).includes('--strict-mcp-config'));
    assert.ok(!claude.orchestrateArgs({ model: 'default', sessionId: null }, false).includes('--strict-mcp-config'));
  } finally {
    store.db.settings.isolateMcpServers = prev;
  }
});

test('claude adapter: a session gets a JS heap budget (the CLI is a Bun binary, not Node)', () => {
  const runner = require('../server/runner');
  const store = require('../server/store');
  const prev = store.db.settings.sessionMemoryMb;
  const prevCap = store.db.settings.maxParallelSessions;
  try {
    assert.strictEqual(store.DEFAULT_SETTINGS.sessionMemoryMb, 'auto', 'the budget defaults to auto');

    store.db.settings.sessionMemoryMb = 2048;
    const env = runner.buildTaskEnv('default');
    assert.strictEqual(env.BUN_JSC_forceRAMSize, String(2048 * 1024 * 1024), 'sized against the budget');
    assert.strictEqual(env.BUN_JSC_gcMaxHeapSize, String(4096 * 1024 * 1024), 'with a ceiling above it');
    // Invariant #2 + #3 still hold with the budget layered on.
    assert.strictEqual(env.ANTHROPIC_API_KEY, undefined, 'no API key reaches the child');
    assert.strictEqual(env.CLAUDECODE, undefined, 'nested-session markers stay stripped');

    // Auto scales down as more sessions share the machine, and stays in bounds.
    store.db.settings.sessionMemoryMb = 'auto';
    store.db.settings.maxParallelSessions = 1;
    const roomy = runner.autoSessionMemoryMb();
    store.db.settings.maxParallelSessions = 8;
    const crowded = runner.autoSessionMemoryMb();
    assert.ok(roomy >= crowded, 'a crowded board budgets each session less');
    assert.ok(crowded >= 1024 && roomy <= 6144, 'auto stays between the 1 GB floor and the 6 GB ceiling');
    assert.strictEqual(runner.buildTaskEnv('default').BUN_JSC_forceRAMSize, String(runner.autoSessionMemoryMb() * 1024 * 1024));

    // Off means no budget at all — the old behavior, for anyone who wants it.
    store.db.settings.sessionMemoryMb = 0;
    assert.strictEqual(runner.buildTaskEnv('default').BUN_JSC_forceRAMSize, undefined, 'no budget when turned off');
  } finally {
    store.db.settings.sessionMemoryMb = prev;
    store.db.settings.maxParallelSessions = prevCap;
  }
});

test('usage: applyResult records a per-model ledger row and accumulates task.modelUsage', () => {
  const usage = require('../server/usage');
  const store = require('../server/store');
  const task: Record<string, unknown> = {
    id: 't-usage-1', title: 'Usage test task', status: 'running',
    repoId: 'repoA', repoName: 'RepoA', model: 'default', resolvedModel: 'claude-sonnet-5',
  };
  const event = {
    type: 'result', ts: '2024-01-01T00:00:00.000Z', duration_ms: 1000, num_turns: 3, total_cost_usd: 0.05,
    modelUsage: {
      'claude-sonnet-5': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, cacheCreationInputTokens: 5, costUSD: 0.05 },
    },
  };
  usage.applyResult(task, event);

  const modelUsage = task.modelUsage as Record<string, { costUsd: number; inputTokens: number }>;
  assert.ok(modelUsage['claude-sonnet-5'], 'model accumulated onto the task');
  assert.strictEqual(modelUsage['claude-sonnet-5'].costUsd, 0.05);
  assert.strictEqual(modelUsage['claude-sonnet-5'].inputTokens, 100);

  const rows = store.readUsage().filter((r: { taskId: string }) => r.taskId === 't-usage-1');
  assert.strictEqual(rows.length, 1, 'one ledger row written');
  assert.strictEqual(rows[0].model, 'claude-sonnet-5');
  assert.strictEqual(rows[0].kind, 'run', 'status running maps to kind run');
});

test('usage: applyResult falls back to a single row keyed by resolvedModel when modelUsage is absent', () => {
  const usage = require('../server/usage');
  const store = require('../server/store');
  const task: Record<string, unknown> = {
    id: 't-usage-2', title: 'No modelUsage', status: 'running',
    repoId: 'repoA', repoName: 'RepoA', model: 'default', resolvedModel: 'claude-haiku-4-5-20251001',
  };
  const event = {
    type: 'result', ts: '2024-01-01T00:00:00.000Z', total_cost_usd: 0.01,
    usage: { input_tokens: 20, output_tokens: 10 },
  };
  usage.applyResult(task, event);

  const rows = store.readUsage().filter((r: { taskId: string }) => r.taskId === 't-usage-2');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].model, 'claude-haiku-4-5-20251001', 'falls back to the resolved model');
  assert.strictEqual(rows[0].kind, 'run', 'a dispatched task run always maps to kind run');
  assert.strictEqual(rows[0].costUsd, 0.01);
});

test('usage: applyGroomResult records a groom-kind ledger row without touching task.modelUsage', () => {
  const usage = require('../server/usage');
  const store = require('../server/store');
  const grooming: Record<string, unknown> = {
    id: 'g-usage-1', title: 'Groom a rough idea',
    repoId: 'repoA', repoName: 'RepoA', model: 'default', resolvedModel: 'claude-haiku-4-5-20251001',
  };
  const event = {
    type: 'result', ts: '2024-01-01T00:00:00.000Z', total_cost_usd: 0.02,
    usage: { input_tokens: 40, output_tokens: 15 },
  };
  usage.applyGroomResult(grooming, event);

  assert.strictEqual(grooming.modelUsage, undefined, 'grooming cards have no modelUsage field to accumulate onto');
  const rows = store.readUsage().filter((r: { taskId: string }) => r.taskId === 'g-usage-1');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].model, 'claude-haiku-4-5-20251001');
  assert.strictEqual(rows[0].kind, 'groom', 'grooming runs always map to kind groom');
  assert.strictEqual(rows[0].costUsd, 0.02);
});

test('usage: computeSummary aggregates totals/byModel/byRepo and has no previous window for "all"', () => {
  const usage = require('../server/usage');
  const summary = usage.computeSummary({ period: 'all' });

  assert.ok(summary.totals.costUsd >= 0.06, 'totals include both rows written above');
  const sonnetRow = summary.byModel.find((m: { model: string }) => m.model === 'claude-sonnet-5');
  assert.ok(sonnetRow, 'sonnet appears in the model breakdown');
  assert.strictEqual(sonnetRow.runs, 1);
  const repoRow = summary.byRepo.find((r: { repoId: string }) => r.repoId === 'repoA');
  assert.ok(repoRow, 'repoA appears in the repo breakdown');
  assert.strictEqual(summary.previous, null, "'all' period has no previous window");

  const scoped = usage.computeSummary({ period: 'all', repoId: 'repoB-does-not-exist' });
  assert.strictEqual(scoped.totals.costUsd, 0, 'scoping to an unrelated repo excludes these rows');
});

test('permission-mcp: respond builds MCP replies and routes tools/call to the decider', async () => {
  const mcp = require('../server/permission-mcp');

  const init = await mcp.respond({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.strictEqual(init.result.protocolVersion, '2025-06-18', 'echoes the client protocol version');
  assert.ok(init.result.capabilities.tools, 'advertises tool capability');

  const list = await mcp.respond({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.strictEqual(list.result.tools[0].name, mcp.TOOL_NAME, 'lists the approve tool');

  // notifications get no reply; ping is answered.
  assert.strictEqual(await mcp.respond({ method: 'notifications/initialized' }), null, 'notifications are not answered');
  assert.deepStrictEqual((await mcp.respond({ jsonrpc: '2.0', id: 3, method: 'ping' })).result, {}, 'ping replies empty');

  // tools/call runs the injected decider and returns its decision as JSON text.
  const seen: unknown[] = [];
  const call = await mcp.respond(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: mcp.TOOL_NAME, arguments: { tool_name: 'Bash', input: { command: 'ls' } } } },
    async (args: unknown) => { seen.push(args); return { behavior: 'allow' }; },
  );
  assert.deepStrictEqual(seen[0], { tool_name: 'Bash', input: { command: 'ls' } }, 'decider receives the tool request');
  assert.deepStrictEqual(JSON.parse(call.result.content[0].text), { behavior: 'allow' }, 'decision is returned as text content');

  // An unknown tool denies rather than throwing.
  const bad = await mcp.respond({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  assert.strictEqual(JSON.parse(bad.result.content[0].text).behavior, 'deny', 'unknown tool is denied');
});

test('mcp: respond builds MCP replies, lists the board tools, and routes tools/call', async () => {
  const mcp = require('../server/mcp');

  const init = await mcp.respond({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.strictEqual(init.result.protocolVersion, '2025-06-18', 'echoes the client protocol version');
  assert.ok(init.result.capabilities.tools, 'advertises tool capability');
  assert.strictEqual(init.result.serverInfo.name, 'srpopo', 'identifies as srpopo');

  const list = await mcp.respond({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = list.result.tools.map((t: { name: string }) => t.name);
  for (const n of ['list_repos', 'list_tasks', 'get_task', 'create_task', 'dispatch_task', 'stop_task']) {
    assert.ok(names.includes(n), `${n} is advertised`);
  }

  // notifications get no reply; ping is answered; unknown methods report not-found.
  assert.strictEqual(await mcp.respond({ method: 'notifications/initialized' }), null, 'notifications are not answered');
  assert.deepStrictEqual((await mcp.respond({ jsonrpc: '2.0', id: 3, method: 'ping' })).result, {}, 'ping replies empty');
  assert.strictEqual((await mcp.respond({ jsonrpc: '2.0', id: 4, method: 'nope' })).error.code, -32601, 'unknown method is not-found');

  // tools/call routes to the injected executor and returns its result.
  const seen: unknown[] = [];
  const call = await mcp.respond(
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_repos', arguments: {} } },
    async (name: string, args: unknown) => { seen.push([name, args]); return { content: [{ type: 'text', text: 'ok' }] }; },
  );
  assert.deepStrictEqual(seen[0], ['list_repos', {}], 'executor receives the tool name and args');
  assert.strictEqual(call.result.content[0].text, 'ok', 'the tool result is returned');

  // An unknown tool is a tool-level error (isError), not a JSON-RPC error.
  const bad = await mcp.respond({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  assert.strictEqual(bad.result.isError, true, 'unknown tool is an isError result');
});

test('mcp: create_task / list_tasks / get_task round-trip through the store', async () => {
  const store = require('../server/store');
  const mcp = require('../server/mcp');

  const repo = { id: store.id(), path: '/tmp/mcp-repo', name: 'o/mcp', branch: null, addedAt: store.now() };
  store.db.repos.push(repo);

  // create_task queues a backlog task through the shared task service.
  const created = JSON.parse((await mcp.callTool('create_task', { repoId: repo.id, title: 'MCP task', prompt: 'do the thing' })).content[0].text);
  assert.strictEqual(created.status, 'backlog', 'created in backlog by default');
  assert.strictEqual(created.repoId, repo.id, 'attached to the target repo');

  // list_tasks (filtered by repo) shows the compact summary.
  const list = JSON.parse((await mcp.callTool('list_tasks', { repoId: repo.id })).content[0].text);
  assert.ok(list.some((t: { id: string }) => t.id === created.id), 'the new task is listed');

  // get_task returns the full task plus a (bounded) log tail.
  const got = JSON.parse((await mcp.callTool('get_task', { taskId: created.id })).content[0].text);
  assert.strictEqual(got.task.id, created.id, 'returns the requested task');
  assert.ok(Array.isArray(got.events), 'includes a log-event array');

  // Missing input is a plain throw that respond() surfaces as an isError result.
  await assert.rejects(() => mcp.callTool('get_task', { taskId: 'nope' }), /Task not found/, 'a missing task throws');
  await assert.rejects(() => mcp.callTool('create_task', { repoId: repo.id, title: 'x' }), /required/, 'a prompt-less create throws');

  // title is optional — a titleless create derives one from the prompt.
  const titleless = JSON.parse((await mcp.callTool('create_task', { repoId: repo.id, prompt: 'Do the other thing' })).content[0].text);
  assert.strictEqual(titleless.title, 'Do the other thing', 'title derived from the prompt');
});

test('permissions: a pending prompt resolves with the user decision and is listed until settled', async () => {
  const permissions = require('../server/permissions');
  const taskId = 'perm-task-1';

  const { id: reqId, promise } = permissions.create(taskId, 'Bash', { command: 'rm -rf build' });
  assert.strictEqual(permissions.listForTask(taskId).length, 1, 'the request is pending');
  assert.strictEqual(permissions.listForTask(taskId)[0].toolName, 'Bash', 'exposes the requested tool');

  assert.ok(permissions.decide(taskId, reqId, { behavior: 'allow', updatedInput: { command: 'ls' } }), 'decide settles it');
  assert.deepStrictEqual(await promise, { behavior: 'allow', updatedInput: { command: 'ls' } }, 'promise resolves with the normalized allow');
  assert.strictEqual(permissions.listForTask(taskId).length, 0, 'no longer pending once settled');

  // A second decision on the same request is a no-op.
  assert.strictEqual(permissions.decide(taskId, reqId, { behavior: 'deny' }), false, 'already-settled decide is ignored');
});

test('permissions: deny normalizes a message; rejectForTask clears everything pending', async () => {
  const permissions = require('../server/permissions');
  const taskId = 'perm-task-2';

  const denied = permissions.create(taskId, 'Write', { file_path: '/etc/hosts' });
  permissions.decide(taskId, denied.id, { behavior: 'deny' });
  assert.deepStrictEqual(await denied.promise, { behavior: 'deny', message: 'Denied by user' }, 'deny gets a default reason');

  const a = permissions.create(taskId, 'Bash', {});
  const b = permissions.create(taskId, 'Edit', {});
  assert.strictEqual(permissions.listForTask(taskId).length, 2, 'both are pending');
  permissions.rejectForTask(taskId, 'Run ended');
  assert.strictEqual((await a.promise).behavior, 'deny', 'first is denied on reject');
  assert.strictEqual((await b.promise).message, 'Run ended', 'reject reason is passed through');
  assert.strictEqual(permissions.listForTask(taskId).length, 0, 'nothing left pending');
});

test('permissions: auto-approve allows new requests and clears the pending backlog', async () => {
  const permissions = require('../server/permissions');
  const taskId = 'perm-task-auto';
  assert.strictEqual(permissions.isAutoApprove(taskId), false, 'auto-approve is off by default');

  // Prompts already waiting are approved the moment auto-mode turns on.
  const waiting = permissions.create(taskId, 'Bash', { command: 'rm -rf build' });
  assert.strictEqual(permissions.listForTask(taskId).length, 1, 'the request is pending');
  permissions.setAutoApprove(taskId, true);
  assert.strictEqual(permissions.isAutoApprove(taskId), true, 'auto-approve is on');
  assert.strictEqual((await waiting.promise).behavior, 'allow', 'the pending prompt is auto-allowed');
  assert.strictEqual(permissions.listForTask(taskId).length, 0, 'nothing left pending');

  // A fresh request while auto is on resolves to allow without ever pending.
  const next = permissions.create(taskId, 'Write', { file_path: 'x' });
  assert.deepStrictEqual(await next.promise, { behavior: 'allow' }, 'new request is auto-allowed');
  assert.strictEqual(permissions.listForTask(taskId).length, 0, 'auto-allowed requests never pend');

  // Turning it off goes back to prompting.
  permissions.setAutoApprove(taskId, false);
  assert.strictEqual(permissions.isAutoApprove(taskId), false, 'auto-approve turns back off');

  // Ending the run (a stop, or a resume awaiting another turn) must NOT drop it —
  // it's a per-task preference that should carry over to the next dispatch of the
  // same task, not a per-run one the user has to re-flip every time.
  permissions.setAutoApprove(taskId, true);
  permissions.rejectForTask(taskId, 'Run ended');
  assert.strictEqual(permissions.isAutoApprove(taskId), true, 'auto-approve survives the run ending');

  // A fresh run for the same task should honor it immediately, with no re-prompt.
  const afterResume = permissions.create(taskId, 'Bash', { command: 'echo hi' });
  assert.deepStrictEqual(await afterResume.promise, { behavior: 'allow' }, 'the next run auto-allows without re-toggling');

  // Only forgetTask (used when the task itself is archived) actually clears it.
  permissions.forgetTask(taskId);
  assert.strictEqual(permissions.isAutoApprove(taskId), false, 'forgetTask drops auto-approve for good');
});

test('permissions: an unanswered prompt auto-denies after the timeout', async () => {
  const permissions = require('../server/permissions');
  permissions._setTimeoutMs(20); // shrink the 30-minute default for the test
  const { promise } = permissions.create('perm-task-3', 'Bash', {});
  // The module's auto-deny timer is .unref()'d (so a pending prompt never keeps
  // the real server alive). In the bare test process that timer would then be
  // the only handle left, and Node would exit before it fires. Hold a ref'd
  // handle open across the await so the timeout actually resolves under CI.
  const keepAlive = setInterval(() => {}, 5);
  try {
    const decision = await promise;
    assert.deepStrictEqual(decision, { behavior: 'deny', message: 'Timed out waiting for approval' }, 'times out to a deny');
  } finally {
    clearInterval(keepAlive);
    permissions._setTimeoutMs(permissions.DEFAULT_TIMEOUT_MS); // restore
  }
});

test('attachments: write/list/remove round-trips under the task dir and sanitizes traversal', () => {
  const attachments = require('../server/attachments');
  const taskId = 'attach-task-1';
  const dir = attachments.attachmentsDir(taskId);

  // A benign upload persists a file and reports its stored name/size.
  const bytes = Buffer.from('hello attachment');
  const { name, size } = attachments.write(taskId, 'notes.txt', bytes);
  assert.strictEqual(name, 'notes.txt', 'keeps the basename');
  assert.strictEqual(size, bytes.length, 'reports the byte length');
  assert.ok(fs.existsSync(path.join(dir, 'notes.txt')), 'file is on disk under the task dir');

  // listPaths yields absolute paths inside the task dir, skipping missing names.
  const paths = attachments.listPaths(taskId, ['notes.txt', 'gone.txt']);
  assert.deepStrictEqual(paths, [path.join(dir, 'notes.txt')], 'only existing files, absolute path');
  assert.ok(path.isAbsolute(paths[0]), 'path is absolute');

  // A path-traversal name is reduced to a safe basename inside the task dir.
  const evil = attachments.write(taskId, '../../evil', Buffer.from('x'));
  assert.strictEqual(evil.name, 'evil', 'traversal stripped to basename');
  assert.ok(fs.existsSync(path.join(dir, 'evil')), 'lands inside the task dir');
  assert.ok(!fs.existsSync(path.join(dir, '..', '..', 'evil')), 'never escapes the task dir');

  // A collision disambiguates rather than overwriting.
  const second = attachments.write(taskId, 'notes.txt', Buffer.from('other'));
  assert.strictEqual(second.name, 'notes (2).txt', 'collision is suffixed');

  // remove drops just the one file; removeDir clears the whole task dir.
  attachments.remove(taskId, 'notes.txt');
  assert.ok(!fs.existsSync(path.join(dir, 'notes.txt')), 'removed file is gone');
  assert.ok(fs.existsSync(path.join(dir, 'evil')), 'siblings remain');
  attachments.removeDir(taskId);
  assert.ok(!fs.existsSync(dir), 'removeDir clears the task dir');
});

test('personas: sanitize keeps only known ids and preamble is prepended', () => {
  const personas = require('../server/personas');
  const ids = personas.catalog().map((p: { id: string }) => p.id);
  assert.ok(ids.length > 0, 'there should be at least one persona');

  assert.deepStrictEqual(personas.sanitize(['nope', 'bad']), [], 'unknown ids dropped');
  assert.deepStrictEqual(personas.sanitize('not-an-array'), [], 'non-array yields []');

  const first = ids[0];
  assert.deepStrictEqual(personas.sanitize([first, first]), [first], 'known id deduped');

  assert.strictEqual(personas.preambleFor([]), '', 'no personas leaves prompt untouched');
  const preamble = personas.preambleFor([first]);
  assert.match(preamble, /^# Personas/, 'preamble leads with the Personas heading');
  assert.match(preamble, /---\n\n$/, 'preamble ends with a separator so it prepends cleanly');

  // Catalog is the lightweight view — it must not leak the full instruction text.
  assert.ok(!('instruction' in personas.catalog()[0]), 'catalog omits instruction text');
});

test('personas: autoPreamble hands the whole catalog to the run to pick from', () => {
  const personas = require('../server/personas');
  const auto = personas.autoPreamble();

  assert.match(auto, /^# Personas/, 'shaped like preambleFor so framing can swap them');
  assert.match(auto, /---\n\n$/, 'ends with a separator so it prepends cleanly');
  for (const p of personas.catalog()) {
    assert.ok(auto.includes(p.label), `the run is offered "${p.label}"`);
  }
});

test('framing: autoPersona replaces the hand-picked persona preamble', () => {
  const framing = require('../server/framing');
  const personas = require('../server/personas');
  const first = personas.catalog()[0].id;
  const base = { id: 'p', prompt: 'Body', addons: [], attachments: [] };

  const manual = framing.framePrompt({ ...base, personas: [first] });
  assert.ok(manual.includes(personas.preambleFor([first])), 'picked personas are prepended verbatim');
  assert.ok(!manual.includes('work out which expert role'), 'no auto-detection wording when off');

  const auto = framing.framePrompt({ ...base, personas: [first], autoPersona: true });
  assert.ok(auto.includes(personas.autoPreamble()), 'the run is asked to pick its own persona');
  assert.ok(!auto.includes(personas.preambleFor([first])), 'the picked persona is not also injected');
});

test('addons: the self-review add-on is hidden from the catalog but still applies by id', () => {
  const addons = require('../server/addons');
  const autonomous = require('../server/autonomous');

  const ids = addons.catalog().map((a: { id: string }) => a.id);
  assert.ok(ids.includes('pull_request'), 'the PR add-on is still offered');
  assert.ok(!ids.includes('code_review'), 'self-review is no longer a per-task checkbox');

  // Autonomous Mode and the orchestrator still apply it by id, so it must keep working.
  assert.ok(autonomous.REQUIRED_ADDONS.includes('code_review'), 'the engine still requires it');
  assert.deepStrictEqual(addons.sanitize(['code_review']), ['code_review'], 'still a valid id');
  assert.match(addons.instructionsFor(['code_review']), /self code review/, 'still injects its instruction');

  // The chip row needs a short name + glyph for every add-on it renders.
  for (const a of addons.catalog()) {
    assert.ok(a.short || a.label, `${a.id} has a chip label`);
    assert.ok(a.icon, `${a.id} has an icon`);
  }
});

test('groomer: metaPrompt embeds the idea and asks for a sentinel-delimited spec', () => {
  const groomer = require('../server/groomer');
  const mp = groomer.metaPrompt('archive done tasks in bulk');
  assert.match(mp, /archive done tasks in bulk/, 'the rough idea is embedded');
  assert.ok(mp.includes(groomer.SPEC_START) && mp.includes(groomer.SPEC_END), 'spec markers are present');
  assert.match(mp, /"tasks"/, 'asks for the multi-task shape');
});

test('groomer: parseResult recovers task specs from the session output', () => {
  const groomer = require('../server/groomer');

  // Primary path: the { tasks: […] } shape between the sentinels, with prose
  // around it, a per-task ready flag, and a per-task complexity judgment.
  const sentinel = `Here is my spec.\n${groomer.SPEC_START}\n` +
    '{ "tasks": [' +
    '{ "title": "Add bulk archive", "prompt": "Add a button that archives all Done tasks.", "ready": true, "complexity": "simple" },' +
    '{ "title": "Add undo", "prompt": "Let the user undo the bulk archive.", "complexity": "complex" }' +
    '] }' +
    `\n${groomer.SPEC_END}\nthanks!`;
  assert.deepStrictEqual(groomer.parseResult(sentinel), [
    { title: 'Add bulk archive', prompt: 'Add a button that archives all Done tasks.', ready: true, complexity: 'simple' },
    { title: 'Add undo', prompt: 'Let the user undo the bulk archive.', ready: false, complexity: 'complex' },
  ]);

  // Legacy single-object shape still parses as one task; a missing/invalid
  // complexity defaults to 'standard'.
  const single = `${groomer.SPEC_START}{ "title": "T", "prompt": "P", "complexity": "bogus" }${groomer.SPEC_END}`;
  assert.deepStrictEqual(groomer.parseResult(single), [{ title: 'T', prompt: 'P', ready: false, complexity: 'standard' }]);

  // Fallback: a ```json fenced block when the markers are missing.
  const fenced = 'blah\n```json\n{"tasks":[{"title":"T","prompt":"P","ready":true}]}\n```\n';
  assert.deepStrictEqual(groomer.parseResult(fenced), [{ title: 'T', prompt: 'P', ready: true, complexity: 'standard' }]);

  // No usable prompt → null (never a partial/empty spec).
  assert.strictEqual(groomer.parseResult('no spec here at all'), null);
  assert.strictEqual(groomer.parseResult(`${groomer.SPEC_START}{"tasks":[{"title":"x"}]}${groomer.SPEC_END}`), null,
    'a spec without any prompt is rejected');
  assert.strictEqual(groomer.parseResult(''), null);
  assert.strictEqual(groomer.parseResult(undefined), null);
});

test('models: suggestModel maps complexity to a model within the given backend only', () => {
  const models = require('../server/models');

  // Claude tasks only ever get Claude model names.
  assert.strictEqual(models.suggestModel('claude', 'simple'), 'haiku');
  assert.strictEqual(models.suggestModel('claude', 'standard'), 'sonnet');
  assert.strictEqual(models.suggestModel('claude', 'complex'), 'opus');
  assert.strictEqual(models.suggestModel('claude', undefined), 'sonnet', 'missing complexity defaults to standard');

  // Codex tasks only ever get Codex model names — never an Anthropic model,
  // even when the complexity tier is the same.
  assert.strictEqual(models.suggestModel('codex', 'simple'), 'gpt-5.6-luna');
  assert.strictEqual(models.suggestModel('codex', 'standard'), 'gpt-5.6-sol');
  assert.strictEqual(models.suggestModel('codex', 'complex'), 'gpt-5.6-terra');
  assert.strictEqual(models.suggestModel('codex', undefined), 'gpt-5.6-sol', 'missing complexity defaults to standard');

  // Grok's ramp has two rungs: grok-build carries everyday work, grok-4.5 the
  // complex tasks.
  assert.strictEqual(models.suggestModel('grok', 'simple'), 'grok-build');
  assert.strictEqual(models.suggestModel('grok', 'standard'), 'grok-build');
  assert.strictEqual(models.suggestModel('grok', 'complex'), 'grok-4.5');
  assert.strictEqual(models.suggestModel('grok', undefined), 'grok-build', 'missing complexity defaults to standard');

  // An unknown backend still resolves (to the Claude ramp) rather than returning
  // undefined and putting a bogus --model on a real run.
  assert.strictEqual(models.suggestModel('bogus' as never, 'complex'), 'opus', 'an unknown agent falls back to Claude');

  // Never crosses backends: a suggestion only ever names the asked-for backend's models.
  const byAgent: Record<string, string[]> = {
    claude: ['haiku', 'sonnet', 'opus'],
    codex: ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'],
    grok: ['grok-build', 'grok-4.5'],
  };
  for (const [agent, own] of Object.entries(byAgent)) {
    const foreign = Object.entries(byAgent).filter(([a]) => a !== agent).flatMap(([, names]) => names);
    for (const c of ['simple', 'standard', 'complex']) {
      const picked = models.suggestModel(agent, c);
      assert.ok(own.includes(picked), `${agent}/${c} suggests one of its own models`);
      assert.ok(!foreign.includes(picked), `${agent}/${c} never suggests another backend's model`);
    }
  }
});

test('groomer: metaPrompt offers the clarify path alongside the finish path', () => {
  const groomer = require('../server/groomer');
  const mp = groomer.metaPrompt('add a dark mode toggle');
  assert.match(mp, /"questions"/, 'describes the clarify (questions) shape');
  assert.match(mp, /"options"/, 'questions can carry suggested options');
  assert.match(mp, /"allowText"/, 'questions can allow a free-text answer');
});

test('groomer: parseQuestions recovers clarifying questions, else null', () => {
  const groomer = require('../server/groomer');

  const asked = `Let me check.\n${groomer.SPEC_START}\n` +
    '{ "questions": [' +
    '{ "question": "Which theme should default?", "options": ["Light", "Dark"], "allowText": true },' +
    '{ "question": "Any accessibility constraints?", "options": [] }' +
    '] }' +
    `\n${groomer.SPEC_END}`;
  assert.deepStrictEqual(groomer.parseQuestions(asked), [
    { question: 'Which theme should default?', options: ['Light', 'Dark'], allowText: true },
    // options: [] forces allowText true so the question stays answerable.
    { question: 'Any accessibility constraints?', options: [], allowText: true },
  ]);

  // A tasks payload is not a questions payload.
  const tasks = `${groomer.SPEC_START}{ "tasks": [{ "title": "T", "prompt": "P" }] }${groomer.SPEC_END}`;
  assert.strictEqual(groomer.parseQuestions(tasks), null, 'a tasks spec yields no questions');
  // A questions entry without any question text is dropped, leaving nothing.
  assert.strictEqual(
    groomer.parseQuestions(`${groomer.SPEC_START}{"questions":[{"options":["a"]}]}${groomer.SPEC_END}`),
    null,
    'a question without text is rejected',
  );
  assert.strictEqual(groomer.parseQuestions('no spec at all'), null);
  assert.strictEqual(groomer.parseQuestions(''), null);
});

test('groomer: answersPrompt pairs each question with its answer', () => {
  const groomer = require('../server/groomer');
  const questions = [
    { question: 'Which theme should default?', options: ['Light', 'Dark'], allowText: true },
    { question: 'Any accessibility constraints?', options: [], allowText: true },
  ];
  const prompt = groomer.answersPrompt(questions, ['Dark', '']);
  assert.match(prompt, /Which theme should default\?/, 'restates the question');
  assert.match(prompt, /Answer: Dark/, 'includes the given answer');
  assert.match(prompt, /use your best judgment/, 'a blank answer defers to the session');
  assert.ok(prompt.includes(groomer.SPEC_START) && prompt.includes(groomer.SPEC_END), 're-states the spec markers');
});

test('groomer: deriveTitle takes the first non-empty line and caps length', () => {
  const groomer = require('../server/groomer');
  assert.strictEqual(groomer.deriveTitle('\n  make the tray icon animate  \nsecond line'), 'make the tray icon animate');
  assert.strictEqual(groomer.deriveTitle(''), 'Groomed idea');
  const long = groomer.deriveTitle('x'.repeat(200));
  assert.ok(long.length <= 60 && long.endsWith('…'), 'long titles are truncated with an ellipsis');
});

// ---------- autonomous mode engine ----------
//
// These exercise the pure orchestration logic — selection, budget, concurrency,
// double-start, stop — with the dispatch/gh/git boundaries stubbed so no real
// `claude`/`gh`/git process is spawned. The stub dispatch never broadcasts, so
// the bus-driven completion path stays out of these deterministic cases.

// Build a minimally-valid Task for the engine's selection/dispatch logic.
function mkTask(id: string, status: string, repoId: string, extra: Record<string, unknown> = {}) {
  return {
    id, title: id, prompt: 'do it', repoId, repoName: 'R', repoPath: '/tmp/r',
    addons: [], personas: [], attachments: [], autoCodeReview: false, useWorktree: false, worktreePath: null,
    branchName: null, branch: null, model: 'default', permissionMode: 'acceptEdits',
    allowedTools: '', promptPermissions: true, status, sessionId: null, resolvedModel: null,
    costUsd: 0, numTurns: null, durationMs: null, runCount: 0, activeSubagents: 0,
    lastOutcome: null, lastError: null, archived: false, createdAt: '', updatedAt: '',
    startedAt: null, finishedAt: null, ...extra,
  };
}

// Install a fresh set of tasks/settings on the shared store and return a cleanup.
function withStore(tasks: unknown[], maxParallel: number) {
  const store = require('../server/store');
  const prevMax = store.db.settings.maxParallelSessions;
  const prevTasks = store.db.tasks;
  const prevRepos = store.db.repos;
  store.db.settings.maxParallelSessions = maxParallel;
  store.db.tasks = tasks;
  store.db.repos = [{ id: 'repoA', path: '/tmp/r', name: 'RepoA', branch: null, addedAt: '' }];
  return () => {
    store.db.settings.maxParallelSessions = prevMax;
    store.db.tasks = prevTasks;
    store.db.repos = prevRepos;
  };
}

test('autonomous: selection picks only ready, non-archived tasks for the session repo', async () => {
  const autonomous = require('../server/autonomous');
  const tasks = [
    mkTask('a1', 'ready', 'repoA'),
    mkTask('a2', 'ready', 'repoA'),
    mkTask('a3', 'backlog', 'repoA'),
    mkTask('a4', 'ready', 'repoA', { archived: true }),
    mkTask('b1', 'ready', 'repoB'),
  ];
  const restore = withStore(tasks, 10);
  const dispatched: string[] = [];
  autonomous._setDeps({ dispatch: async (t: { id: string; status: string }) => { dispatched.push(t.id); t.status = 'running'; } });
  try {
    const status = await autonomous.start({ repoId: 'repoA', budgetUsd: 100 });
    assert.deepStrictEqual(dispatched.sort(), ['a1', 'a2'], 'only ready, non-archived repoA tasks are dispatched');
    assert.strictEqual(status.active, true, 'session is active with runs in flight');
    assert.strictEqual(status.repoName, 'RepoA', 'status carries the repo name');
    assert.strictEqual(tasks[2].status, 'backlog', 'a backlog task is left untouched');
    assert.strictEqual(tasks[4].status, 'ready', 'the other repo is left untouched');
  } finally {
    autonomous._reset();
    autonomous._setDeps(null);
    restore();
  }
});

test('autonomous: forces the unattended lifecycle config on dispatched tasks', async () => {
  const autonomous = require('../server/autonomous');
  const task = mkTask('c1', 'ready', 'repoA', { addons: [], useWorktree: false, promptPermissions: true });
  const restore = withStore([task], 10);
  autonomous._setDeps({ dispatch: async (t: { status: string }) => { t.status = 'running'; } });
  try {
    await autonomous.start({ repoId: 'repoA', budgetUsd: 100 });
    assert.strictEqual(task.useWorktree, true, 'worktree is forced on');
    assert.strictEqual(task.promptPermissions, false, 'interactive prompting is forced off for unattended runs');
    assert.strictEqual(task.autoCodeReview, true, 'grading is forced on — the engine can only merge graded work');
    assert.deepStrictEqual(task.addons, ['pull_request', 'code_review'], 'lifecycle add-ons are ensured, in catalog order');
    assert.deepStrictEqual(autonomous.REQUIRED_ADDONS, ['pull_request', 'code_review'], 'required add-ons are exported');
  } finally {
    autonomous._reset();
    autonomous._setDeps(null);
    restore();
  }
});

test('autonomous: budget stops picking up new work once spentUsd >= budgetUsd', async () => {
  const autonomous = require('../server/autonomous');
  const tasks = [1, 2, 3, 4, 5].map((n) => mkTask(`t${n}`, 'ready', 'repoA'));
  const restore = withStore(tasks, 10); // cap high so only budget can stop it
  // Each dispatched run "costs" $4; with a $8 budget the loop dispatches exactly
  // two before spent (8) reaches the cap, leaving three ready.
  autonomous._setDeps({
    dispatch: async (t: { status: string; costUsd: number }) => { t.status = 'running'; t.costUsd = 4; },
  });
  try {
    const status = await autonomous.start({ repoId: 'repoA', budgetUsd: 8 });
    assert.strictEqual(status.tasks.length, 2, 'stops after the budget is reached');
    assert.strictEqual(status.spentUsd, 8, 'spent tracks cumulative cost of dispatched tasks');
    assert.strictEqual(tasks.filter((t) => t.status === 'ready').length, 3, 'the rest stay ready');
  } finally {
    autonomous._reset();
    autonomous._setDeps(null);
    restore();
  }
});

test('autonomous: never exceeds the max-parallel concurrency cap', async () => {
  const autonomous = require('../server/autonomous');
  const tasks = [1, 2, 3, 4, 5].map((n) => mkTask(`p${n}`, 'ready', 'repoA'));
  const restore = withStore(tasks, 2); // cap of 2 live children
  let live = 0;
  autonomous._setDeps({
    dispatch: async (t: { status: string }) => { t.status = 'running'; live += 1; },
    runningCount: () => live, // simulate live claude children (none really spawned)
  });
  try {
    const status = await autonomous.start({ repoId: 'repoA', budgetUsd: 1000 });
    assert.strictEqual(status.tasks.length, 2, 'dispatches only up to the cap');
    assert.strictEqual(tasks.filter((t) => t.status === 'ready').length, 3, 'the rest wait for a free slot');
  } finally {
    autonomous._reset();
    autonomous._setDeps(null);
    restore();
  }
});

test('autonomous: rejects a second start while a session is active', async () => {
  const autonomous = require('../server/autonomous');
  const restore = withStore([mkTask('d1', 'ready', 'repoA')], 10);
  autonomous._setDeps({ dispatch: async (t: { status: string }) => { t.status = 'running'; } });
  try {
    await autonomous.start({ repoId: 'repoA', budgetUsd: 100 });
    assert.strictEqual(autonomous.isActive(), true, 'first session is active');
    await assert.rejects(
      () => autonomous.start({ repoId: 'repoA', budgetUsd: 100 }),
      /already running/,
      'a second start is rejected',
    );
  } finally {
    autonomous._reset();
    autonomous._setDeps(null);
    restore();
  }
});

test('autonomous: a session with no ready work stands by instead of ending', async () => {
  const autonomous = require('../server/autonomous');
  const restore = withStore([mkTask('e1', 'backlog', 'repoA')], 10);
  let dispatched = 0;
  autonomous._setDeps({ dispatch: async () => { dispatched += 1; } });
  try {
    const status = await autonomous.start({ repoId: 'repoA', budgetUsd: 100 });
    assert.strictEqual(dispatched, 0, 'nothing to dispatch');
    assert.strictEqual(status.active, true, 'the session stays alive with an empty queue');
    assert.strictEqual(status.reason, 'standby', 'and reports it is standing by');
    assert.strictEqual(autonomous.isActive(), true, 'the session lingers, ready to pick up work');
  } finally {
    autonomous._reset();
    autonomous._setDeps(null);
    restore();
  }
});

test('autonomous: a standing-by session picks up a task the moment it enters ready', async () => {
  const autonomous = require('../server/autonomous');
  const bus = require('../server/bus');
  const task = mkTask('e2', 'backlog', 'repoA');
  const restore = withStore([task], 10);
  const dispatched: string[] = [];
  autonomous._setDeps({ dispatch: async (t: { id: string; status: string }) => { dispatched.push(t.id); t.status = 'running'; } });
  try {
    await autonomous.start({ repoId: 'repoA', budgetUsd: 100 });
    assert.deepStrictEqual(dispatched, [], 'nothing dispatched while the task is still backlog');
    // Move it to ready and announce it exactly as the API route does.
    task.status = 'ready';
    bus.broadcast({ type: 'task', task });
    await new Promise((r) => setImmediate(r)); // let the async pump run
    assert.deepStrictEqual(dispatched, ['e2'], 'the newly-ready task is picked up');
    assert.strictEqual(autonomous.status().active, true, 'the session is still active');
  } finally {
    autonomous._reset();
    autonomous._setDeps(null);
    restore();
  }
});

test('autonomous: stop stops pumping but lets in-flight runs finish', async () => {
  const autonomous = require('../server/autonomous');
  const tasks = [mkTask('s1', 'ready', 'repoA'), mkTask('s2', 'ready', 'repoA')];
  const restore = withStore(tasks, 10);
  autonomous._setDeps({ dispatch: async (t: { status: string }) => { t.status = 'running'; } });
  try {
    await autonomous.start({ repoId: 'repoA', budgetUsd: 100 });
    const stopped = autonomous.stop();
    assert.strictEqual(stopped.stopping, true, 'a user stop marks the session stopping');
    assert.strictEqual(stopped.active, true, 'the session stays active while runs are in flight');
    // Stopping when nothing is left in flight is a no-op that reports idle.
    assert.doesNotThrow(() => autonomous.stop(), 'stop is safe to call again');
  } finally {
    autonomous._reset();
    autonomous._setDeps(null);
    restore();
  }
});

// ---------- autonomous mode: review loop (opt-in) ----------
//
// These drive the bus-driven review loop the way real runs do: the stubbed
// review dispatch only marks the task `running`, and each test broadcasts the
// task's completion itself (mirroring runner.dispatch's terminal event). A
// controllable `headSha` stands in for git so a pass "committing a fix" is just
// the test advancing the sha before it completes the pass.

// Let the engine's async completion handlers (headSha / checkPr / merge) settle.
function tick() {
  return new Promise((r) => setTimeout(r, 5));
}

// A passing Code Review verdict, so a fixture exercises the review/merge loop
// rather than the code-review gate in front of it (which has its own tests).
function passingVerdict(grade = 5) {
  return { grade, summary: 'looks good', blockers: [], commentUrl: null, reviewedAt: '2026-01-01T00:00:00.000Z' };
}

test('autonomous review: re-reviews while a pass commits fixes, then merges when clean', async () => {
  const autonomous = require('../server/autonomous');
  const bus = require('../server/bus');
  const review = mkTask('rv1', 'validation', 'repoA', { sessionId: 'sess-rv1', worktreePath: '/tmp/wt/rv1', codeReview: passingVerdict() });
  const restore = withStore([review], 10);

  let sha = 'sha0';
  const passes: string[] = [];
  let merged = 0;
  let removed = 0;
  autonomous._setDeps({
    headSha: async () => sha,
    reviewDispatch: async (t: { id: string; status: string }) => { passes.push(t.id); t.status = 'running'; },
    checkPr: async () => ({ status: 'green', pr: { number: 1 } }),
    merge: async () => { merged += 1; return { ok: true }; },
    removeWorktree: async () => { removed += 1; },
  });

  // Complete an in-flight review pass, optionally advancing HEAD first (a "fix").
  async function completePass(newSha?: string) {
    if (newSha) sha = newSha; // the pass committed a change
    review.status = 'validation';
    bus.broadcast({ type: 'task', task: review });
    await tick();
  }

  try {
    await autonomous.start({ repoId: 'repoA', budgetUsd: 100, reviewMode: true });
    assert.strictEqual(passes.length, 1, 'the parked review task is picked up for a first review pass');
    assert.strictEqual(review.status, 'running', 'the pass bounced it back to running');

    await completePass('sha1'); // pass 1 committed a fix → HEAD advanced → review again
    assert.strictEqual(passes.length, 2, 'a committed fix triggers another review pass');

    await completePass(); // pass 2 made no change → clean → merge
    assert.strictEqual(merged, 1, 'a clean pass merges the PR exactly once');
    assert.strictEqual(removed, 1, 'the worktree is dropped after the merge');
    assert.strictEqual(review.status, 'done', 'the task lands in done');
    assert.strictEqual(review.worktreePath, null, 'the worktree path is cleared');
    assert.strictEqual(autonomous.isActive(), true, 'the session stands by after the work is finished');
    assert.strictEqual(autonomous.status().reason, 'standby', 'and reports it is standing by');
  } finally {
    autonomous._reset();
    autonomous._setDeps(null);
    restore();
  }
});

test('autonomous review: a clean first pass merges without any extra rounds', async () => {
  const autonomous = require('../server/autonomous');
  const bus = require('../server/bus');
  const review = mkTask('rv2', 'validation', 'repoA', { sessionId: 'sess-rv2', worktreePath: '/tmp/wt/rv2', codeReview: passingVerdict() });
  const restore = withStore([review], 10);

  let merged = 0;
  const passes: string[] = [];
  autonomous._setDeps({
    headSha: async () => 'stable', // never advances → no fixes were needed
    reviewDispatch: async (t: { id: string; status: string }) => { passes.push(t.id); t.status = 'running'; },
    checkPr: async () => ({ status: 'green', pr: { number: 2 } }),
    merge: async () => { merged += 1; return { ok: true }; },
    removeWorktree: async () => {},
  });

  try {
    await autonomous.start({ repoId: 'repoA', budgetUsd: 100, reviewMode: true });
    review.status = 'validation';
    bus.broadcast({ type: 'task', task: review });
    await tick();
    assert.strictEqual(passes.length, 1, 'exactly one review pass runs when nothing changes');
    assert.strictEqual(merged, 1, 'a clean pass merges straight away');
    assert.strictEqual(review.status, 'done', 'the task is finished');
  } finally {
    autonomous._reset();
    autonomous._setDeps(null);
    restore();
  }
});

test('autonomous review: a non-green PR is left in review for the human, not merged', async () => {
  const autonomous = require('../server/autonomous');
  const bus = require('../server/bus');
  const review = mkTask('rv3', 'validation', 'repoA', { sessionId: 'sess-rv3', worktreePath: '/tmp/wt/rv3', codeReview: passingVerdict() });
  const restore = withStore([review], 10);

  let merged = 0;
  autonomous._setDeps({
    headSha: async () => 'stable',
    reviewDispatch: async (t: { status: string }) => { t.status = 'running'; },
    checkPr: async () => ({ status: 'failing', pr: { number: 3 } }),
    merge: async () => { merged += 1; return { ok: true }; },
    removeWorktree: async () => {},
  });

  try {
    const started = await autonomous.start({ repoId: 'repoA', budgetUsd: 100, reviewMode: true });
    assert.strictEqual(started.reviewMode, true, 'status reports review mode is on');
    review.status = 'validation';
    bus.broadcast({ type: 'task', task: review });
    await tick();
    assert.strictEqual(merged, 0, 'a failing PR is never merged');
    assert.strictEqual(review.status, 'validation', 'the task is left in validation for the human');
    assert.strictEqual(autonomous.isActive(), true, 'the session stands by (it settled the task, nothing left to do)');
  } finally {
    autonomous._reset();
    autonomous._setDeps(null);
    restore();
  }
});

test('autonomous review: the per-task round cap stops an endless fix loop and forces a merge', async () => {
  const autonomous = require('../server/autonomous');
  const bus = require('../server/bus');
  const review = mkTask('rv4', 'validation', 'repoA', { sessionId: 'sess-rv4', worktreePath: '/tmp/wt/rv4', codeReview: passingVerdict() });
  const restore = withStore([review], 10);

  let sha = 0;
  let merged = 0;
  const passes: string[] = [];
  autonomous._setDeps({
    headSha: async () => `sha${sha}`,
    reviewDispatch: async (t: { id: string; status: string }) => { passes.push(t.id); t.status = 'running'; },
    checkPr: async () => ({ status: 'green', pr: { number: 4 } }),
    merge: async () => { merged += 1; return { ok: true }; },
    removeWorktree: async () => {},
  });

  try {
    await autonomous.start({ repoId: 'repoA', budgetUsd: 100, reviewMode: true });
    // Every pass "commits" (advances HEAD), so it would loop forever without the cap.
    // Complete each in-flight pass until the cap forces a merge (done), bounded so a
    // regression that never converges fails the test instead of hanging.
    for (let i = 0; i < 6 && review.status !== 'done'; i += 1) {
      sha += 1;
      review.status = 'validation';
      bus.broadcast({ type: 'task', task: review });
      await tick();
    }
    assert.strictEqual(passes.length, autonomous.MAX_REVIEW_ROUNDS, 'the loop is capped at MAX_REVIEW_ROUNDS passes');
    assert.strictEqual(merged, 1, 'once capped it falls through to a single merge');
    assert.strictEqual(review.status, 'done', 'the task is finished rather than looping');
  } finally {
    autonomous._reset();
    autonomous._setDeps(null);
    restore();
  }
});

// ---------- Code Review: the stage between a finished run and validation ----------

test('store: a task persisted with the legacy "review" status migrates to "validation"', () => {
  const store = require('../server/store');
  // The same migration the boot loop applies to every task in db.json.
  const legacy = mkTask('legacy-1', 'review', 'repoA') as unknown as { status: string; agent?: string };
  store.migrateTask(legacy);
  assert.strictEqual(legacy.status, 'validation', 'the legacy review column is what validation is now');
  assert.strictEqual(legacy.agent, 'claude', 'and the older-schema backfills still run');

  // An orphaned code review is not a failed task — the implementation succeeded.
  const orphan = mkTask('legacy-2', 'code_review', 'repoA') as unknown as { status: string; lastOutcome: string };
  store.migrateTask(orphan);
  assert.strictEqual(orphan.status, 'validation', 'a dead code-review run parks in validation');
  assert.strictEqual(orphan.lastOutcome, 'review-error', 'with the reason recorded');

  // A running task is still failed on boot, exactly as before.
  const running = mkTask('legacy-3', 'running', 'repoA') as unknown as { status: string };
  store.migrateTask(running);
  assert.strictEqual(running.status, 'failed', 'an orphaned run still fails');

  assert.strictEqual(store.DEFAULT_SETTINGS.minMergeGrade, 4, 'the merge-grade gate defaults to 4');
  assert.strictEqual(store.db.settings.minMergeGrade, 4, 'and is backfilled onto older db.json files');
});

test('index: PATCH /api/tasks/:id refuses the runner-owned code_review status but accepts validation', async () => {
  const store = require('../server/store');
  const index = require('../server/index');
  const repo = { id: store.id(), path: '/tmp/cr-repo', name: 'cr/repo', branch: null, addedAt: store.now() };
  store.db.repos.push(repo);
  const { server, port } = await index.start(0);
  const base = `http://127.0.0.1:${port}`;
  const patch = (id: string, body: unknown) => fetch(`${base}/api/tasks/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const created = await (await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoId: repo.id, title: 'grade me', prompt: 'do it' }),
    })).json();

    let res = await patch(created.id, { status: 'code_review' });
    assert.strictEqual(res.status, 400, 'code_review is runner-owned, like running');
    assert.match((await res.json()).error, /\/code-review/, 'and the error points at the endpoint that starts it');
    assert.strictEqual(store.getTask(created.id).status, 'backlog', 'the task is untouched');

    res = await patch(created.id, { status: 'validation' });
    assert.strictEqual(res.status, 200, 'validation is still settable by hand');
    assert.strictEqual((await res.json()).status, 'validation');

    // The route that does own it needs an open PR (this task has no branch at all).
    res = await fetch(`${base}/api/tasks/${created.id}/code-review`, { method: 'POST' });
    assert.strictEqual(res.status, 409, 'code review needs a pull request to comment on');
    assert.match((await res.json()).error, /open pull request/);
    assert.strictEqual((await fetch(`${base}/api/tasks/nope/code-review`, { method: 'POST' })).status, 404, 'unknown ids 404');
  } finally {
    store.db.tasks = store.db.tasks.filter((t: { repoId: string }) => t.repoId !== repo.id);
    store.db.repos.splice(store.db.repos.indexOf(repo), 1);
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('tasks: the Code Review stage is opt-in per task, off by default, and PATCH toggles it', async () => {
  const store = require('../server/store');
  const tasks = require('../server/tasks');
  const index = require('../server/index');
  const repo = { id: store.id(), path: '/tmp/acr-repo', name: 'acr/repo', branch: null, addedAt: store.now() };
  store.db.repos.push(repo);
  const { server, port } = await index.start(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const off = tasks.createTask({ repoId: repo.id, title: 'plain', prompt: 'p' });
    assert.strictEqual(off.autoCodeReview, false, 'a task is NOT graded automatically unless configured');

    const on = tasks.createTask({ repoId: repo.id, title: 'graded', prompt: 'p', autoCodeReview: true });
    assert.strictEqual(on.autoCodeReview, true, 'and honors the opt-in at creation');

    const patched = await (await fetch(`${base}/api/tasks/${off.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoCodeReview: true }),
    })).json();
    assert.strictEqual(patched.autoCodeReview, true, 'the flag is editable after creation');
  } finally {
    store.db.tasks = store.db.tasks.filter((t: { repoId: string }) => t.repoId !== repo.id);
    store.db.repos.splice(store.db.repos.indexOf(repo), 1);
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('runner: maybeCodeReview only looks for a PR when the task opted in', () => {
  const store = require('../server/store');
  const runner = require('../server/runner');
  // A cwd that can't exist makes the `gh` lookup fail immediately (same trick the
  // pr-refresh cases use), so the opted-in path is deterministic and spawns nothing.
  const extra = { branch: 'srpopo/x', repoPath: '/tmp/srpopo-test-does-not-exist' };
  const off = mkTask('mcr-off', 'validation', 'repoA', extra);
  const on = mkTask('mcr-on', 'validation', 'repoA', { ...extra, autoCodeReview: true });
  const restore = withStore([off, on], 10);
  try {
    runner.maybeCodeReview(off);
    assert.strictEqual(store.readLog('mcr-off').length, 0, 'an un-configured task is left alone entirely');
    assert.strictEqual(runner.isRunning('mcr-off'), false, 'and nothing is spawned for it');

    runner.maybeCodeReview(on);
    return new Promise<void>((resolve) => setTimeout(() => {
      const lines = store.readLog('mcr-on') as Array<{ type: string; text?: string }>;
      assert.ok(lines.length > 0, 'the opted-in task does look for its pull request');
      assert.match(String(lines[lines.length - 1].text), /Skipped code review: no open pull request/, 'and says why it skipped');
      assert.strictEqual(on.status, 'validation', 'a task with no open PR stays in validation');
      assert.strictEqual(runner.isRunning('mcr-on'), false, 'no reviewer session was spawned');
      store.removeLog('mcr-on');
      restore();
      resolve();
    }, 200));
  } catch (e) {
    restore();
    throw e;
  }
});

test('reviewer: parseVerdict recovers the sentinel payload, falls back to a fence, and clamps the grade', () => {
  const reviewer = require('../server/reviewer');

  const sentinel = `blah blah\n${reviewer.REVIEW_START}\n` +
    '{ "grade": 4, "summary": "solid", "blockers": ["fix the null check"], "commentUrl": "https://github.com/x/y/pull/1#c" }\n' +
    `${reviewer.REVIEW_END}\ntrailing prose`;
  const v = reviewer.parseVerdict(sentinel);
  assert.strictEqual(v.grade, 4);
  assert.strictEqual(v.summary, 'solid');
  assert.deepStrictEqual(v.blockers, ['fix the null check']);
  assert.strictEqual(v.commentUrl, 'https://github.com/x/y/pull/1#c');

  // No markers, but a fenced payload — recovered rather than losing the review.
  const fenced = reviewer.parseVerdict('here it is\n```json\n{"grade":2,"summary":"needs work"}\n```');
  assert.strictEqual(fenced.grade, 2, 'a ```json fence is the fallback');
  assert.deepStrictEqual(fenced.blockers, [], 'a missing blockers array reads as none');
  assert.strictEqual(fenced.commentUrl, null, 'a missing comment url is null, never undefined');

  // Grade coercion + clamping to 1..5.
  const grade = (raw: string) => {
    const parsed = reviewer.parseVerdict(`${reviewer.REVIEW_START}{"grade":${raw}}${reviewer.REVIEW_END}`);
    return parsed && parsed.grade;
  };
  assert.strictEqual(grade('0'), 1, 'below the scale clamps to 1');
  assert.strictEqual(grade('9'), 5, 'above the scale clamps to 5');
  assert.strictEqual(grade('"3"'), 3, 'a stringified grade is coerced');
  assert.strictEqual(grade('4.6'), 5, 'a fractional grade rounds');
  assert.strictEqual(grade('null'), null, 'no usable grade means no verdict');
  assert.strictEqual(grade('"nope"'), null, 'and neither does a non-numeric one');

  assert.strictEqual(reviewer.parseVerdict('just prose, no json at all'), null, 'garbage parses to null');
  assert.strictEqual(reviewer.parseVerdict(''), null, 'so does an empty turn');
  assert.strictEqual(reviewer.parseVerdict(undefined), null, 'and a missing one, without throwing');

  // The rubric wording is in the prompt verbatim, so the scale is used consistently.
  const prompt = reviewer.metaPrompt(mkTask('pr-task', 'validation', 'repoA', { branch: 'srpopo/x' }), { number: 7, title: 'Add it' });
  for (const g of [1, 2, 3, 4, 5]) {
    assert.ok(prompt.includes(`${g} = ${reviewer.GRADE_MEANINGS[g]}`), `the prompt states grade ${g}'s meaning`);
  }
  assert.ok(prompt.includes('gh pr comment 7'), 'it is told to comment on the right PR');
  assert.ok(prompt.includes(reviewer.REVIEW_START), 'and to close the turn with the sentinel payload');
  assert.ok(!prompt.includes('gh pr edit'), 'the label is the server\'s job, never the reviewer\'s');
});

test('claude adapter: reviewArgs is read-only + gh-comment only, never resumed and never bridged', () => {
  const claude = require('../server/agents/claude');
  const args: string[] = claude.reviewArgs({ model: 'sonnet', agent: 'claude' });
  const allow = args[args.indexOf('--allowedTools') + 1];
  assert.ok(args.includes('-p') && args.includes('stream-json'), 'a headless streaming run like every other session');
  assert.strictEqual(args[args.indexOf('--model') + 1], 'sonnet', 'the task model is used');
  for (const tool of ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git status:*)', 'Bash(gh pr view:*)', 'Bash(gh pr diff:*)', 'Bash(gh pr comment:*)']) {
    assert.ok(allow.split(',').includes(tool), `${tool} is allowed`);
  }
  for (const forbidden of ['Write', 'Edit', 'Bash(gh pr edit:*)', 'Bash(gh label:*)', 'Bash(git commit:*)', 'Bash(git push:*)']) {
    assert.ok(!allow.split(',').includes(forbidden), `${forbidden} is NOT allowed — the run auto-denies it`);
  }
  assert.ok(!args.includes('--resume'), 'a code review is always a fresh, unbiased session');
  assert.ok(!args.includes('--permission-prompt-tool'), 'no interactive bridge — the allow-list is the boundary');
  assert.ok(!args.includes('--mcp-config'), 'and no MCP servers at all');
  // Every task is reviewed by Claude, whatever backend implemented it, so another
  // backend's model name must not leak into `claude --model`.
  assert.ok(!claude.reviewArgs({ model: 'gpt-5.6-sol', agent: 'codex' }).includes('--model'), 'a codex model falls back to the CLI default');
  assert.ok(!claude.reviewArgs({ model: 'grok-build', agent: 'grok' }).includes('--model'), 'a grok model falls back to the CLI default');
  // A Claude task's own model is still honored, including when `agent` predates the field.
  assert.ok(claude.reviewArgs({ model: 'opus', agent: 'claude' }).includes('opus'), 'a claude model is used');
  assert.ok(claude.reviewArgs({ model: 'opus' }).includes('opus'), 'an unset agent is treated as claude');
});

test('reviewer: applyVerdict writes a well-formed codeReview onto the task', () => {
  const reviewer = require('../server/reviewer');
  const task = mkTask('av-1', 'validation', 'repoA') as unknown as { codeReview?: unknown };
  const written = reviewer.applyVerdict(task, { grade: 3, summary: 'ok-ish', blockers: ['a'], commentUrl: null });
  assert.deepStrictEqual(task.codeReview, written, 'the written verdict is returned');
  assert.strictEqual(written.grade, 3);
  assert.strictEqual(written.summary, 'ok-ish');
  assert.deepStrictEqual(written.blockers, ['a']);
  assert.strictEqual(written.commentUrl, null);
  assert.match(written.reviewedAt, /^\d{4}-\d{2}-\d{2}T/, 'stamped with an ISO timestamp');

  // Each pass replaces the previous verdict — it graded a different diff.
  reviewer.applyVerdict(task, { grade: 5, summary: 'clean now', blockers: [], commentUrl: 'https://x/1' });
  assert.strictEqual((task.codeReview as { grade: number }).grade, 5, 'the newer grade wins');
});

test('github: the mergeable grade label is one deterministic name per grade', () => {
  const github = require('../server/github');
  for (const g of [1, 2, 3, 4, 5]) {
    assert.strictEqual(github.mergeableLabel(g), `mergeable/${g}`);
    assert.match(github.MERGEABLE_LABEL_COLORS[g], /^[0-9a-f]{6}$/, 'each grade has a hex color for gh label create');
  }
  assert.deepStrictEqual(
    github.MERGEABLE_LABELS,
    ['mergeable/1', 'mergeable/2', 'mergeable/3', 'mergeable/4', 'mergeable/5'],
    'every grade label is listed so the other four can be removed in one edit',
  );
  assert.strictEqual(github.MERGEABLE_LABELS.length, 5, 'exactly five grades');
});

test('github: setMergeableLabel refuses an out-of-range grade without touching gh', async () => {
  const github = require('../server/github');
  for (const bad of [0, 6, NaN, 'x' as unknown as number]) {
    assert.deepStrictEqual(await github.setMergeableLabel({ branch: 'b' }, bad), { ok: false, reason: 'bad-grade' });
  }
  // A task with no branch can't have a PR, so it short-circuits on the lookup.
  assert.deepStrictEqual(await github.setMergeableLabel({}, 4), { ok: false, reason: 'no-branch' });
});

test('autonomous: the code-review gate merges a passing grade, parks a low one, and reviews an ungraded one once', async () => {
  const autonomous = require('../server/autonomous');
  const bus = require('../server/bus');
  const store = require('../server/store');
  const pass = mkTask('cg1', 'ready', 'repoA', { codeReview: passingVerdict(5) });
  const low = mkTask('cg2', 'ready', 'repoA', { codeReview: passingVerdict(2) });
  // Ungraded on purpose: this is the task the gate has to review before merging.
  const none = mkTask('cg3', 'ready', 'repoA', { codeReview: null }) as ReturnType<typeof mkTask> & { codeReview: unknown };
  const restore = withStore([pass, low, none], 10);
  const prevGrade = store.db.settings.minMergeGrade;
  store.db.settings.minMergeGrade = 4;
  const merged: string[] = [];
  const reviewed: string[] = [];
  autonomous._setDeps({
    dispatch: async (t: { status: string }) => { t.status = 'running'; },
    codeReview: async (t: { id: string; status: string }) => { reviewed.push(t.id); t.status = 'code_review'; },
    checkPr: async () => ({ status: 'green', pr: { number: 1 } }),
    merge: async (t: { id: string }) => { merged.push(t.id); return { ok: true }; },
    removeWorktree: async () => {},
  });
  // Land an owned run the way runner.dispatch's terminal event does.
  async function land(task: { status: string }) {
    task.status = 'validation';
    bus.broadcast({ type: 'task', task });
    await tick();
  }
  try {
    await autonomous.start({ repoId: 'repoA', budgetUsd: 100 });

    await land(pass);
    assert.deepStrictEqual(merged, ['cg1'], 'grade 5 clears the gate and merges');
    assert.strictEqual(pass.status, 'done', 'and the task finishes');
    assert.deepStrictEqual(reviewed, [], 'an already-graded task is never re-reviewed');

    await land(low);
    assert.ok(!merged.includes('cg2'), 'grade 2 is below minMergeGrade, so it is never merged');
    assert.strictEqual(low.status, 'validation', 'it is left for the human to decide');
    assert.strictEqual(autonomous.status().reason, 'left-in-validation:grade-2', 'with the grade in the reason');

    // An ungraded task is reviewed first — and only ever once.
    await land(none);
    assert.deepStrictEqual(reviewed, ['cg3'], 'the ungraded task is handed to a code review');
    assert.ok(!merged.includes('cg3'), 'nothing is merged while that review is in flight');
    assert.strictEqual(none.status, 'code_review', 'the reviewer owns the card meanwhile');

    // The review lands with a passing verdict: the merge decision resumes.
    none.codeReview = passingVerdict(4);
    await land(none);
    assert.deepStrictEqual(reviewed, ['cg3'], 'exactly one code review per task per session');
    assert.ok(merged.includes('cg3'), 'and now it merges');
    assert.strictEqual(none.status, 'done');
  } finally {
    autonomous._reset();
    autonomous._setDeps(null);
    store.db.settings.minMergeGrade = prevGrade;
    restore();
  }
});

test('autonomous: a task still in code_review is in flight — the engine keeps owning it', async () => {
  const autonomous = require('../server/autonomous');
  const bus = require('../server/bus');
  const task = mkTask('cf1', 'ready', 'repoA');
  const restore = withStore([task], 10);
  const merged: string[] = [];
  autonomous._setDeps({
    dispatch: async (t: { status: string }) => { t.status = 'running'; },
    codeReview: async (t: { status: string }) => { t.status = 'code_review'; },
    checkPr: async () => ({ status: 'green', pr: { number: 1 } }),
    merge: async (t: { id: string }) => { merged.push(t.id); return { ok: true }; },
  });
  try {
    await autonomous.start({ repoId: 'repoA', budgetUsd: 100 });
    // The runner's own auto-flow into code review, arriving as a bus event.
    task.status = 'code_review';
    bus.broadcast({ type: 'task', task });
    await tick();
    assert.deepStrictEqual(merged, [], 'a code_review event is not a landing');
    assert.strictEqual(autonomous.status().tasks[0].running, true, 'the engine still owns the run');
  } finally {
    autonomous._reset();
    autonomous._setDeps(null);
    restore();
  }
});

test('index: GET /api/health probes every agent backend, not just Claude', async () => {
  const index = require('../server/index');
  const prevClaude = process.env.CLAUDE_BIN;
  const prevCodex = process.env.CODEX_BIN;
  const prevGrok = process.env.GROK_BIN;
  const { server, port } = await index.start(0);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    // Every backend is reported (null when a CLI isn't installed on this machine).
    assert.ok('claude' in body, 'the claude backend is reported');
    assert.ok('codex' in body, 'the codex backend is reported');
    assert.ok('grok' in body, 'the grok backend is reported');
    // ok means "at least one backend is available" — a Grok-only install is healthy.
    assert.strictEqual(body.ok, !!(body.claude || body.codex || body.grok), 'ok is true iff some agent CLI answered');
    if (!body.ok) assert.match(body.error, /No agent CLI found/, 'the error names no agent, not just claude');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    if (prevClaude === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prevClaude;
    if (prevCodex === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = prevCodex;
    if (prevGrok === undefined) delete process.env.GROK_BIN; else process.env.GROK_BIN = prevGrok;
  }
});

test('runner: adapterFor selects the backend by task.agent and defaults to claude', () => {
  const runner = require('../server/runner');
  assert.strictEqual(runner.adapterFor('claude').id, 'claude', 'claude selects the Claude adapter');
  assert.strictEqual(runner.adapterFor('codex').id, 'codex', 'codex selects the Codex adapter');
  assert.strictEqual(runner.adapterFor('grok').id, 'grok', 'grok selects the Grok adapter');
  assert.strictEqual(runner.adapterFor(undefined).id, 'claude', 'an unset agent falls back to claude');
  assert.strictEqual(runner.adapterFor('bogus').id, 'claude', 'an unknown agent falls back to claude');
});

test('tasks: createTask defaults agent to claude and accepts codex and grok', () => {
  const store = require('../server/store');
  const tasks = require('../server/tasks');
  const repo = { id: store.id(), path: '/tmp/agent-repo', name: 'o/agent', branch: null, addedAt: store.now() };
  store.db.repos.push(repo);

  const def = tasks.createTask({ repoId: repo.id, title: 'Default agent', prompt: 'do it' });
  assert.strictEqual(def.agent, 'claude', 'agent defaults to claude');

  const cdx = tasks.createTask({ repoId: repo.id, title: 'Codex agent', prompt: 'do it', agent: 'codex' });
  assert.strictEqual(cdx.agent, 'codex', 'a codex agent is kept');

  const grk = tasks.createTask({ repoId: repo.id, title: 'Grok agent', prompt: 'do it', agent: 'grok' });
  assert.strictEqual(grk.agent, 'grok', 'a grok agent is kept');

  const bad = tasks.createTask({ repoId: repo.id, title: 'Bad agent', prompt: 'do it', agent: 'gpt' });
  assert.strictEqual(bad.agent, 'claude', 'an unknown agent is sanitized to claude');

  // isAgent is what PATCH /api/tasks/:id gates on, so it must agree with createTask.
  assert.ok(tasks.isAgent('grok') && tasks.isAgent('codex') && tasks.isAgent('claude'));
  assert.ok(!tasks.isAgent('gpt') && !tasks.isAgent(undefined), 'unknown backends are rejected, not defaulted');
});

test('tasks: createTask derives a title from the prompt when none is given', () => {
  const store = require('../server/store');
  const tasks = require('../server/tasks');
  const repo = { id: store.id(), path: '/tmp/title-repo', name: 'o/title', branch: null, addedAt: store.now() };
  store.db.repos.push(repo);

  const noTitle = tasks.createTask({ repoId: repo.id, prompt: 'Add a dark mode toggle\nsome more detail' });
  assert.strictEqual(noTitle.title, 'Add a dark mode toggle', 'first non-blank line of the prompt, no LLM involved');

  const blankTitle = tasks.createTask({ repoId: repo.id, title: '   ', prompt: 'Fix the flaky test' });
  assert.strictEqual(blankTitle.title, 'Fix the flaky test', 'a whitespace-only title is treated as absent');

  const kept = tasks.createTask({ repoId: repo.id, title: 'Custom label', prompt: 'Fix the flaky test' });
  assert.strictEqual(kept.title, 'Custom label', 'an explicit title is kept as-is');

  const long = tasks.createTask({ repoId: repo.id, prompt: 'x'.repeat(80) });
  assert.ok(long.title.length <= 60 && long.title.endsWith('…'), 'a long derived title is truncated with an ellipsis');

  assert.throws(() => tasks.createTask({ repoId: repo.id, title: 'Only a title' }), /required/, 'prompt is still required');
});

test('agents/codex: buildArgs streams exec --json over stdin, maps sandbox, and resumes', () => {
  const codex = require('../server/agents/codex');

  // Fresh acceptEdits run: workspace-write sandbox, no approvals, prompt on stdin (-).
  const fresh = codex.buildArgs({ permissionMode: 'acceptEdits', model: 'gpt-5.6-sol' }, false);
  assert.deepStrictEqual(
    fresh,
    ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-m', 'gpt-5.6-sol', '-'],
    'fresh run maps acceptEdits to a workspace-write sandbox and reads the prompt from stdin',
  );

  // Plan mode is read-only.
  const plan = codex.buildArgs({ permissionMode: 'plan' }, false);
  assert.ok(plan.includes('read-only') && !plan.includes('workspace-write'), 'plan maps to a read-only sandbox');
  assert.strictEqual(plan[plan.length - 1], '-', 'the prompt is always the trailing stdin marker');

  // Bypass is the single all-or-nothing flag, with no sandbox flag.
  const bypass = codex.buildArgs({ permissionMode: 'bypassPermissions' }, false);
  assert.ok(bypass.includes('--dangerously-bypass-approvals-and-sandbox'), 'bypass uses the combined danger flag');
  assert.ok(!bypass.includes('--sandbox'), 'no sandbox flag under bypass');

  // Resume is the `exec resume <id>` subcommand; it never re-passes --sandbox
  // (the CLI rejects it — the follow-up keeps the original session's sandbox).
  const resume = codex.buildArgs({ sessionId: 'sess-uuid', permissionMode: 'acceptEdits' }, true);
  assert.deepStrictEqual(
    resume,
    ['exec', 'resume', 'sess-uuid', '--json', '--skip-git-repo-check', '-'],
    'resume maps onto codex exec resume <id> and reads the prompt from stdin',
  );

  // No model selected → no -m flag (account default).
  assert.ok(!codex.buildArgs({ permissionMode: 'acceptEdits' }, false).includes('-m'), 'default model omits -m');
});

test('agents/codex: groomArgs is a read-only sandbox with no approvals', () => {
  const codex = require('../server/agents/codex');
  const args = codex.groomArgs({ model: 'default' });
  assert.ok(args.includes('--sandbox') && args.includes('read-only'), 'grooming runs read-only');
  assert.strictEqual(args[args.length - 1], '-', 'the grooming prompt is read from stdin');
});

test('agents/codex: childEnv strips OPENAI_API_KEY and the nested-session markers', () => {
  const codex = require('../server/agents/codex');
  const prevKey = process.env.OPENAI_API_KEY;
  const prevNested = process.env.CLAUDECODE;
  process.env.OPENAI_API_KEY = 'sk-openai-leak';
  process.env.CLAUDECODE = '1';
  try {
    const env = codex.childEnv('gpt-5.6-sol');
    assert.ok(!('OPENAI_API_KEY' in env), 'subscription-only: the OpenAI key never reaches a codex run');
    assert.ok(!('CLAUDECODE' in env), 'nested-session marker stripped');
    assert.ok(!('CLAUDE_CODE_ENTRYPOINT' in env), 'nested-session entrypoint stripped');
  } finally {
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
    if (prevNested === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = prevNested;
  }
});

test('agents/codex: parseLine normalizes the verified exec --json event schema', () => {
  const codex = require('../server/agents/codex');

  // Blank line → null (nothing to record).
  assert.strictEqual(codex.parseLine('   '), null, 'blank lines are skipped');

  // A non-JSON line is logged verbatim as a raw event, no semantics.
  const raw = codex.parseLine('not json');
  assert.deepStrictEqual(raw.log, { type: 'raw', text: 'not json' }, 'unparsable lines fall back to raw');
  assert.ok(!raw.session && !raw.result, 'raw lines carry no session/result');

  // thread.started → the session id (Codex thread_id), no model on the event.
  const started = codex.parseLine('{"type":"thread.started","thread_id":"019f-uuid"}');
  assert.deepStrictEqual(started.session, { sessionId: '019f-uuid', model: null }, 'thread_id becomes the session id');

  // agent_message / command_execution items are logged only (no result).
  const msg = codex.parseLine('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hello"}}');
  assert.ok(!msg.result && msg.log.type === 'item.completed', 'item events drive no result, but are logged');

  // turn.completed → a successful result; usage maps into the ledger's schema
  // (tokens recorded, cost 0 — Codex subscription runs have no dollar figure).
  const done = codex.parseLine('{"type":"turn.completed","usage":{"input_tokens":13005,"cached_input_tokens":9984,"output_tokens":5,"reasoning_output_tokens":0}}');
  assert.strictEqual(done.result.isError, false, 'turn.completed is a success');
  assert.strictEqual(done.result.costUsd, 0, 'no dollar cost on a subscription run');
  const u = done.result.usageEvent as { usage: Record<string, number>; total_cost_usd: number };
  assert.strictEqual(u.total_cost_usd, 0, 'the usage event carries a zero cost');
  assert.strictEqual(u.usage.input_tokens, 13005, 'input tokens flow through');
  assert.strictEqual(u.usage.output_tokens, 5, 'output tokens flow through');
  assert.strictEqual(u.usage.cache_read_input_tokens, 9984, 'cached_input_tokens maps to cache_read_input_tokens');

  // turn.failed → an error result with the CLI's message as the reason.
  const failed = codex.parseLine('{"type":"turn.failed","error":{"message":"model not supported"}}');
  assert.strictEqual(failed.result.isError, true, 'turn.failed is an error');
  assert.strictEqual(failed.result.errorReason, 'model not supported', 'the failure reason is surfaced');

  // A top-level error event is also a failure result...
  const errored = codex.parseLine('{"type":"error","message":"boom"}');
  assert.strictEqual(errored.result.isError, true, 'a top-level error is a failure');
  assert.strictEqual(errored.result.errorReason, 'boom');

  // ...but a non-fatal item-level error (e.g. a model-metadata note) is not.
  const note = codex.parseLine('{"type":"item.completed","item":{"id":"item_0","type":"error","message":"metadata note"}}');
  assert.ok(!note.result, 'a non-fatal item error does not fail the run');
});

test('agents/grok: buildArgs streams NDJSON, maps every permission mode, and resumes', () => {
  const grok = require('../server/agents/grok');

  // Fresh acceptEdits run: streaming NDJSON, the model, the mode passed straight
  // through, and the safe package-manager defaults as one --allow per rule.
  const fresh = grok.buildArgs({ permissionMode: 'acceptEdits', model: 'grok-build' }, false);
  assert.deepStrictEqual(
    fresh,
    [
      '--output-format', 'streaming-json',
      '-m', 'grok-build',
      '--permission-mode', 'acceptEdits',
      '--allow', 'Bash(npm:*)', '--allow', 'Bash(pnpm:*)', '--allow', 'Bash(yarn:*)',
    ],
    'a fresh run streams streaming-json with the mode and one --allow per rule',
  );
  // The prompt is NOT in buildArgs — Grok's headless mode ignores stdin, so it
  // arrives via promptArgs (see below), not as an argument built here.
  assert.ok(!fresh.includes('-p') && !fresh.includes('--prompt-file'), 'buildArgs carries no prompt');

  // Sr. Popo's 'default' means "ask", and a headless run has nobody to ask — it
  // maps onto dontAsk, which DENIES rather than prompting (what `claude -p` does).
  const ask = grok.buildArgs({ permissionMode: 'default' }, false);
  assert.ok(ask.includes('dontAsk') && !ask.includes('default'), "'default' becomes dontAsk, never a hanging prompt");
  assert.deepStrictEqual(grok.permissionArgs(undefined, false), ['--permission-mode', 'dontAsk'], 'an unset mode is dontAsk too');

  // Plan mode is backed by the kernel-enforced read-only sandbox, not the mode alone.
  const plan = grok.buildArgs({ permissionMode: 'plan' }, false);
  assert.ok(plan.includes('--permission-mode') && plan.includes('plan'), 'plan passes the mode through');
  assert.deepStrictEqual(plan.slice(plan.indexOf('--sandbox'), plan.indexOf('--sandbox') + 2), ['--sandbox', 'read-only'], 'plan adds a read-only sandbox');

  // Bypass is the always-approve mode, and gets no sandbox.
  const bypass = grok.buildArgs({ permissionMode: 'bypassPermissions' }, false);
  assert.ok(bypass.includes('bypassPermissions'), 'bypass passes the mode through');
  assert.ok(!bypass.includes('--sandbox'), 'no sandbox flag under bypass');

  // Resume appends --resume <id> and must NEVER re-pass --sandbox: Grok pins a
  // session's profile at creation and refuses a resume that passes a different one.
  const resume = grok.buildArgs({ sessionId: 'sess-uuid', permissionMode: 'plan' }, true);
  assert.deepStrictEqual(resume.slice(-2), ['--resume', 'sess-uuid'], 'resume names the session');
  assert.ok(!resume.includes('--sandbox'), 'a resume reuses the session\'s saved sandbox profile');

  // No model selected → no -m flag (account default).
  assert.ok(!grok.buildArgs({ permissionMode: 'acceptEdits' }, false).includes('-m'), 'default model omits -m');
  assert.ok(!grok.buildArgs({ permissionMode: 'acceptEdits', model: 'default' }, false).includes('-m'), '"default" omits -m');
});

test('agents/grok: allowArgs carries the task allow-list over as one --allow per rule', () => {
  const grok = require('../server/agents/grok');
  // Grok's --allow takes ONE rule per flag and understands Claude's Tool(pattern)
  // syntax, so add-on tools and the user's own patterns port over verbatim. The
  // "open a PR" add-on is what makes this matter: without it a headless run would
  // silently finish without pushing.
  const args = grok.allowArgs({ allowedTools: 'Bash(cargo test:*)', addons: ['pull_request'] });
  const rules = args.filter((_: string, i: number) => i % 2 === 1);
  assert.deepStrictEqual(args.filter((_: string, i: number) => i % 2 === 0), rules.map(() => '--allow'), 'every rule gets its own --allow');
  assert.ok(rules.includes('Bash(cargo test:*)'), "the user's own pattern survives, spaces and all");
  assert.ok(rules.includes('Bash(gh:*)') && rules.includes('Bash(git push:*)'), 'the PR add-on\'s tools are allowed');
  assert.ok(rules.includes('Bash(npm:*)'), 'the package-manager defaults are still there');
  assert.strictEqual(new Set(rules).size, rules.length, 'no rule is passed twice');
});

test('agents/grok: the prompt travels in a temp file, since headless Grok ignores stdin', () => {
  const grok = require('../server/agents/grok');
  const fs = require('fs');
  const os = require('os');

  const prompt = 'Fix the flaky test.\n\nIt fails on CI only.';
  const delivered = grok.promptArgs(prompt);
  assert.strictEqual(delivered.args[0], '--prompt-file', 'the prompt is passed as a file, not inline with -p');
  const file = delivered.args[1];

  // In the OS temp dir, never in the repo — a prompt file inside the worktree
  // would show up in the task's own diff.
  assert.ok(file.startsWith(fs.realpathSync(os.tmpdir())) || file.startsWith(os.tmpdir()), 'written to the temp dir');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), prompt, 'the prompt round-trips verbatim');
  // 0600: a prompt is the user's task content in a possibly world-readable dir.
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'readable only by this user');

  // Two runs never share a file (concurrent sessions are the normal case here).
  const other = grok.promptArgs(prompt);
  assert.notStrictEqual(other.args[1], file, 'each run gets its own file');

  delivered.cleanup();
  other.cleanup();
  assert.ok(!fs.existsSync(file), 'cleanup deletes the temp prompt file');
  // The runner calls cleanup from both the error and exit paths, so it must be safe twice.
  delivered.cleanup();
});

test('agents/grok: groomArgs is read-only research with nothing able to prompt', () => {
  const grok = require('../server/agents/grok');
  const args = grok.groomArgs({ model: 'default', sessionId: null });
  // Grok's --tools takes its INTERNAL tool ids, not Claude's tool names.
  assert.ok(args.includes('--tools') && args.includes('read_file,grep,list_dir'), 'only the read-only research tools');
  assert.ok(args.includes('--sandbox') && args.includes('read-only'), 'grooming runs in a read-only sandbox');
  assert.ok(args.includes('dontAsk'), 'nothing outside that set can prompt — it is denied');
  assert.ok(!args.includes('--prompt-file'), 'the prompt is appended by promptArgs, not here');

  // Resuming keeps the session's own saved sandbox profile (passing a different
  // one is refused by the CLI), so --sandbox is dropped on a resume.
  const resumed = grok.groomArgs({ model: 'default', sessionId: 'g-1' }, true);
  assert.deepStrictEqual(resumed.slice(-2), ['--resume', 'g-1']);
  assert.ok(!resumed.includes('--sandbox'), 'a resumed grooming reuses the saved profile');
});

test('agents/grok: childEnv strips XAI_API_KEY and the nested-session markers', () => {
  const grok = require('../server/agents/grok');
  const prevKey = process.env.XAI_API_KEY;
  const prevNested = process.env.CLAUDECODE;
  process.env.XAI_API_KEY = 'xai-leak';
  process.env.CLAUDECODE = '1';
  try {
    const env = grok.childEnv('grok-build');
    assert.ok(!('XAI_API_KEY' in env), 'subscription-only: the xAI key never reaches a grok run');
    assert.ok(!('CLAUDECODE' in env), 'nested-session marker stripped');
    assert.ok(!('CLAUDE_CODE_ENTRYPOINT' in env), 'nested-session entrypoint stripped');
  } finally {
    if (prevKey === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = prevKey;
    if (prevNested === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = prevNested;
  }
});

test('agents/grok: parseLine normalizes the streaming-json event schema', () => {
  const grok = require('../server/agents/grok');

  // Blank line → null (nothing to record).
  assert.strictEqual(grok.parseLine('  '), null, 'blank lines are skipped');

  // A non-JSON line is logged verbatim as a raw event, no semantics.
  const raw = grok.parseLine('not json');
  assert.deepStrictEqual(raw.log, { type: 'raw', text: 'not json' }, 'unparsable lines fall back to raw');
  assert.ok(!raw.session && !raw.result, 'raw lines carry no session/result');

  // text / thought deltas are logged for the timeline and drive nothing.
  const chunk = grok.parseLine('{"type":"text","data":"Here\'s"}');
  assert.ok(!chunk.result && !chunk.session, 'a response delta is not a result');
  assert.strictEqual(chunk.log.data, "Here's", 'the delta is logged verbatim');
  assert.ok(!grok.parseLine('{"type":"thought","data":"hmm"}').result, 'a reasoning delta is not a result either');

  // `end` is BOTH the session identity and the result — unlike Claude/Codex, Grok
  // reports its session id only here, at the very end of the run.
  const end = grok.parseLine(JSON.stringify({
    type: 'end',
    stopReason: 'EndTurn',
    sessionId: 'abc123',
    num_turns: 7,
    usage: { input_tokens: 7210, cache_read_input_tokens: 41000, output_tokens: 1893, total_tokens: 50103 },
    modelUsage: {
      'grok-build': { inputTokens: 7210, outputTokens: 1893, cacheReadInputTokens: 41000, modelCalls: 7, costUSD: 0.0127 },
      'grok-4.5': { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, modelCalls: 1, costUSD: 0.0001 },
    },
    total_cost_usd: 0.0127,
  }));
  assert.strictEqual(end.result.isError, false, 'end is a success');
  assert.strictEqual(end.session.sessionId, 'abc123', 'the session id comes off the end event');
  // The resolved model is the busiest modelUsage row, so a subagent on another
  // model doesn't get mistaken for the main one.
  assert.strictEqual(end.session.model, 'grok-build', 'the busiest model is reported as resolved');
  assert.strictEqual(end.result.numTurns, 7);
  assert.strictEqual(end.result.durationMs, null, 'Grok reports no duration');
  assert.strictEqual(end.result.costUsd, 0.0127, 'a stamped cost is kept');
  // Grok's spend field names already match server/usage.ts, so the event is handed
  // to the ledger untouched rather than remapped.
  assert.strictEqual(end.result.usageEvent, end.log, 'the end event IS the usage event');

  // A subscription run usually reports tokens with no cost at all. That must read
  // as "unreported" (0 here, "—" in the UI), never as a $0 bill.
  const noCost = grok.parseLine('{"type":"end","sessionId":"s2","num_turns":1,"usage":{"input_tokens":5,"output_tokens":1}}');
  assert.strictEqual(noCost.result.costUsd, 0, 'an absent cost reads as 0');
  assert.strictEqual(noCost.session.model, null, 'no modelUsage → no resolved model claim');

  // error → a failure result carrying the CLI's message (verified live against
  // grok 0.2.114: this is the shape of a not-signed-in run).
  const errored = grok.parseLine('{"type":"error","message":"Not signed in."}');
  assert.strictEqual(errored.result.isError, true, 'an error event fails the run');
  assert.strictEqual(errored.result.errorReason, 'Not signed in.', 'the reason is surfaced to the card');

  // Notices Grok may emit mid-run are logged but terminate nothing.
  for (const type of ['max_turns_reached', 'auto_compact_started', 'auto_compact_completed']) {
    const note = grok.parseLine(JSON.stringify({ type }));
    assert.ok(!note.result, `${type} does not end the run`);
    assert.strictEqual(note.log.type, type, `${type} is logged for the timeline`);
  }
});

// The one piece of the Grok work that isn't a pure function: launch() has to
// deliver the prompt differently per backend. Stubbing child_process.spawn (which
// the CommonJS build resolves through the module object, so a patch takes effect)
// lets us assert the real spawn call without ever starting an agent CLI.
function withSpawnStub() {
  const cp = require('child_process');
  const { EventEmitter } = require('events');
  const { Readable } = require('stream');
  const real = cp.spawn;
  const calls: { bin: string; args: string[]; stdin: string; child: any }[] = [];
  cp.spawn = (bin: string, args: string[]) => {
    const child: any = new EventEmitter();
    let stdin = '';
    const call = { bin, args, get stdin() { return stdin; }, child };
    child.stdout = Readable.from([]);
    child.stderr = Readable.from([]);
    child.stdin = { on() {}, write(chunk: string) { stdin += String(chunk); }, end() {} };
    child.kill = () => {};
    calls.push(call);
    return child;
  };
  return { calls, restore: () => { cp.spawn = real; } };
}

test('runner: a Grok run gets its prompt in a file (not stdin), and the file is cleaned up', () => {
  const runner = require('../server/runner');
  const fs = require('fs');
  const task = mkTask('grok-run-1', 'ready', 'repoA', { agent: 'grok', model: 'grok-build' });
  const restoreStore = withStore([task], 3);
  const { calls, restore } = withSpawnStub();
  try {
    runner.dispatch(task as never, 'PROMPT BODY');
    assert.strictEqual(calls.length, 1, 'exactly one child spawned');
    const { args, stdin, child } = calls[0];

    // Grok's headless mode ignores piped stdin (verified against the real CLI), so
    // the prompt must NOT go there — it travels in the --prompt-file appended after
    // everything buildArgs produced.
    assert.strictEqual(stdin, '', 'nothing is written to a Grok run\'s stdin');
    const at = args.indexOf('--prompt-file');
    assert.ok(at > -1, 'the run carries a --prompt-file');
    assert.strictEqual(at, args.length - 2, 'prompt delivery is appended last');
    const file = args[at + 1];
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'PROMPT BODY', 'the file holds the prompt the runner was given');
    // buildArgs' own flags are still there, ahead of the prompt.
    assert.ok(args.includes('streaming-json') && args.includes('grok-build'));

    // The temp file lives exactly as long as the child does.
    child.emit('exit', 0, null);
    assert.ok(!fs.existsSync(file), 'the prompt file is deleted once the run exits');
  } finally {
    restore();
    restoreStore();
  }
});

test('runner: Claude and Codex runs still get their prompt on stdin, with no prompt file', () => {
  const runner = require('../server/runner');
  for (const agent of ['claude', 'codex']) {
    const task = mkTask(`stdin-run-${agent}`, 'ready', 'repoA', { agent });
    const restoreStore = withStore([task], 3);
    const { calls, restore } = withSpawnStub();
    try {
      runner.dispatch(task as never, 'PROMPT BODY');
      const { args, stdin, child } = calls[0];
      assert.strictEqual(stdin, 'PROMPT BODY', `${agent} still reads the prompt from stdin`);
      assert.ok(!args.includes('--prompt-file'), `${agent} gets no prompt file`);
      child.emit('exit', 0, null);
    } finally {
      restore();
      restoreStore();
    }
  }
});

test('agents/claude: parseLine normalizes init, subagent open/close, and result', () => {
  const claude = require('../server/agents/claude');

  const init = claude.parseLine('{"type":"system","subtype":"init","session_id":"abc","model":"claude-opus-4-8"}');
  assert.deepStrictEqual(init.session, { sessionId: 'abc', model: 'claude-opus-4-8' }, 'init carries session + model');

  // A top-level Task tool_use opens a subagent; a nested one (parent_tool_use_id) does not.
  const open = claude.parseLine('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Task","id":"t1"}]}}');
  assert.deepStrictEqual(open.subagentsOpened, ['t1'], 'a top-level Task opens a subagent');
  const nested = claude.parseLine('{"type":"assistant","parent_tool_use_id":"t1","message":{"content":[{"type":"tool_use","name":"Task","id":"t2"}]}}');
  assert.ok(!nested.subagentsOpened, 'a nested Task does not open a top-level subagent');

  // A tool_result closes it.
  const close = claude.parseLine('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1"}]}}');
  assert.deepStrictEqual(close.subagentsClosed, ['t1'], 'a tool_result is a subagent-close candidate');

  // The result event carries cost/turns/text/isError and passes itself through as the usage event.
  const result = claude.parseLine('{"type":"result","is_error":false,"total_cost_usd":0.05,"num_turns":3,"duration_ms":1200,"result":"done"}');
  assert.strictEqual(result.result.isError, false);
  assert.strictEqual(result.result.costUsd, 0.05);
  assert.strictEqual(result.result.numTurns, 3);
  assert.strictEqual(result.result.text, 'done');
  assert.strictEqual((result.result.usageEvent as { total_cost_usd: number }).total_cost_usd, 0.05, 'the raw result is the usage event');
});

test('store: settings default memory (project memory distillation) to on', () => {
  const store = require('../server/store');
  assert.strictEqual(store.db.settings.memory, true, 'memory defaults on');
  assert.strictEqual(store.DEFAULT_SETTINGS.memory, true, 'memory default is exported');
});

test('memory: read/write round-trips through the per-repo file, atomically and capped at 64 KB', () => {
  const memory = require('../server/memory');
  const fs = require('fs');
  const repoId = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  assert.strictEqual(memory.readMemory(repoId), '', 'missing memory reads back empty');
  assert.deepStrictEqual(memory.memoryInfo(repoId), { content: '', updatedAt: null });

  memory.writeMemory(repoId, '## Conventions\nUse 2-space indent.');
  assert.strictEqual(memory.readMemory(repoId), '## Conventions\nUse 2-space indent.');
  const info = memory.memoryInfo(repoId);
  assert.strictEqual(info.content, '## Conventions\nUse 2-space indent.');
  assert.match(info.updatedAt, /^\d{4}-\d{2}-\d{2}T/, 'updatedAt is an ISO timestamp');

  // Atomic write: no leftover .tmp file once the write completes.
  assert.ok(!fs.existsSync(memory.memoryPath(repoId) + '.tmp'), 'no leftover temp file after a write');

  // Hard-capped at 64 KB even if the caller hands over more.
  memory.writeMemory(repoId, 'x'.repeat(100 * 1024));
  assert.strictEqual(memory.readMemory(repoId).length, 64 * 1024, 'content is capped at 64 KB');

  memory.removeMemory(repoId);
  assert.strictEqual(memory.readMemory(repoId), '', 'removeMemory deletes the file');
});

test('memory: parseDistillResult recovers an update, else null for NO_CHANGES/garbage/failure', () => {
  const memory = require('../server/memory');

  const updated = `Sure.\n${memory.MEMORY_START}\n## Gotchas\nWatch out for X.\n${memory.MEMORY_END}\nthanks!`;
  assert.strictEqual(memory.parseDistillResult(updated), '## Gotchas\nWatch out for X.');

  const noChanges = `${memory.MEMORY_START}\nNO_CHANGES\n${memory.MEMORY_END}`;
  assert.strictEqual(memory.parseDistillResult(noChanges), null, 'NO_CHANGES means leave memory untouched');

  assert.strictEqual(memory.parseDistillResult('no sentinels here at all'), null, 'garbage with no span parses to null');
  assert.strictEqual(memory.parseDistillResult(''), null, 'empty text (a failed session) parses to null');
  assert.strictEqual(memory.parseDistillResult(undefined), null);
});

test('groomer: metaPrompt only appends the "what Sr. Popo remembers" section when memory is non-empty', () => {
  const groomer = require('../server/groomer');

  const withoutMemory = groomer.metaPrompt('add a dark mode toggle');
  assert.ok(!withoutMemory.includes('What Sr. Popo remembers'), 'no memory section when memory is omitted');

  const withoutMemoryBlank = groomer.metaPrompt('add a dark mode toggle', '   ');
  assert.strictEqual(withoutMemoryBlank, withoutMemory, 'a blank memory string leaves the prompt byte-identical');

  const withMemory = groomer.metaPrompt('add a dark mode toggle', '## Conventions\nUse 2-space indent.');
  assert.match(withMemory, /What Sr\. Popo remembers about this project/);
  assert.match(withMemory, /Use 2-space indent\./);
});

test('memory: GET/PUT /api/repos/:id/memory read and write the repo\'s memory file', async () => {
  const http = require('http');
  const { app } = require('../server/index');
  const store = require('../server/store');
  const memory = require('../server/memory');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;

  const repo = { id: store.id(), path: process.cwd(), name: 'memory-test-repo', branch: null, addedAt: store.now() };
  store.db.repos.push(repo);

  try {
    let res = await fetch(`${base}/api/repos/nonexistent/memory`);
    assert.strictEqual(res.status, 404, 'unknown repo -> 404');

    res = await fetch(`${base}/api/repos/${repo.id}/memory`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { content: '', updatedAt: null }, 'no memory yet');

    res = await fetch(`${base}/api/repos/${repo.id}/memory`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 123 }),
    });
    assert.strictEqual(res.status, 400, 'non-string content -> 400');

    res = await fetch(`${base}/api/repos/${repo.id}/memory`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '## Decisions\nUse Haiku for background distillation.' }),
    });
    assert.strictEqual(res.status, 200);
    const saved = await res.json();
    assert.strictEqual(saved.content, '## Decisions\nUse Haiku for background distillation.');
    assert.ok(saved.updatedAt);

    res = await fetch(`${base}/api/repos/${repo.id}/memory`);
    assert.strictEqual((await res.json()).content, '## Decisions\nUse Haiku for background distillation.', 're-reads what was saved');
  } finally {
    store.db.repos.splice(store.db.repos.indexOf(repo), 1);
    memory.removeMemory(repo.id);
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------- goal orchestration ----------

test('orchestrator: metaPrompt briefs the orchestrator, hands over the repo id, and demands a sentinel status', () => {
  const orchestrator = require('../server/orchestrator');
  const prompt = orchestrator.metaPrompt(
    { goal: 'make the board keyboard-navigable', repoId: 'repo-xyz', repoName: 'o/board', mode: 'manual' },
    'Prefers vanilla JS.',
  );
  assert.ok(prompt.includes('make the board keyboard-navigable'), 'the goal is embedded');
  assert.ok(prompt.includes('repo-xyz'), 'the repo id create_task needs is handed over');
  assert.ok(prompt.includes('mcp__board__create_task'), 'the board tools are named');
  assert.ok(prompt.includes('Prefers vanilla JS.'), 'project memory is injected');
  assert.ok(prompt.includes(orchestrator.ORCH_START) && prompt.includes(orchestrator.ORCH_END), 'the status markers are shown');
  assert.ok(prompt.includes('read-only'), 'it is told it may not edit the repo');
  assert.ok(prompt.includes('EXECUTION MODE: manual'), 'manual mode tells it to dispatch its own tasks');
  assert.ok(prompt.includes('mcp__board__dispatch_task'), 'manual mode names the dispatch tool');

  const auto = orchestrator.metaPrompt({ goal: 'g', repoId: 'r', repoName: 'n', mode: 'autonomous' }, '');
  assert.ok(auto.includes('EXECUTION MODE: autonomous hand-off'), 'autonomous mode is stated');
  assert.ok(auto.includes('"ready"') && auto.includes('pull_request'), 'autonomous mode spells out the required task shape');
  assert.ok(auto.includes('must NOT dispatch'), 'autonomous mode forbids self-dispatch');
});

test('orchestrator: parseStatus recovers all four turn states, and rejects anything else', () => {
  const orchestrator = require('../server/orchestrator');
  const wrap = (json: string) => `thinking out loud…\n${orchestrator.ORCH_START}\n${json}\n${orchestrator.ORCH_END}`;

  const waiting = orchestrator.parseStatus(wrap('{ "state": "waiting", "watch": ["a1", "b2", "a1"], "note": "two in flight" }'));
  assert.strictEqual(waiting.state, 'waiting');
  assert.deepStrictEqual(waiting.watch, ['a1', 'b2'], 'watch ids are deduped');
  assert.strictEqual(waiting.note, 'two in flight');

  const question = orchestrator.parseStatus(wrap('{ "state": "question", "note": "SQLite or JSON?" }'));
  assert.deepStrictEqual(question, { state: 'question', watch: [], note: 'SQLite or JSON?' });

  const done = orchestrator.parseStatus(wrap('{ "state": "done", "summary": "shipped 3 tasks" }'));
  assert.deepStrictEqual(done, { state: 'done', watch: [], note: 'shipped 3 tasks' }, 'summary doubles as the note');

  const blocked = orchestrator.parseStatus(wrap('{ "state": "BLOCKED", "note": "no test runner" }'));
  assert.deepStrictEqual(blocked, { state: 'blocked', watch: [], note: 'no test runner' }, 'state is case-insensitive');

  // A non-waiting turn never carries a watch list, even if the model emits one.
  assert.deepStrictEqual(orchestrator.parseStatus(wrap('{ "state": "done", "watch": ["x"] }')).watch, []);

  // Malformed / missing / unknown-state payloads are all "no status this turn".
  assert.strictEqual(orchestrator.parseStatus(wrap('{ "state": "waiting", ')), null, 'unparseable JSON -> null');
  assert.strictEqual(orchestrator.parseStatus(wrap('{ "state": "pondering" }')), null, 'an unknown state -> null');
  assert.strictEqual(orchestrator.parseStatus(wrap('[1,2,3]')), null, 'a non-object payload -> null');
  assert.strictEqual(orchestrator.parseStatus('no markers, no json at all'), null, 'no payload -> null');
  assert.strictEqual(orchestrator.parseStatus(''), null, 'empty text -> null');
  assert.strictEqual(orchestrator.parseStatus(undefined), null, 'no text at all -> null');

  // The last sentinel span wins, so the echoed example in the prompt loses to
  // the real answer.
  const twice = `${orchestrator.ORCH_START}{"state":"waiting","watch":["old"]}${orchestrator.ORCH_END}` +
    `later…${orchestrator.ORCH_START}{"state":"done","summary":"fin"}${orchestrator.ORCH_END}`;
  assert.strictEqual(orchestrator.parseStatus(twice).state, 'done', 'the last span is the answer');
});

test('orchestrator: statusPrompt digests every watched worker and flags ones that vanished', () => {
  const orchestrator = require('../server/orchestrator');
  const tasks = [
    mkTask('w1', 'validation', 'repoA', { title: 'Add the parser', lastOutcome: 'success', branch: 'srpopo/parser', runCount: 1 }),
    mkTask('w2', 'failed', 'repoA', { title: 'Wire the UI', lastOutcome: 'error', lastError: 'tsc: type error in app.ts' }),
  ];
  const prompt = orchestrator.statusPrompt({ watch: ['w1', 'w2', 'gone'], mode: 'manual' }, tasks);
  assert.ok(prompt.includes('w1') && prompt.includes('Add the parser'), 'each watched task is listed');
  assert.ok(prompt.includes('status=validation'), 'its status is reported');
  assert.ok(prompt.includes('tsc: type error in app.ts'), 'a failure reason is carried over');
  assert.ok(prompt.includes('gone'), 'a deleted watched id is called out');
  assert.ok(prompt.includes(orchestrator.ORCH_START), 'the status contract is restated');

  const reply = orchestrator.replyPrompt('SQLite or JSON?', 'JSON, keep it dependency-free', 'manual');
  assert.ok(reply.includes('SQLite or JSON?') && reply.includes('dependency-free'), 'the Q and A are paired');
  assert.ok(orchestrator.nudgePrompt('manual').includes('no task ids to watch'), 'the empty-watch nudge explains itself');
});

test('orchestrator: deriveTitle takes the first non-empty line and caps length', () => {
  const orchestrator = require('../server/orchestrator');
  assert.strictEqual(orchestrator.deriveTitle('\n\n  Ship the new board  \nmore detail'), 'Ship the new board');
  assert.strictEqual(orchestrator.deriveTitle(''), 'Orchestrated goal', 'empty input still gets a title');
  const long = orchestrator.deriveTitle('x'.repeat(200));
  assert.ok(long.length <= 60 && long.endsWith('…'), 'a long goal is truncated with an ellipsis');
});

test('claude adapter: orchestrateArgs allows research + board tools over an http MCP config, never a write tool', () => {
  const claude = require('../server/agents/claude');
  const args: string[] = claude.orchestrateArgs({ model: 'sonnet', sessionId: null }, false);

  assert.deepStrictEqual(args.slice(0, 4), ['-p', '--output-format', 'stream-json', '--verbose'], 'streams like every other session');
  assert.ok(args.includes('--model') && args[args.indexOf('--model') + 1] === 'sonnet', 'the model is passed through');

  const allow = args[args.indexOf('--allowedTools') + 1].split(',');
  for (const t of ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)']) {
    assert.ok(allow.includes(t), `${t} (read-only research) is allowed`);
  }
  for (const t of ['list_repos', 'list_tasks', 'get_task', 'create_task', 'dispatch_task', 'stop_task']) {
    assert.ok(allow.includes(`mcp__board__${t}`), `mcp__board__${t} is allowed`);
  }
  for (const t of ['Write', 'Edit', 'NotebookEdit', 'Bash(npm:*)']) {
    assert.ok(!allow.includes(t), `${t} is never allowed for the orchestrator`);
  }
  assert.ok(!args.includes('--permission-prompt-tool'), 'no interactive permission bridge — unapproved tools just deny');

  // The board MCP server is registered over Streamable HTTP against localhost.
  const cfg = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
  assert.deepStrictEqual(Object.keys(cfg.mcpServers), ['board'], 'registered as "board", distinct from the permission bridge');
  assert.strictEqual(cfg.mcpServers.board.type, 'http', 'uses the http transport');
  assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(cfg.mcpServers.board.url), `points at the local /mcp endpoint (${cfg.mcpServers.board.url})`);

  // Resume threads the session id; a default model adds no --model flag.
  const resumed: string[] = claude.orchestrateArgs({ model: 'default', sessionId: 'sess-1' }, true);
  assert.ok(!resumed.includes('--model'), 'the account default adds no --model');
  assert.strictEqual(resumed[resumed.indexOf('--resume') + 1], 'sess-1', 'resume threads the session id');
  assert.ok(!claude.orchestrateArgs({ model: 'default', sessionId: null }, true).includes('--resume'), 'nothing to resume without a session');
});

// Build a minimally-valid Orchestration for the engine's decision logic.
function mkOrchestration(id: string, status: string, watch: string[], extra: Record<string, unknown> = {}) {
  return {
    id, title: id, goal: 'do the thing', repoId: 'repoA', repoName: 'RepoA', repoPath: '/tmp/r',
    model: 'default', mode: 'manual', status, sessionId: 'sess', resolvedModel: null, costUsd: 0,
    numTurns: null, durationMs: null, runCount: 1, turnCount: 1, activeSubagents: 0,
    lastOutcome: null, lastError: null, note: null, watch, taskIds: [...watch], archived: false,
    createdAt: '', updatedAt: '', startedAt: null, finishedAt: null, ...extra,
  };
}

// Install orchestrations + tasks on the shared store and return a cleanup.
function withOrchestratorStore(orchestrations: unknown[], tasks: unknown[]) {
  const store = require('../server/store');
  const prevOrch = store.db.orchestrations;
  const prevTasks = store.db.tasks;
  store.db.orchestrations = orchestrations;
  store.db.tasks = tasks;
  return () => {
    store.db.orchestrations = prevOrch;
    store.db.tasks = prevTasks;
  };
}

// The orchestrator cases below let the engine's debounce timer (collapsed to ~0ms by
// _setTiming) run with the same `tick()` helper the autonomous cases use.

test('orchestrator: a watched worker landing resumes the orchestrator exactly once, with a status digest', async () => {
  const orchestratorEngine = require('../server/orchestrator-engine');
  const bus = require('../server/bus');
  const orch = mkOrchestration('o1', 'waiting', ['w1', 'w2']);
  const w1 = mkTask('w1', 'running', 'repoA');
  const w2 = mkTask('w2', 'running', 'repoA');
  const restore = withOrchestratorStore([orch], [w1, w2]);
  const resumes: string[] = [];
  orchestratorEngine._setDeps({ resume: (_o: unknown, prompt: string) => { resumes.push(prompt); } });
  orchestratorEngine._setTiming({ debounceMs: 0 });
  try {
    orchestratorEngine.start();
    assert.strictEqual(orchestratorEngine.isWatching('o1'), true, 'a waiting orchestration is armed on boot (restart re-arm)');

    // A worker still running changes nothing.
    bus.broadcast({ type: 'task', task: w1 });
    await tick();
    assert.strictEqual(resumes.length, 0, 'a running worker is not a landing');

    // The first landing wakes it; the second, arriving in the same debounce
    // window, joins that one wake-up rather than queueing a second turn.
    w1.status = 'validation';
    bus.broadcast({ type: 'task', task: w1 });
    w2.status = 'failed';
    bus.broadcast({ type: 'task', task: w2 });
    await tick();
    assert.strictEqual(resumes.length, 1, 'one resume for the batch');
    assert.ok(resumes[0].includes('w1') && resumes[0].includes('w2'), 'the digest covers every watched worker');

    // Re-broadcasting the same landing must not resume again.
    bus.broadcast({ type: 'task', task: w1 });
    await tick();
    assert.strictEqual(resumes.length, 1, 'an already-reported landing is ignored');
  } finally {
    orchestratorEngine._reset();
    restore();
  }
});

test('orchestrator: a worker mid-code-review has not landed, so the orchestrator is not woken', async () => {
  const orchestratorEngine = require('../server/orchestrator-engine');
  const bus = require('../server/bus');
  const orch = mkOrchestration('o-cr', 'waiting', ['wcr']);
  const worker = mkTask('wcr', 'running', 'repoA');
  const restore = withOrchestratorStore([orch], [worker]);
  const resumes: string[] = [];
  orchestratorEngine._setDeps({ resume: (_o: unknown, prompt: string) => { resumes.push(prompt); } });
  orchestratorEngine._setTiming({ debounceMs: 0 });
  try {
    orchestratorEngine.start();
    // The Code Review stage is a live child, not a terminal state — the worker is
    // still in flight and lands in `validation` next.
    worker.status = 'code_review';
    bus.broadcast({ type: 'task', task: worker });
    await tick();
    assert.strictEqual(resumes.length, 0, 'code_review is not terminal, so nothing resumes');

    worker.status = 'validation';
    bus.broadcast({ type: 'task', task: worker });
    await tick();
    assert.strictEqual(resumes.length, 1, 'the validation landing is what wakes the orchestrator');
  } finally {
    orchestratorEngine._reset();
    restore();
  }
});

test('orchestrator: only the orchestration watching a task reacts to it', async () => {
  const orchestratorEngine = require('../server/orchestrator-engine');
  const bus = require('../server/bus');
  const mine = mkOrchestration('o-mine', 'waiting', ['t-mine']);
  const other = mkOrchestration('o-other', 'waiting', ['t-other']);
  const draft = mkOrchestration('o-draft', 'draft', ['t-mine']);
  const task = mkTask('t-mine', 'validation', 'repoA');
  const restore = withOrchestratorStore([mine, other, draft], [task, mkTask('t-other', 'ready', 'repoA')]);
  const resumed: string[] = [];
  orchestratorEngine._setDeps({ resume: (o: { id: string }) => { resumed.push(o.id); } });
  orchestratorEngine._setTiming({ debounceMs: 0 });
  try {
    orchestratorEngine.start();
    assert.strictEqual(orchestratorEngine.isWatching('o-draft'), false, 'a draft orchestration is never armed');
    bus.broadcast({ type: 'task', task });
    await tick();
    assert.deepStrictEqual(resumed, ['o-mine'], 'only the watcher of that task resumes');
  } finally {
    orchestratorEngine._reset();
    restore();
  }
});

test('orchestrator: never resumes a session that is already running, and retries once it frees up', async () => {
  const orchestratorEngine = require('../server/orchestrator-engine');
  const bus = require('../server/bus');
  const orch = mkOrchestration('o2', 'waiting', ['w3']);
  const task = mkTask('w3', 'validation', 'repoA');
  const restore = withOrchestratorStore([orch], [task]);
  let live = true;
  const resumed: string[] = [];
  orchestratorEngine._setDeps({
    resume: (o: { id: string }) => { resumed.push(o.id); },
    isRunning: () => live,
  });
  orchestratorEngine._setTiming({ debounceMs: 0, retryMs: 0 });
  try {
    orchestratorEngine.start();
    bus.broadcast({ type: 'task', task });
    await tick();
    assert.deepStrictEqual(resumed, [], 'no second turn while the session is live');
    live = false;
    await tick();
    assert.deepStrictEqual(resumed, ['o2'], 'the queued wake-up fires once the session frees up');
  } finally {
    orchestratorEngine._reset();
    restore();
  }
});

test('orchestrator: waits for a free session slot instead of blowing past the parallel cap', async () => {
  const orchestratorEngine = require('../server/orchestrator-engine');
  const bus = require('../server/bus');
  const orch = mkOrchestration('o3', 'waiting', ['w4']);
  const task = mkTask('w4', 'done', 'repoA');
  const restore = withOrchestratorStore([orch], [task]);
  let full = true;
  const resumed: string[] = [];
  orchestratorEngine._setDeps({ resume: (o: { id: string }) => { resumed.push(o.id); }, atCapacity: () => full });
  orchestratorEngine._setTiming({ debounceMs: 0, retryMs: 0 });
  try {
    orchestratorEngine.start();
    bus.broadcast({ type: 'task', task });
    await tick();
    assert.deepStrictEqual(resumed, [], 'held back while every session slot is busy');
    full = false;
    await tick();
    assert.deepStrictEqual(resumed, ['o3'], 'resumes once a slot frees up');
  } finally {
    orchestratorEngine._reset();
    restore();
  }
});

test('orchestrator: the turn cap fails the card instead of looping forever', async () => {
  const orchestratorEngine = require('../server/orchestrator-engine');
  const bus = require('../server/bus');
  const orch = mkOrchestration('o4', 'waiting', ['w5'], { turnCount: orchestratorEngine.MAX_TURNS });
  const task = mkTask('w5', 'validation', 'repoA');
  const restore = withOrchestratorStore([orch], [task]);
  const resumed: string[] = [];
  orchestratorEngine._setDeps({ resume: (o: { id: string }) => { resumed.push(o.id); } });
  orchestratorEngine._setTiming({ debounceMs: 0 });
  try {
    orchestratorEngine.start();
    bus.broadcast({ type: 'task', task });
    await tick();
    assert.deepStrictEqual(resumed, [], 'no further turn is started');
    assert.strictEqual(orch.status, 'failed', 'the card is failed');
    assert.match(String(orch.lastError), new RegExp(`${orchestratorEngine.MAX_TURNS} orchestrator turns`), 'and says why');
    assert.strictEqual(orch.sessionId, null, 'the exhausted session is dropped');
    assert.strictEqual(orchestratorEngine.isWatching('o4'), false, 'the watchers are disarmed');
  } finally {
    orchestratorEngine._reset();
    restore();
  }
});

test('orchestrator: a turn ending as waiting re-arms; question/done/failed and archive disarm', async () => {
  const orchestratorEngine = require('../server/orchestrator-engine');
  const bus = require('../server/bus');
  const orch = mkOrchestration('o5', 'running', []);
  const restore = withOrchestratorStore([orch], []);
  orchestratorEngine._setDeps({ resume: () => {} });
  orchestratorEngine._setTiming({ debounceMs: 0 });
  try {
    orchestratorEngine.start();
    assert.strictEqual(orchestratorEngine.isWatching('o5'), false, 'a running orchestration has nothing to watch');

    orch.status = 'waiting';
    orch.watch = ['w6'];
    bus.broadcast({ type: 'orchestration', orchestration: orch });
    assert.strictEqual(orchestratorEngine.isWatching('o5'), true, 'ending a turn as waiting arms the watchers');

    for (const status of ['awaiting', 'finished', 'failed', 'draft']) {
      orch.status = 'waiting';
      bus.broadcast({ type: 'orchestration', orchestration: orch });
      orch.status = status;
      bus.broadcast({ type: 'orchestration', orchestration: orch });
      assert.strictEqual(orchestratorEngine.isWatching('o5'), false, `${status} disarms the watchers`);
    }

    orch.status = 'waiting';
    bus.broadcast({ type: 'orchestration', orchestration: orch });
    bus.broadcast({ type: 'orchestration-removed', orchestrationId: 'o5' });
    assert.strictEqual(orchestratorEngine.isWatching('o5'), false, 'a removed card is forgotten');
  } finally {
    orchestratorEngine._reset();
    restore();
  }
});

test('orchestrator: a worker that landed while the orchestrator was busy still wakes it on re-arm', async () => {
  const orchestratorEngine = require('../server/orchestrator-engine');
  const bus = require('../server/bus');
  const orch = mkOrchestration('o6', 'running', ['w7']);
  // The worker finished mid-turn, while nothing was armed to notice.
  const task = mkTask('w7', 'validation', 'repoA');
  const restore = withOrchestratorStore([orch], [task]);
  const resumed: string[] = [];
  orchestratorEngine._setDeps({ resume: (o: { id: string }) => { resumed.push(o.id); } });
  orchestratorEngine._setTiming({ debounceMs: 0 });
  try {
    orchestratorEngine.start();
    bus.broadcast({ type: 'task', task }); // lands unnoticed — nothing armed
    await tick();
    assert.deepStrictEqual(resumed, [], 'nothing to notice it yet');
    orch.status = 'waiting';
    bus.broadcast({ type: 'orchestration', orchestration: orch });
    await tick();
    assert.deepStrictEqual(resumed, ['o6'], 'the missed landing is picked up when the watchers re-arm');
  } finally {
    orchestratorEngine._reset();
    restore();
  }
});

test('orchestrator: a waiting turn that watches nothing is nudged rather than stalling forever', async () => {
  const orchestratorEngine = require('../server/orchestrator-engine');
  const bus = require('../server/bus');
  const orchestrator = require('../server/orchestrator');
  const orch = mkOrchestration('o7', 'running', []);
  const restore = withOrchestratorStore([orch], []);
  const prompts: string[] = [];
  orchestratorEngine._setDeps({ resume: (_o: unknown, prompt: string) => { prompts.push(prompt); } });
  orchestratorEngine._setTiming({ debounceMs: 0 });
  try {
    orchestratorEngine.start();
    orch.status = 'waiting';
    orch.watch = [];
    bus.broadcast({ type: 'orchestration', orchestration: orch });
    await tick();
    assert.strictEqual(prompts.length, 1, 'it is resumed immediately');
    assert.strictEqual(prompts[0], orchestrator.nudgePrompt('manual'), 'with the empty-watch nudge');
  } finally {
    orchestratorEngine._reset();
    restore();
  }
});

test('index: orchestration routes are registered, gated on the plugin, and validate their input', async () => {
  const store = require('../server/store');
  const index = require('../server/index');
  const prevPlugins = store.db.settings.installedPlugins;
  const { server, port } = await index.start(0);
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const repo = { id: store.id(), path: '/tmp/orch-repo', name: 'o/orch', branch: null, addedAt: store.now() };
  store.db.repos.push(repo);
  try {
    // Gated: nothing can be created until the plugin is installed.
    store.db.settings.installedPlugins = [];
    let res = await post('/api/orchestrations', { repoId: repo.id, goal: 'x' });
    assert.strictEqual(res.status, 400, 'creation is refused without the plugin');
    assert.match((await res.json()).error, /Goal Orchestration plugin/, 'and says which plugin to install');

    store.db.settings.installedPlugins = ['orchestration'];
    assert.strictEqual((await post('/api/orchestrations', { repoId: repo.id, run: false })).status, 400, 'a goal is required');
    assert.strictEqual((await post('/api/orchestrations', { repoId: 'nope', goal: 'x', run: false })).status, 400, 'the repo must exist');

    // A draft is created without spawning anything.
    res = await post('/api/orchestrations', { repoId: repo.id, goal: 'Ship the thing', model: 'sonnet', run: false });
    assert.strictEqual(res.status, 200);
    const orch = await res.json();
    assert.strictEqual(orch.status, 'draft', 'created parked as a draft');
    assert.strictEqual(orch.title, 'Ship the thing', 'titled from the goal');
    assert.deepStrictEqual([orch.watch, orch.taskIds, orch.turnCount], [[], [], 0], 'starts with a clean slate');

    // It shows up in the board state.
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.ok(state.orchestrations.some((o: { id: string }) => o.id === orch.id), 'non-archived orchestrations are in /api/state');

    // Edits, and the guards around the resumable states.
    res = await fetch(`${base}/api/orchestrations/${orch.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal: 'Ship it better' }),
    });
    assert.strictEqual((await res.json()).title, 'Ship it better', 'editing a draft retitles it');
    assert.strictEqual((await post(`/api/orchestrations/${orch.id}/reply`, { reply: 'yes' })).status, 409, 'a draft is not awaiting an answer');
    assert.strictEqual((await post(`/api/orchestrations/${orch.id}/stop`, {})).status, 409, 'a draft is not running');
    assert.strictEqual((await post('/api/orchestrations/nope/run', {})).status, 404, 'unknown ids 404');

    // A waiting card stops by parking, without a live process to kill.
    const waiting = store.getOrchestration(orch.id);
    waiting.status = 'waiting';
    waiting.watch = ['w1'];
    assert.strictEqual((await post(`/api/orchestrations/${orch.id}/stop`, {})).status, 200, 'a waiting card can be stopped');
    assert.strictEqual(waiting.status, 'draft', 'and is parked back in draft');
    assert.deepStrictEqual(waiting.watch, [], 'no longer watching anything');

    // Autonomous hand-off is refused when that plugin is missing.
    res = await post(`/api/orchestrations/${orch.id}/run`, { autonomous: { budgetUsd: 5 } });
    assert.strictEqual(res.status, 409, 'the hand-off needs the Autonomous Mode plugin');
    assert.match((await res.json()).error, /Autonomous Mode plugin/);
    assert.strictEqual(store.getOrchestration(orch.id).status, 'draft', 'and nothing was started');

    // Delete drops the card (its worker tasks, if any, are independent).
    assert.strictEqual((await fetch(`${base}/api/orchestrations/${orch.id}`, { method: 'DELETE' })).status, 200);
    assert.strictEqual(store.getOrchestration(orch.id), undefined, 'the card is gone');
  } finally {
    store.db.settings.installedPlugins = prevPlugins;
    store.db.repos.splice(store.db.repos.indexOf(repo), 1);
    await new Promise((resolve) => server.close(resolve));
  }
});

test('plugins: the catalog lists Goal Orchestration and sanitize keeps it', () => {
  const plugins = require('../server/plugins');
  const orch = plugins.catalog().find((p: { id: string }) => p.id === 'orchestration');
  assert.ok(orch, 'orchestration is in the marketplace catalog');
  assert.strictEqual(orch.name, 'Goal Orchestration', 'it is displayed under its non-codename name');
  assert.strictEqual(orch.requiresApiKey, false, 'it needs no API key');
  assert.strictEqual(orch.icon, 'crown', 'it uses an icon, never an emoji');
  assert.deepStrictEqual(plugins.sanitize(['orchestration', 'bogus']), ['orchestration'], 'unknown ids are dropped');
});

test('store: db.orchestrations is backfilled and orphaned running cards fail on boot', () => {
  const store = require('../server/store');
  assert.ok(Array.isArray(store.db.orchestrations), 'db.orchestrations is an array (backfilled)');
  // The boot migration marks a card that was running when the server died as
  // failed — exactly what store.ts does for tasks and groomings.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'store.ts'), 'utf8');
  assert.ok(src.includes('Server restarted while the orchestrator was running'), 'orphaned running orchestrations are failed on boot');
});

test('desktop: the editor catalog covers VS Code and the IntelliJ family, keyed by their CLI launchers', () => {
  const desktop = require('../server/desktop');
  const byId = (id: string) => desktop.EDITORS.find((e: { id: string }) => e.id === id);
  assert.deepStrictEqual(byId('vscode').bins, ['code'], 'VS Code launches through `code`');
  assert.deepStrictEqual(byId('intellij').bins, ['idea'], 'IntelliJ launches through `idea`');
  for (const id of ['webstorm', 'pycharm', 'goland', 'phpstorm', 'rubymine', 'clion', 'rider']) {
    assert.ok(byId(id), `${id} is in the catalog`);
  }
  // Every entry needs the two fallbacks a launch depends on, plus a hint to show
  // the user when neither is present.
  for (const e of desktop.EDITORS) {
    assert.ok(e.label && e.bins.length && e.macApps.length && e.hint, `${e.id} is fully specified`);
  }
  assert.ok(['Finder', 'File Explorer', 'file manager'].includes(desktop.FILE_MANAGER_LABEL), 'the file manager has a platform name');
});

test('desktop: detect() reports availability per editor and openInEditor refuses an unknown id', () => {
  const desktop = require('../server/desktop');
  const list = desktop.detect(true);
  assert.strictEqual(list.length, desktop.EDITORS.length, 'every catalog entry is reported');
  for (const e of list) {
    assert.strictEqual(typeof e.available, 'boolean', `${e.id} carries an availability flag`);
    assert.ok(!('bins' in e), 'the board never sees the launcher internals');
  }
  // Throws rather than spawning anything for an id that isn't in the catalog.
  assert.throws(() => desktop.openInEditor('not-an-editor', '/tmp'), /Unknown editor/);
});

test('index: GET /api/desktop lists the editors, and PATCH only accepts a known default', async () => {
  const store = require('../server/store');
  const index = require('../server/index');
  const prev = store.db.settings.defaultEditor;
  const { server, port } = await index.start(0);
  const base = `http://127.0.0.1:${port}`;
  const patch = (body: unknown) => fetch(`${base}/api/settings`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const body = await (await fetch(`${base}/api/desktop`)).json();
    assert.ok(body.fileManager, 'the file manager name is exposed for the button label');
    assert.ok(Array.isArray(body.editors) && body.editors.length, 'the editor catalog is exposed');
    assert.strictEqual(typeof body.defaultEditor, 'string', 'the configured default comes along');

    assert.strictEqual((await (await patch({ defaultEditor: 'intellij' })).json()).defaultEditor, 'intellij', 'a known id sticks');
    assert.strictEqual((await (await patch({ defaultEditor: 'bogus-ide' })).json()).defaultEditor, 'intellij', 'an unknown id is ignored');
    assert.strictEqual((await (await patch({ defaultEditor: '' })).json()).defaultEditor, '', 'and it can be cleared');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.db.settings.defaultEditor = prev;
  }
});

test('resources: the monitor is off by default and samples nothing until enabled', async () => {
  const store = require('../server/store');
  const resources = require('../server/resources');
  assert.strictEqual(store.DEFAULT_SETTINGS.resourceMonitor, false, 'opt-in: off by default');
  const prev = store.db.settings.resourceMonitor;
  store.db.settings.resourceMonitor = false;
  try {
    assert.deepStrictEqual(await resources.snapshot(), { enabled: false }, 'no sample while the feature is off');
  } finally {
    store.db.settings.resourceMonitor = prev;
    resources.reset();
  }
});

test('resources: an enabled snapshot accounts for this process tree and every live agent child', async () => {
  const store = require('../server/store');
  const runner = require('../server/runner');
  const resources = require('../server/resources');
  const prev = store.db.settings.resourceMonitor;
  store.db.settings.resourceMonitor = true;
  resources.reset();
  try {
    const snap = await resources.snapshot();
    assert.strictEqual(snap.enabled, true);
    assert.strictEqual(snap.app.pid, process.pid, 'the app tree is rooted at this process');
    assert.ok(snap.app.processes >= 1 && snap.app.rssBytes > 0, 'this process is accounted for');
    assert.strictEqual(snap.system.cpuCount >= 1, true, 'the core count is reported');
    assert.ok(snap.system.memTotalBytes > 0 && snap.system.memUsedBytes > 0, 'system memory is reported');
    // The live-children list is what agent rows are built from; with no session
    // running there is nothing to attribute, and the totals are the app alone.
    assert.deepStrictEqual(runner.liveChildren(), [], 'no agent child is running in the suite');
    assert.deepStrictEqual(snap.agents, [], 'so no session rows');
    assert.strictEqual(snap.totals.rssBytes, snap.app.rssBytes, 'totals = app + agents');
    assert.strictEqual(snap.totals.processes, snap.app.processes);
    // Cached briefly so several open boards share one process-table read.
    assert.strictEqual(await resources.snapshot(), snap, 'a fresh snapshot is served from the cache');
  } finally {
    store.db.settings.resourceMonitor = prev;
    resources.reset();
  }
});

test('resources: attribute() splits the tree — each agent subtree to its session, the rest to the app', () => {
  const store = require('../server/store');
  const resources = require('../server/resources');
  const MB = 1024 * 1024;
  // A synthetic process table: the app (100) has a helper (101) plus two agent
  // children (200, 300); each agent child has a grandchild of its own, and 999 is
  // an unrelated process that must not be counted at all.
  const rows = [
    { pid: 100, ppid: 1, rssBytes: 100 * MB, cpuPercent: 10 },  // the app
    { pid: 101, ppid: 100, rssBytes: 10 * MB, cpuPercent: 2 },  // a renderer/terminal
    { pid: 200, ppid: 100, rssBytes: 200 * MB, cpuPercent: 40 }, // agent child A
    { pid: 201, ppid: 200, rssBytes: 50 * MB, cpuPercent: 20 },  // A's own subprocess
    { pid: 300, ppid: 100, rssBytes: 60 * MB, cpuPercent: 4 },   // agent child B
    { pid: 301, ppid: 300, rssBytes: 5 * MB, cpuPercent: 1 },    // B's subprocess
    { pid: 999, ppid: 1, rssBytes: 900 * MB, cpuPercent: 90 },   // somebody else's
  ];
  const task = {
    id: store.id(), title: 'A real task', agent: 'codex', repoId: 'r', repoName: 'n', status: 'running',
  };
  store.db.tasks.push(task as never);
  try {
    const live = [
      { id: task.id, pid: 200, startedAt: '2026-07-30T00:00:00.000Z' },
      { id: 'an-ephemeral-ask-session', pid: 300, startedAt: null },
      { id: 'already-exited', pid: 4242, startedAt: null }, // pid gone from the table
    ];
    // 4 cores, so a CPU figure is a quarter of the raw per-core percentages.
    const { app, agents, totals } = resources.attribute(rows, 100, live, 4);

    // The app keeps itself + the helper, and neither agent branch.
    assert.strictEqual(app.pid, 100);
    assert.strictEqual(app.processes, 2, 'the agent subtrees are pruned from the app tree');
    assert.strictEqual(app.rssBytes, 110 * MB);
    assert.strictEqual(app.cpuPercent, 3, '(10 + 2) / 4 cores');

    // Busiest session first, each carrying its own subtree.
    assert.strictEqual(agents.length, 3);
    assert.strictEqual(agents[0].id, task.id, 'the heaviest session is listed first');
    assert.strictEqual(agents[0].kind, 'task');
    assert.strictEqual(agents[0].title, 'A real task');
    assert.strictEqual(agents[0].agent, 'codex', 'the backend comes from the task');
    assert.strictEqual(agents[0].processes, 2, 'the child and its own subprocess');
    assert.strictEqual(agents[0].rssBytes, 250 * MB);
    assert.strictEqual(agents[0].cpuPercent, 15, '(40 + 20) / 4 cores');
    // An ask session is never persisted, so it falls through to the generic label.
    assert.strictEqual(agents[1].kind, 'ask');
    assert.strictEqual(agents[1].cpuPercent, 1.3, '(4 + 1) / 4 cores');
    // A child whose pid already exited is reported as zeroes, not dropped.
    assert.strictEqual(agents[2].id, 'already-exited');
    assert.strictEqual(agents[2].processes, 0);
    assert.strictEqual(agents[2].cpuPercent, null, 'no CPU figure rather than a fake 0');

    // App + agents partition the same tree — the unrelated pid 999 is nowhere.
    assert.strictEqual(totals.processes, 6);
    assert.strictEqual(totals.rssBytes, 425 * MB);
    assert.strictEqual(totals.cpuPercent, 19.3, '(10+2+40+20+4+1) / 4 cores');
  } finally {
    store.db.tasks = store.db.tasks.filter((t: { id: string }) => t.id !== task.id);
  }
});

test('index: PATCH /api/settings round-trips the session budget + MCP isolation and rejects nonsense', async () => {
  const store = require('../server/store');
  const index = require('../server/index');
  const runner = require('../server/runner');
  const prevMem = store.db.settings.sessionMemoryMb;
  const prevIso = store.db.settings.isolateMcpServers;
  const { server, port } = await index.start(0);
  const base = `http://127.0.0.1:${port}`;
  const patch = (body: unknown) => fetch(`${base}/api/settings`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const shown = await (await fetch(`${base}/api/settings`)).json();
    assert.strictEqual(shown.sessionMemoryMb, 'auto', 'the board sees the stored value');
    assert.strictEqual(shown.sessionMemoryAutoMb, runner.autoSessionMemoryMb(),
      'plus what auto resolves to on this machine, so the UI can label it');
    assert.strictEqual(shown.isolateMcpServers, true, 'isolation is on by default');

    const set = await (await patch({ sessionMemoryMb: 4096, isolateMcpServers: false })).json();
    assert.strictEqual(set.sessionMemoryMb, 4096);
    assert.strictEqual(set.isolateMcpServers, false);
    assert.strictEqual(runner.buildTaskEnv('default').BUN_JSC_forceRAMSize, String(4096 * 1024 * 1024),
      'and the next session is spawned with it');

    assert.strictEqual((await patch({ sessionMemoryMb: 0 })).status, 200, '0 (no budget) is allowed');
    assert.strictEqual((await patch({ sessionMemoryMb: 'auto' })).status, 200, "'auto' is allowed");
    // A budget too small to run anything is worse than none — rejected, not clamped.
    assert.strictEqual((await patch({ sessionMemoryMb: 64 })).status, 400, 'an unusably small budget is rejected');
    assert.strictEqual((await patch({ sessionMemoryMb: -1 })).status, 400, 'a negative budget is rejected');
    assert.strictEqual((await patch({ sessionMemoryMb: 'lots' })).status, 400, 'garbage is rejected');
    assert.strictEqual(store.db.settings.sessionMemoryMb, 'auto', 'a rejected patch changes nothing');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.db.settings.sessionMemoryMb = prevMem;
    store.db.settings.isolateMcpServers = prevIso;
  }
});

test('index: GET /api/resources follows the setting, and PATCH toggles it', async () => {
  const store = require('../server/store');
  const index = require('../server/index');
  const resources = require('../server/resources');
  const prev = store.db.settings.resourceMonitor;
  const { server, port } = await index.start(0);
  const base = `http://127.0.0.1:${port}`;
  const patch = (body: unknown) => fetch(`${base}/api/settings`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    store.db.settings.resourceMonitor = false;
    assert.deepStrictEqual(await (await fetch(`${base}/api/resources`)).json(), { enabled: false },
      'the route reports disabled rather than erroring');

    const on = await (await patch({ resourceMonitor: true })).json();
    assert.strictEqual(on.resourceMonitor, true, 'the flag is in the public settings');
    const snap = await (await fetch(`${base}/api/resources`)).json();
    assert.strictEqual(snap.enabled, true, 'and the route now samples');
    assert.strictEqual(snap.app.pid, process.pid);
    assert.ok(Array.isArray(snap.agents), 'sessions are listed (empty here)');

    const off = await (await patch({ resourceMonitor: false })).json();
    assert.strictEqual(off.resourceMonitor, false, 'turning it back off sticks');
    assert.deepStrictEqual(await (await fetch(`${base}/api/resources`)).json(), { enabled: false },
      'and sampling stops immediately, cache included');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.db.settings.resourceMonitor = prev;
    resources.reset();
  }
});

test('index: the reveal/editor routes validate the repo and path before launching anything', async () => {
  const store = require('../server/store');
  const index = require('../server/index');
  const prev = store.db.settings.defaultEditor;
  const { server, port } = await index.start(0);
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const repo = { id: store.id(), path: '/tmp/desktop-repo', name: 'd/desk', branch: null, addedAt: store.now() };
  store.db.repos.push(repo);
  try {
    assert.strictEqual((await post('/api/repos/nope/reveal', {})).status, 404, 'an unknown repo 404s');
    assert.strictEqual((await post('/api/repos/nope/editor', {})).status, 404, 'an unknown repo 404s');
    // A path that isn't the repo root or one of its live worktrees is refused,
    // so neither route can be pointed at an arbitrary filesystem location.
    assert.strictEqual((await post(`/api/repos/${repo.id}/reveal`, { path: '/etc' })).status, 404, 'a foreign path 404s');
    assert.strictEqual((await post(`/api/repos/${repo.id}/editor`, { path: '/etc' })).status, 404, 'a foreign path 404s');
    // With no default configured the editor route reports "pick one" (409)
    // instead of failing — the board opens its picker on that.
    store.db.settings.defaultEditor = '';
    const res = await post(`/api/repos/${repo.id}/editor`, {});
    assert.strictEqual(res.status, 409, 'no editor configured is a 409, not a 500');
    assert.match((await res.json()).error, /No editor configured/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.db.repos = store.db.repos.filter((r: { id: string }) => r.id !== repo.id);
    store.db.settings.defaultEditor = prev;
  }
});

test('index: POST /api/repos/reorder persists the given order and rejects a mismatched id set', async () => {
  const store = require('../server/store');
  const index = require('../server/index');
  const { server, port } = await index.start(0);
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const a = { id: store.id(), path: '/tmp/reorder-a', name: 'a', branch: null, addedAt: store.now() };
  const b = { id: store.id(), path: '/tmp/reorder-b', name: 'b', branch: null, addedAt: store.now() };
  const c = { id: store.id(), path: '/tmp/reorder-c', name: 'c', branch: null, addedAt: store.now() };
  const before = store.db.repos.slice();
  store.db.repos = [a, b, c];
  try {
    let res = await post('/api/repos/reorder', { order: [c.id, a.id, b.id] });
    assert.strictEqual(res.status, 200, 'a full, matching id list reorders successfully');
    assert.deepStrictEqual(store.db.repos.map((r: { id: string }) => r.id), [c.id, a.id, b.id],
      'db.repos now reflects the requested order');

    res = await post('/api/repos/reorder', { order: [a.id, b.id] });
    assert.strictEqual(res.status, 400, 'a short list (missing a repo) is rejected');

    res = await post('/api/repos/reorder', { order: [a.id, b.id, 'nope'] });
    assert.strictEqual(res.status, 400, 'an unknown id is rejected');

    res = await post('/api/repos/reorder', { order: [a.id, a.id, b.id] });
    assert.strictEqual(res.status, 400, 'a duplicated id is rejected');

    // A rejected reorder never touches the stored order.
    assert.deepStrictEqual(store.db.repos.map((r: { id: string }) => r.id), [c.id, a.id, b.id]);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.db.repos = before;
  }
});
