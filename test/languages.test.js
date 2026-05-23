// languageOf — the language-bucket function the scanner uses to tag every
// file edit. A miscategorization here ripples into the dashboard's Languages
// panel and the cost split, so the test pins the common cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { languageOf } = await import('../src/languages.js');

test('languageOf: extension-based classification', () => {
  assert.equal(languageOf('src/foo.ts'), 'TypeScript');
  assert.equal(languageOf('a.tsx'), 'TypeScript');
  assert.equal(languageOf('/abs/path/server.py'), 'Python');
  assert.equal(languageOf('module.rs'), 'Rust');
  assert.equal(languageOf('README.md'), 'Markdown');
});

test('languageOf: extensionless filenames map by basename', () => {
  assert.equal(languageOf('Dockerfile'), 'Dockerfile');
  assert.equal(languageOf('Makefile'), 'Make');
  assert.equal(languageOf('/etc/Rakefile'), 'Ruby');
});

test('languageOf: unknown extensions return null', () => {
  assert.equal(languageOf('a.whatevs'), null);
  assert.equal(languageOf('binary'), null);
});

test('languageOf: falsy inputs are safe', () => {
  assert.equal(languageOf(null), null);
  assert.equal(languageOf(''), null);
  assert.equal(languageOf(undefined), null);
});

test('languageOf: case-insensitive on extension', () => {
  // Real files may come in via ToolUse with mixed-case names. The bucket
  // should still resolve so the dashboard doesn't double-count "py" and
  // "PY" as different languages.
  assert.equal(languageOf('foo.PY'), 'Python');
  assert.equal(languageOf('foo.TS'), 'TypeScript');
});
