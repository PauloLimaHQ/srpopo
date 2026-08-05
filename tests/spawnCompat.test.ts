import test from 'node:test';
import assert from 'node:assert';

const { winEscapeArg, winCommandLine } = require('../server/spawnCompat');

// These expected strings look double-escaped because they are: cmd.exe's own
// `^` escape is consumed by cmd.exe's parser (so it doesn't treat the
// wrapped `"`/`&`/`%`/etc as its own syntax) and only the literal character
// underneath survives into the command line CreateProcess hands the child —
// which is what lets the child's own argv parser see a normal quoted token.
// See the comment in server/spawnCompat.ts.

test('winEscapeArg: plain argument is quoted, and the quotes are caret-escaped for cmd.exe', () => {
  assert.strictEqual(winEscapeArg('claude'), '^"claude^"');
});

test('winEscapeArg: spaces and parens survive as literal text once cmd.exe unwraps it', () => {
  assert.strictEqual(winEscapeArg('Bash(npm run lint:*)'), '^"Bash^(npm run lint:*^)^"');
});

test('winEscapeArg: cmd.exe metacharacters are caret-escaped so they cannot act as operators', () => {
  // Without this, `&` would let cmd.exe run `calc.exe` as a second command.
  assert.strictEqual(winEscapeArg('foo & calc.exe'), '^"foo ^& calc.exe^"');
  // `%` triggers env-var expansion even inside real quotes, so it needs its
  // own escape regardless of quoting.
  assert.strictEqual(winEscapeArg('100% done'), '^"100^% done^"');
});

test('winEscapeArg: embedded double quotes are backslash-escaped for the child argv parser', () => {
  assert.strictEqual(winEscapeArg('say "hi"'), '^"say \\^"hi\\^"^"');
});

test('winEscapeArg: a literal backslash right before the closing quote is doubled', () => {
  assert.strictEqual(winEscapeArg('C:\\path\\'), '^"C:\\path\\\\^"');
});

test('winEscapeArg: ordinary path backslashes elsewhere are left alone', () => {
  assert.strictEqual(winEscapeArg('C:\\Users\\John Doe\\code.cmd'), '^"C:\\Users\\John Doe\\code.cmd^"');
});

test('winEscapeArg: parens in install paths (Program Files (x86)) are escaped', () => {
  assert.strictEqual(winEscapeArg('C:\\Program Files (x86)\\idea.bat'), '^"C:\\Program Files ^(x86^)\\idea.bat^"');
});

test('winCommandLine: joins the escaped tokens and wraps the whole thing in one real quote pair', () => {
  const line = winCommandLine('claude', ['-p', '--model', 'sonnet']);
  assert.strictEqual(line, '"^"claude^" ^"-p^" ^"--model^" ^"sonnet^""');
  // The real outer quotes are exactly one pair, at the very start and end.
  assert.ok(line.startsWith('"') && line.endsWith('"'));
});
