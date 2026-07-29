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

  // Never crosses backends: no Claude alias appears in a Codex suggestion or vice versa.
  const claudeNames = ['haiku', 'sonnet', 'opus'];
  const codexNames = ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'];
  for (const c of ['simple', 'standard', 'complex']) {
    assert.ok(!codexNames.includes(models.suggestModel('claude', c)));
    assert.ok(!claudeNames.includes(models.suggestModel('codex', c)));
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
    addons: [], personas: [], attachments: [], useWorktree: false, worktreePath: null,
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
  // A Codex task is still reviewed by Claude, so its model name must not leak into
  // `claude --model`.
  assert.ok(!claude.reviewArgs({ model: 'gpt-5.6-sol', agent: 'codex' }).includes('--model'), 'a codex model falls back to the CLI default');
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
  const { server, port } = await index.start(0);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    // Both backends are reported (null when a CLI isn't installed on this machine).
    assert.ok('claude' in body, 'the claude backend is reported');
    assert.ok('codex' in body, 'the codex backend is reported');
    // ok means "at least one backend is available" — a Codex-only install is healthy.
    assert.strictEqual(body.ok, !!(body.claude || body.codex), 'ok is true iff some agent CLI answered');
    if (!body.ok) assert.match(body.error, /No agent CLI found/, 'the error names no agent, not just claude');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    if (prevClaude === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prevClaude;
    if (prevCodex === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = prevCodex;
  }
});

test('runner: adapterFor selects the backend by task.agent and defaults to claude', () => {
  const runner = require('../server/runner');
  assert.strictEqual(runner.adapterFor('claude').id, 'claude', 'claude selects the Claude adapter');
  assert.strictEqual(runner.adapterFor('codex').id, 'codex', 'codex selects the Codex adapter');
  assert.strictEqual(runner.adapterFor(undefined).id, 'claude', 'an unset agent falls back to claude');
  assert.strictEqual(runner.adapterFor('bogus').id, 'claude', 'an unknown agent falls back to claude');
});

test('tasks: createTask defaults agent to claude and accepts codex', () => {
  const store = require('../server/store');
  const tasks = require('../server/tasks');
  const repo = { id: store.id(), path: '/tmp/agent-repo', name: 'o/agent', branch: null, addedAt: store.now() };
  store.db.repos.push(repo);

  const def = tasks.createTask({ repoId: repo.id, title: 'Default agent', prompt: 'do it' });
  assert.strictEqual(def.agent, 'claude', 'agent defaults to claude');

  const cdx = tasks.createTask({ repoId: repo.id, title: 'Codex agent', prompt: 'do it', agent: 'codex' });
  assert.strictEqual(cdx.agent, 'codex', 'a codex agent is kept');

  const bad = tasks.createTask({ repoId: repo.id, title: 'Bad agent', prompt: 'do it', agent: 'gpt' });
  assert.strictEqual(bad.agent, 'claude', 'an unknown agent is sanitized to claude');
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

// ---------- hive orchestration ----------

test('queen: metaPrompt briefs the orchestrator, hands over the repo id, and demands a sentinel status', () => {
  const queen = require('../server/queen');
  const prompt = queen.metaPrompt(
    { goal: 'make the board keyboard-navigable', repoId: 'repo-xyz', repoName: 'o/board', mode: 'manual' },
    'Prefers vanilla JS.',
  );
  assert.ok(prompt.includes('make the board keyboard-navigable'), 'the goal is embedded');
  assert.ok(prompt.includes('repo-xyz'), 'the repo id create_task needs is handed over');
  assert.ok(prompt.includes('mcp__board__create_task'), 'the board tools are named');
  assert.ok(prompt.includes('Prefers vanilla JS.'), 'project memory is injected');
  assert.ok(prompt.includes(queen.HIVE_START) && prompt.includes(queen.HIVE_END), 'the status markers are shown');
  assert.ok(prompt.includes('read-only'), 'it is told it may not edit the repo');
  assert.ok(prompt.includes('EXECUTION MODE: manual'), 'manual mode tells it to dispatch its own tasks');
  assert.ok(prompt.includes('mcp__board__dispatch_task'), 'manual mode names the dispatch tool');

  const auto = queen.metaPrompt({ goal: 'g', repoId: 'r', repoName: 'n', mode: 'autonomous' }, '');
  assert.ok(auto.includes('EXECUTION MODE: autonomous hand-off'), 'autonomous mode is stated');
  assert.ok(auto.includes('"ready"') && auto.includes('pull_request'), 'autonomous mode spells out the required task shape');
  assert.ok(auto.includes('must NOT dispatch'), 'autonomous mode forbids self-dispatch');
});

test('queen: parseStatus recovers all four turn states, and rejects anything else', () => {
  const queen = require('../server/queen');
  const wrap = (json: string) => `thinking out loud…\n${queen.HIVE_START}\n${json}\n${queen.HIVE_END}`;

  const waiting = queen.parseStatus(wrap('{ "state": "waiting", "watch": ["a1", "b2", "a1"], "note": "two in flight" }'));
  assert.strictEqual(waiting.state, 'waiting');
  assert.deepStrictEqual(waiting.watch, ['a1', 'b2'], 'watch ids are deduped');
  assert.strictEqual(waiting.note, 'two in flight');

  const question = queen.parseStatus(wrap('{ "state": "question", "note": "SQLite or JSON?" }'));
  assert.deepStrictEqual(question, { state: 'question', watch: [], note: 'SQLite or JSON?' });

  const done = queen.parseStatus(wrap('{ "state": "done", "summary": "shipped 3 tasks" }'));
  assert.deepStrictEqual(done, { state: 'done', watch: [], note: 'shipped 3 tasks' }, 'summary doubles as the note');

  const blocked = queen.parseStatus(wrap('{ "state": "BLOCKED", "note": "no test runner" }'));
  assert.deepStrictEqual(blocked, { state: 'blocked', watch: [], note: 'no test runner' }, 'state is case-insensitive');

  // A non-waiting turn never carries a watch list, even if the model emits one.
  assert.deepStrictEqual(queen.parseStatus(wrap('{ "state": "done", "watch": ["x"] }')).watch, []);

  // Malformed / missing / unknown-state payloads are all "no status this turn".
  assert.strictEqual(queen.parseStatus(wrap('{ "state": "waiting", ')), null, 'unparseable JSON -> null');
  assert.strictEqual(queen.parseStatus(wrap('{ "state": "pondering" }')), null, 'an unknown state -> null');
  assert.strictEqual(queen.parseStatus(wrap('[1,2,3]')), null, 'a non-object payload -> null');
  assert.strictEqual(queen.parseStatus('no markers, no json at all'), null, 'no payload -> null');
  assert.strictEqual(queen.parseStatus(''), null, 'empty text -> null');
  assert.strictEqual(queen.parseStatus(undefined), null, 'no text at all -> null');

  // The last sentinel span wins, so the echoed example in the prompt loses to
  // the real answer.
  const twice = `${queen.HIVE_START}{"state":"waiting","watch":["old"]}${queen.HIVE_END}` +
    `later…${queen.HIVE_START}{"state":"done","summary":"fin"}${queen.HIVE_END}`;
  assert.strictEqual(queen.parseStatus(twice).state, 'done', 'the last span is the answer');
});

test('queen: statusPrompt digests every watched worker and flags ones that vanished', () => {
  const queen = require('../server/queen');
  const tasks = [
    mkTask('w1', 'validation', 'repoA', { title: 'Add the parser', lastOutcome: 'success', branch: 'srpopo/parser', runCount: 1 }),
    mkTask('w2', 'failed', 'repoA', { title: 'Wire the UI', lastOutcome: 'error', lastError: 'tsc: type error in app.ts' }),
  ];
  const prompt = queen.statusPrompt({ watch: ['w1', 'w2', 'gone'], mode: 'manual' }, tasks);
  assert.ok(prompt.includes('w1') && prompt.includes('Add the parser'), 'each watched task is listed');
  assert.ok(prompt.includes('status=validation'), 'its status is reported');
  assert.ok(prompt.includes('tsc: type error in app.ts'), 'a failure reason is carried over');
  assert.ok(prompt.includes('gone'), 'a deleted watched id is called out');
  assert.ok(prompt.includes(queen.HIVE_START), 'the status contract is restated');

  const reply = queen.replyPrompt('SQLite or JSON?', 'JSON, keep it dependency-free', 'manual');
  assert.ok(reply.includes('SQLite or JSON?') && reply.includes('dependency-free'), 'the Q and A are paired');
  assert.ok(queen.nudgePrompt('manual').includes('no task ids to watch'), 'the empty-watch nudge explains itself');
});

test('queen: deriveTitle takes the first non-empty line and caps length', () => {
  const queen = require('../server/queen');
  assert.strictEqual(queen.deriveTitle('\n\n  Ship the new board  \nmore detail'), 'Ship the new board');
  assert.strictEqual(queen.deriveTitle(''), 'Orchestrated goal', 'empty input still gets a title');
  const long = queen.deriveTitle('x'.repeat(200));
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
function withHiveStore(orchestrations: unknown[], tasks: unknown[]) {
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

// The hive cases below let the engine's debounce timer (collapsed to ~0ms by
// _setTiming) run with the same `tick()` helper the autonomous cases use.

test('hive: a watched worker landing resumes the queen exactly once, with a status digest', async () => {
  const hive = require('../server/hive');
  const bus = require('../server/bus');
  const orch = mkOrchestration('o1', 'waiting', ['w1', 'w2']);
  const w1 = mkTask('w1', 'running', 'repoA');
  const w2 = mkTask('w2', 'running', 'repoA');
  const restore = withHiveStore([orch], [w1, w2]);
  const resumes: string[] = [];
  hive._setDeps({ resume: (_o: unknown, prompt: string) => { resumes.push(prompt); } });
  hive._setTiming({ debounceMs: 0 });
  try {
    hive.start();
    assert.strictEqual(hive.isWatching('o1'), true, 'a waiting orchestration is armed on boot (restart re-arm)');

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
    hive._reset();
    restore();
  }
});

test('hive: a worker mid-code-review has not landed, so the queen is not woken', async () => {
  const hive = require('../server/hive');
  const bus = require('../server/bus');
  const orch = mkOrchestration('o-cr', 'waiting', ['wcr']);
  const worker = mkTask('wcr', 'running', 'repoA');
  const restore = withHiveStore([orch], [worker]);
  const resumes: string[] = [];
  hive._setDeps({ resume: (_o: unknown, prompt: string) => { resumes.push(prompt); } });
  hive._setTiming({ debounceMs: 0 });
  try {
    hive.start();
    // The Code Review stage is a live child, not a terminal state — the worker is
    // still in flight and lands in `validation` next.
    worker.status = 'code_review';
    bus.broadcast({ type: 'task', task: worker });
    await tick();
    assert.strictEqual(resumes.length, 0, 'code_review is not terminal, so nothing resumes');

    worker.status = 'validation';
    bus.broadcast({ type: 'task', task: worker });
    await tick();
    assert.strictEqual(resumes.length, 1, 'the validation landing is what wakes the queen');
  } finally {
    hive._reset();
    restore();
  }
});

test('hive: only the orchestration watching a task reacts to it', async () => {
  const hive = require('../server/hive');
  const bus = require('../server/bus');
  const mine = mkOrchestration('o-mine', 'waiting', ['t-mine']);
  const other = mkOrchestration('o-other', 'waiting', ['t-other']);
  const draft = mkOrchestration('o-draft', 'draft', ['t-mine']);
  const task = mkTask('t-mine', 'validation', 'repoA');
  const restore = withHiveStore([mine, other, draft], [task, mkTask('t-other', 'ready', 'repoA')]);
  const resumed: string[] = [];
  hive._setDeps({ resume: (o: { id: string }) => { resumed.push(o.id); } });
  hive._setTiming({ debounceMs: 0 });
  try {
    hive.start();
    assert.strictEqual(hive.isWatching('o-draft'), false, 'a draft orchestration is never armed');
    bus.broadcast({ type: 'task', task });
    await tick();
    assert.deepStrictEqual(resumed, ['o-mine'], 'only the watcher of that task resumes');
  } finally {
    hive._reset();
    restore();
  }
});

test('hive: never resumes a session that is already running, and retries once it frees up', async () => {
  const hive = require('../server/hive');
  const bus = require('../server/bus');
  const orch = mkOrchestration('o2', 'waiting', ['w3']);
  const task = mkTask('w3', 'validation', 'repoA');
  const restore = withHiveStore([orch], [task]);
  let live = true;
  const resumed: string[] = [];
  hive._setDeps({
    resume: (o: { id: string }) => { resumed.push(o.id); },
    isRunning: () => live,
  });
  hive._setTiming({ debounceMs: 0, retryMs: 0 });
  try {
    hive.start();
    bus.broadcast({ type: 'task', task });
    await tick();
    assert.deepStrictEqual(resumed, [], 'no second turn while the session is live');
    live = false;
    await tick();
    assert.deepStrictEqual(resumed, ['o2'], 'the queued wake-up fires once the session frees up');
  } finally {
    hive._reset();
    restore();
  }
});

test('hive: waits for a free session slot instead of blowing past the parallel cap', async () => {
  const hive = require('../server/hive');
  const bus = require('../server/bus');
  const orch = mkOrchestration('o3', 'waiting', ['w4']);
  const task = mkTask('w4', 'done', 'repoA');
  const restore = withHiveStore([orch], [task]);
  let full = true;
  const resumed: string[] = [];
  hive._setDeps({ resume: (o: { id: string }) => { resumed.push(o.id); }, atCapacity: () => full });
  hive._setTiming({ debounceMs: 0, retryMs: 0 });
  try {
    hive.start();
    bus.broadcast({ type: 'task', task });
    await tick();
    assert.deepStrictEqual(resumed, [], 'held back while every session slot is busy');
    full = false;
    await tick();
    assert.deepStrictEqual(resumed, ['o3'], 'resumes once a slot frees up');
  } finally {
    hive._reset();
    restore();
  }
});

test('hive: the turn cap fails the card instead of looping forever', async () => {
  const hive = require('../server/hive');
  const bus = require('../server/bus');
  const orch = mkOrchestration('o4', 'waiting', ['w5'], { turnCount: hive.MAX_TURNS });
  const task = mkTask('w5', 'validation', 'repoA');
  const restore = withHiveStore([orch], [task]);
  const resumed: string[] = [];
  hive._setDeps({ resume: (o: { id: string }) => { resumed.push(o.id); } });
  hive._setTiming({ debounceMs: 0 });
  try {
    hive.start();
    bus.broadcast({ type: 'task', task });
    await tick();
    assert.deepStrictEqual(resumed, [], 'no further turn is started');
    assert.strictEqual(orch.status, 'failed', 'the card is failed');
    assert.match(String(orch.lastError), new RegExp(`${hive.MAX_TURNS} orchestrator turns`), 'and says why');
    assert.strictEqual(orch.sessionId, null, 'the exhausted session is dropped');
    assert.strictEqual(hive.isWatching('o4'), false, 'the watchers are disarmed');
  } finally {
    hive._reset();
    restore();
  }
});

test('hive: a turn ending as waiting re-arms; question/done/failed and archive disarm', async () => {
  const hive = require('../server/hive');
  const bus = require('../server/bus');
  const orch = mkOrchestration('o5', 'running', []);
  const restore = withHiveStore([orch], []);
  hive._setDeps({ resume: () => {} });
  hive._setTiming({ debounceMs: 0 });
  try {
    hive.start();
    assert.strictEqual(hive.isWatching('o5'), false, 'a running orchestration has nothing to watch');

    orch.status = 'waiting';
    orch.watch = ['w6'];
    bus.broadcast({ type: 'orchestration', orchestration: orch });
    assert.strictEqual(hive.isWatching('o5'), true, 'ending a turn as waiting arms the watchers');

    for (const status of ['awaiting', 'finished', 'failed', 'draft']) {
      orch.status = 'waiting';
      bus.broadcast({ type: 'orchestration', orchestration: orch });
      orch.status = status;
      bus.broadcast({ type: 'orchestration', orchestration: orch });
      assert.strictEqual(hive.isWatching('o5'), false, `${status} disarms the watchers`);
    }

    orch.status = 'waiting';
    bus.broadcast({ type: 'orchestration', orchestration: orch });
    bus.broadcast({ type: 'orchestration-removed', orchestrationId: 'o5' });
    assert.strictEqual(hive.isWatching('o5'), false, 'a removed card is forgotten');
  } finally {
    hive._reset();
    restore();
  }
});

test('hive: a worker that landed while the queen was busy still wakes it on re-arm', async () => {
  const hive = require('../server/hive');
  const bus = require('../server/bus');
  const orch = mkOrchestration('o6', 'running', ['w7']);
  // The worker finished mid-turn, while nothing was armed to notice.
  const task = mkTask('w7', 'validation', 'repoA');
  const restore = withHiveStore([orch], [task]);
  const resumed: string[] = [];
  hive._setDeps({ resume: (o: { id: string }) => { resumed.push(o.id); } });
  hive._setTiming({ debounceMs: 0 });
  try {
    hive.start();
    bus.broadcast({ type: 'task', task }); // lands unnoticed — nothing armed
    await tick();
    assert.deepStrictEqual(resumed, [], 'nothing to notice it yet');
    orch.status = 'waiting';
    bus.broadcast({ type: 'orchestration', orchestration: orch });
    await tick();
    assert.deepStrictEqual(resumed, ['o6'], 'the missed landing is picked up when the watchers re-arm');
  } finally {
    hive._reset();
    restore();
  }
});

test('hive: a waiting turn that watches nothing is nudged rather than stalling forever', async () => {
  const hive = require('../server/hive');
  const bus = require('../server/bus');
  const queen = require('../server/queen');
  const orch = mkOrchestration('o7', 'running', []);
  const restore = withHiveStore([orch], []);
  const prompts: string[] = [];
  hive._setDeps({ resume: (_o: unknown, prompt: string) => { prompts.push(prompt); } });
  hive._setTiming({ debounceMs: 0 });
  try {
    hive.start();
    orch.status = 'waiting';
    orch.watch = [];
    bus.broadcast({ type: 'orchestration', orchestration: orch });
    await tick();
    assert.strictEqual(prompts.length, 1, 'it is resumed immediately');
    assert.strictEqual(prompts[0], queen.nudgePrompt('manual'), 'with the empty-watch nudge');
  } finally {
    hive._reset();
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
  const repo = { id: store.id(), path: '/tmp/hive-repo', name: 'o/hive', branch: null, addedAt: store.now() };
  store.db.repos.push(repo);
  try {
    // Gated: nothing can be created until the plugin is installed.
    store.db.settings.installedPlugins = [];
    let res = await post('/api/orchestrations', { repoId: repo.id, goal: 'x' });
    assert.strictEqual(res.status, 400, 'creation is refused without the plugin');
    assert.match((await res.json()).error, /Hive Orchestration plugin/, 'and says which plugin to install');

    store.db.settings.installedPlugins = ['hive'];
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

test('plugins: the catalog lists Hive Orchestration and sanitize keeps it', () => {
  const plugins = require('../server/plugins');
  const hive = plugins.catalog().find((p: { id: string }) => p.id === 'hive');
  assert.ok(hive, 'hive is in the marketplace catalog');
  assert.strictEqual(hive.requiresApiKey, false, 'it needs no API key');
  assert.strictEqual(hive.icon, 'crown', 'it uses an icon, never an emoji');
  assert.deepStrictEqual(plugins.sanitize(['hive', 'bogus']), ['hive'], 'unknown ids are dropped');
});

test('store: db.orchestrations is backfilled and orphaned running cards fail on boot', () => {
  const store = require('../server/store');
  assert.ok(Array.isArray(store.db.orchestrations), 'db.orchestrations is an array (backfilled)');
  // The boot migration marks a card that was running when the server died as
  // failed — exactly what store.ts does for tasks and groomings.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'store.ts'), 'utf8');
  assert.ok(src.includes('Server restarted while the orchestrator was running'), 'orphaned running orchestrations are failed on boot');
});
