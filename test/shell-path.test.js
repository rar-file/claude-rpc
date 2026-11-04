// Hook-command path words must parse in every hook shell Claude Code uses —
// sh, cmd and PowerShell (#48: a quoted-first command is a PowerShell parse
// error on every hook event).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { hookWord, shortPathWin } = await import('../src/shell-path.js');

test('hookWord: POSIX keeps the quoted form', () => {
  assert.equal(hookWord('/home/me/.nvm/node', { platform: 'linux' }), '"/home/me/.nvm/node"');
});

test('hookWord: Windows path without spaces is bare, forward-slashed', () => {
  const w = hookWord('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\claude-rpc\\src\\hook.js', { platform: 'win32', shortPath: () => assert.fail('no lookup needed') });
  assert.equal(w, 'C:/Users/me/AppData/Roaming/npm/node_modules/claude-rpc/src/hook.js');
});

test('hookWord: Windows path with spaces becomes its 8.3 short form, unquoted', () => {
  const w = hookWord('C:\\Program Files\\nodejs\\node.exe', { platform: 'win32', shortPath: () => 'C:/PROGRA~1/nodejs/node.exe' });
  assert.equal(w, 'C:/PROGRA~1/nodejs/node.exe');
  assert.ok(!w.startsWith('"'), 'a leading quote is a PowerShell expression');
});

test('hookWord: 8.3 names unavailable → quoted fallback', () => {
  assert.equal(hookWord('C:/Program Files/nodejs/node.exe', { platform: 'win32', shortPath: () => null }), '"C:/Program Files/nodejs/node.exe"');
  assert.equal(hookWord('C:/Program Files/nodejs/node.exe', { platform: 'win32', shortPath: (p) => p }), '"C:/Program Files/nodejs/node.exe"');
});

test('shortPathWin: asks cmd for %~s and normalizes slashes; missing path → null', () => {
  let args;
  const spawn = (file, a) => { args = a; return { status: 0, stdout: 'C:\\PROGRA~1\\nodejs\\node.exe\r\n' }; };
  assert.equal(shortPathWin('C:/Program Files/nodejs/node.exe', { spawn, exists: () => true }), 'C:/PROGRA~1/nodejs/node.exe');
  assert.match(args.at(-1), /^for %I in \("C:\\Program Files\\nodejs\\node\.exe"\) do @echo %~sI$/);
  assert.equal(shortPathWin('C:/nope here/x.exe', { spawn: () => assert.fail(), exists: () => false }), null);
});
