import test from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Each test file under `node --test` runs in its own process, so — like
// smoke.test.ts — set this before any server module is required.
process.env.SRPOPO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'srpopo-ask-test-'));

test('ask: askPrompt carries the question, and the repo memory only when given', () => {
  const ask = require('../server/ask');

  const withoutMemory = ask.askPrompt('How do we handle auth?', null);
  assert.ok(withoutMemory.includes('How do we handle auth?'), 'includes the question');
  assert.ok(!withoutMemory.toLowerCase().includes('memory'), 'no memory section when none is given');

  const withMemory = ask.askPrompt('How do we handle auth?', 'Auth uses JWT cookies.');
  assert.ok(withMemory.includes('How do we handle auth?'), 'still includes the question');
  assert.ok(withMemory.includes('Auth uses JWT cookies.'), 'includes the memory content');
  assert.ok(withMemory.toLowerCase().includes('memory'), 'mentions the memory section');
});

test('ask: readMemory reads DATA_DIR/memory/<repoId>.md when present, else null', () => {
  const store = require('../server/store');
  const ask = require('../server/ask');
  const repoId = store.id();

  assert.strictEqual(ask.readMemory(repoId), null, 'no file yet -> null');

  const memDir = path.join(store.DATA_DIR, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, `${repoId}.md`), '  Some project memory.  \n');
  assert.strictEqual(ask.readMemory(repoId), 'Some project memory.', 'reads and trims the file');

  // A blank/whitespace-only memory file is treated the same as no memory.
  fs.writeFileSync(path.join(memDir, `${repoId}.md`), '   \n');
  assert.strictEqual(ask.readMemory(repoId), null, 'blank file -> null');
});

test('index: POST /api/repos/:id/ask validates the repo and the question before spawning anything', async () => {
  const store = require('../server/store');
  const index = require('../server/index');
  const { server, port } = await index.start(0);
  try {
    const missing = await fetch(`http://127.0.0.1:${port}/api/repos/nope/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'how do we handle auth?' }),
    });
    assert.strictEqual(missing.status, 404, 'unknown repo is a 404');

    const repo = { id: store.id(), path: '/tmp/ask-repo', name: 'o/ask-repo', branch: null, addedAt: store.now() };
    store.db.repos.push(repo);

    const blank = await fetch(`http://127.0.0.1:${port}/api/repos/${repo.id}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '   ' }),
    });
    assert.strictEqual(blank.status, 400, 'a blank question is a 400');

    const missingField = await fetch(`http://127.0.0.1:${port}/api/repos/${repo.id}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(missingField.status, 400, 'a missing question is a 400');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('index: POST /api/asks/:id/stop is a 409 when the session is not running', async () => {
  const index = require('../server/index');
  const { server, port } = await index.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/asks/nope/stop`, { method: 'POST' });
    assert.strictEqual(res.status, 409, 'stopping a session that is not running is a 409');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
