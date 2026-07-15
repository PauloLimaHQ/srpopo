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

test('conflicts: sweep is a no-op when the setting is off, even with a conflicting task in review', async () => {
  const store = require('../server/store');
  const conflicts = require('../server/conflicts');
  const prev = store.db.settings.autoResolveConflicts;
  store.db.settings.autoResolveConflicts = false;
  const task = {
    id: 'sweep-off-task', archived: false, status: 'review', resolvingConflicts: false,
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

test('repoSpecs: discoverSpecs finds .md files under specs/ and .specs/, ignores everything else', () => {
  const repoSpecs = require('../server/repoSpecs');
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'srpopo-specs-'));

  fs.mkdirSync(path.join(repoPath, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(repoPath, 'specs', 'add-dark-mode.md'), '# Add Dark Mode\n\nBody.');

  fs.mkdirSync(path.join(repoPath, '.specs', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(repoPath, '.specs', 'nested', 'spec.md'), 'No heading here, just body.');

  // Ignored: not a markdown extension.
  fs.writeFileSync(path.join(repoPath, 'specs', 'notes.txt'), 'not a spec');

  // Ignored: lives under node_modules, which is skipped while walking.
  fs.mkdirSync(path.join(repoPath, 'node_modules', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(repoPath, 'node_modules', 'specs', 'sneaky.md'), '# Sneaky');

  // Backdate the first file so sort order (most-recent first) is deterministic.
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(repoPath, 'specs', 'add-dark-mode.md'), old, old);

  const found = repoSpecs.discoverSpecs(repoPath);
  assert.deepStrictEqual(
    found.map((f: { path: string }) => f.path).sort(),
    ['.specs/nested/spec.md', 'specs/add-dark-mode.md'].sort(),
    'only the two real .md files are found, nothing from node_modules or the .txt file',
  );

  const dm = found.find((f: { path: string }) => f.path === 'specs/add-dark-mode.md');
  assert.strictEqual(dm.title, 'Add Dark Mode', 'title comes from the first # heading');
  const nested = found.find((f: { path: string }) => f.path === '.specs/nested/spec.md');
  assert.strictEqual(nested.title, 'Spec', 'falls back to a title-cased filename when there is no heading');

  // Most-recently-modified first.
  assert.strictEqual(found[0].path, '.specs/nested/spec.md', 'the freshly-written file sorts first');

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
    '---\nnumber: "0084"\nstatus: draft\ntitle: Add Authentication\n---\n# Different Heading\n\nBody.');
  fs.writeFileSync(path.join(repoPath, 'specs', '0012-logging.md'),
    '---\nnumber: "0012"\nstatus: implemented\n---\n# Structured Logging\n');

  const found = repoSpecs.discoverSpecs(repoPath);
  assert.deepStrictEqual(found.map((f: { number: string }) => f.number), ['0012', '0084'], 'ascending by number');
  const auth = found.find((f: { number: string }) => f.number === '0084');
  assert.strictEqual(auth.title, 'Add Authentication', 'frontmatter title beats the # heading');
  assert.strictEqual(auth.status, 'draft');
  const log = found.find((f: { number: string }) => f.number === '0012');
  assert.strictEqual(log.title, 'Structured Logging', 'falls back to # heading when no frontmatter title');
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

  // Turning it off goes back to prompting; ending the run clears the flag too.
  permissions.setAutoApprove(taskId, false);
  assert.strictEqual(permissions.isAutoApprove(taskId), false, 'auto-approve turns back off');
  permissions.setAutoApprove(taskId, true);
  permissions.rejectForTask(taskId, 'Run ended');
  assert.strictEqual(permissions.isAutoApprove(taskId), false, 'ending the run drops auto-approve');
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
  // around it and a per-task ready flag.
  const sentinel = `Here is my spec.\n${groomer.SPEC_START}\n` +
    '{ "tasks": [' +
    '{ "title": "Add bulk archive", "prompt": "Add a button that archives all Done tasks.", "ready": true },' +
    '{ "title": "Add undo", "prompt": "Let the user undo the bulk archive." }' +
    '] }' +
    `\n${groomer.SPEC_END}\nthanks!`;
  assert.deepStrictEqual(groomer.parseResult(sentinel), [
    { title: 'Add bulk archive', prompt: 'Add a button that archives all Done tasks.', ready: true },
    { title: 'Add undo', prompt: 'Let the user undo the bulk archive.', ready: false },
  ]);

  // Legacy single-object shape still parses as one task.
  const single = `${groomer.SPEC_START}{ "title": "T", "prompt": "P" }${groomer.SPEC_END}`;
  assert.deepStrictEqual(groomer.parseResult(single), [{ title: 'T', prompt: 'P', ready: false }]);

  // Fallback: a ```json fenced block when the markers are missing.
  const fenced = 'blah\n```json\n{"tasks":[{"title":"T","prompt":"P","ready":true}]}\n```\n';
  assert.deepStrictEqual(groomer.parseResult(fenced), [{ title: 'T', prompt: 'P', ready: true }]);

  // No usable prompt → null (never a partial/empty spec).
  assert.strictEqual(groomer.parseResult('no spec here at all'), null);
  assert.strictEqual(groomer.parseResult(`${groomer.SPEC_START}{"tasks":[{"title":"x"}]}${groomer.SPEC_END}`), null,
    'a spec without any prompt is rejected');
  assert.strictEqual(groomer.parseResult(''), null);
  assert.strictEqual(groomer.parseResult(undefined), null);
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

test('autonomous review: re-reviews while a pass commits fixes, then merges when clean', async () => {
  const autonomous = require('../server/autonomous');
  const bus = require('../server/bus');
  const review = mkTask('rv1', 'review', 'repoA', { sessionId: 'sess-rv1', worktreePath: '/tmp/wt/rv1' });
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
    review.status = 'review';
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
  const review = mkTask('rv2', 'review', 'repoA', { sessionId: 'sess-rv2', worktreePath: '/tmp/wt/rv2' });
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
    review.status = 'review';
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
  const review = mkTask('rv3', 'review', 'repoA', { sessionId: 'sess-rv3', worktreePath: '/tmp/wt/rv3' });
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
    review.status = 'review';
    bus.broadcast({ type: 'task', task: review });
    await tick();
    assert.strictEqual(merged, 0, 'a failing PR is never merged');
    assert.strictEqual(review.status, 'review', 'the task is left in review for the human');
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
  const review = mkTask('rv4', 'review', 'repoA', { sessionId: 'sess-rv4', worktreePath: '/tmp/wt/rv4' });
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
      review.status = 'review';
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
