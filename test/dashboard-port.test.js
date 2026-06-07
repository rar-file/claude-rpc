import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const resolveRpcPort = require(join(ROOT, 'dashboard', 'port.js'));

test('dashboard port: falls back to 47474 when CLAUDE_RPC_PORT is unset', (t) => {
  const saved = process.env.CLAUDE_RPC_PORT;
  delete process.env.CLAUDE_RPC_PORT;
  t.after(() => { if (saved !== undefined) process.env.CLAUDE_RPC_PORT = saved; });
  assert.equal(resolveRpcPort(), 47474);
});

test('dashboard port: uses CLAUDE_RPC_PORT when set', (t) => {
  const saved = process.env.CLAUDE_RPC_PORT;
  process.env.CLAUDE_RPC_PORT = '12345';
  t.after(() => {
    if (saved !== undefined) process.env.CLAUDE_RPC_PORT = saved;
    else delete process.env.CLAUDE_RPC_PORT;
  });
  assert.equal(resolveRpcPort(), 12345);
});

test('dashboard port: renderer.js contains no hardcoded 47474', async () => {
  const { readFileSync } = await import('node:fs');
  const renderer = readFileSync(join(ROOT, 'dashboard', 'renderer.js'), 'utf8');
  const noComments = renderer.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!noComments.includes('47474'), 'renderer.js must not hardcode port 47474');
});
