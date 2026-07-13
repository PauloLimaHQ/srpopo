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
    require('../server/plugins');
    require('../server/index');
  });
});

test('plugins: catalog lists Linear and sanitize keeps only known ids', () => {
  const plugins = require('../server/plugins');
  const ids = plugins.catalog().map((p: { id: string }) => p.id);
  assert.ok(ids.includes('linear'), 'Linear is in the marketplace catalog');
  assert.ok(plugins.isKnown('linear'), 'isKnown recognizes a catalog id');
  assert.strictEqual(plugins.isKnown('nope'), false, 'isKnown rejects unknown ids');
  assert.deepStrictEqual(plugins.sanitize(['linear', 'bogus']), ['linear'], 'unknown ids dropped');
  assert.deepStrictEqual(plugins.sanitize('not-an-array'), [], 'non-array yields []');
  assert.deepStrictEqual(plugins.sanitize(['linear', 'linear']), ['linear'], 'ids deduped');
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
});

test('groomer: parseResult recovers { title, prompt } from the session output', () => {
  const groomer = require('../server/groomer');

  // Primary path: JSON between the sentinels, even with prose around it.
  const sentinel = `Here is my spec.\n${groomer.SPEC_START}\n` +
    '{ "title": "Add bulk archive", "prompt": "Add a button that archives all Done tasks." }' +
    `\n${groomer.SPEC_END}\nthanks!`;
  assert.deepStrictEqual(groomer.parseResult(sentinel), {
    title: 'Add bulk archive',
    prompt: 'Add a button that archives all Done tasks.',
  });

  // Fallback: a ```json fenced block when the markers are missing.
  const fenced = 'blah\n```json\n{"title":"T","prompt":"P"}\n```\n';
  assert.deepStrictEqual(groomer.parseResult(fenced), { title: 'T', prompt: 'P' });

  // No usable prompt → null (never a partial/empty spec).
  assert.strictEqual(groomer.parseResult('no spec here at all'), null);
  assert.strictEqual(groomer.parseResult(`${groomer.SPEC_START}{"title":"x"}${groomer.SPEC_END}`), null,
    'a spec without a prompt is rejected');
  assert.strictEqual(groomer.parseResult(''), null);
  assert.strictEqual(groomer.parseResult(undefined), null);
});

test('groomer: deriveTitle takes the first non-empty line and caps length', () => {
  const groomer = require('../server/groomer');
  assert.strictEqual(groomer.deriveTitle('\n  make the tray icon animate  \nsecond line'), 'make the tray icon animate');
  assert.strictEqual(groomer.deriveTitle(''), 'Groomed idea');
  const long = groomer.deriveTitle('x'.repeat(200));
  assert.ok(long.length <= 60 && long.endsWith('…'), 'long titles are truncated with an ellipsis');
});
