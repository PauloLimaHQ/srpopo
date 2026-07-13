const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Keep the store's on-disk writes out of the repo during tests.
process.env.SRPOPO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'srpopo-test-'));

test('store exposes id/now helpers', () => {
  const store = require('../server/store');
  assert.match(store.id(), /^[0-9a-f]{10}$/, 'id() should be 10 hex chars');
  assert.match(store.now(), /^\d{4}-\d{2}-\d{2}T/, 'now() should be an ISO timestamp');
  assert.ok(store.db && Array.isArray(store.db.tasks), 'db.tasks should be an array');
});

test('store: settings default to notifications on and are backfilled', () => {
  const store = require('../server/store');
  assert.ok(store.db.settings && typeof store.db.settings === 'object', 'db.settings is an object');
  assert.strictEqual(store.db.settings.notifications, true, 'notifications default on');
  assert.strictEqual(store.DEFAULT_SETTINGS.notifications, true, 'DEFAULT_SETTINGS is exported');
});

test('server modules load without throwing', () => {
  assert.doesNotThrow(() => {
    require('../server/git');
    require('../server/bus');
    require('../server/runner');
    require('../server/addons');
    require('../server/personas');
    require('../server/groomer');
    require('../server/index');
  });
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

  // buildArgs appends the flag with the normalized value when set...
  const withAllow = runner.buildArgs(
    { permissionMode: 'acceptEdits', allowedTools: 'Bash(npm test:*)' },
    false,
  );
  const i = withAllow.indexOf('--allowedTools');
  assert.ok(i !== -1, '--allowedTools should be present');
  assert.strictEqual(withAllow[i + 1], 'Bash(npm test:*)', 'value follows the flag');
  assert.ok(withAllow.includes('--permission-mode') && withAllow.includes('acceptEdits'),
    'permission mode is still emitted');

  // ...and omits it entirely when unset.
  const noAllow = runner.buildArgs({ permissionMode: 'acceptEdits' }, false);
  assert.ok(!noAllow.includes('--allowedTools'), 'no flag without allowedTools');
});

test('personas: sanitize keeps only known ids and preamble is prepended', () => {
  const personas = require('../server/personas');
  const ids = personas.catalog().map((p) => p.id);
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
