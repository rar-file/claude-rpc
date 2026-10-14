// vscode-extension/extension.js activated against a stub `vscode` module and a
// sandboxed tmpdir holding what real hooks write: per-session
// state-<sid>.json files and no legacy state.json. The extension used to read
// and watch only state.json, so a live session showed "Away".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);

// Sandbox BEFORE extension.js loads — it resolves os.tmpdir()/homedir() at
// module load. This test file runs in its own process under node --test.
const SANDBOX = mkdtempSync(join(tmpdir(), 'vscode-ext-'));
const STATE_DIR = join(SANDBOX, 'tmp', 'claude-rpc');
mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(join(SANDBOX, 'home'), { recursive: true });
process.env.TMPDIR = process.env.TMP = process.env.TEMP = join(SANDBOX, 'tmp');
process.env.HOME = process.env.USERPROFILE = join(SANDBOX, 'home');

function writeSession(id, over) {
  const p = join(STATE_DIR, `state-${id}.json`);
  const body = {
    status: 'working',
    lastActivity: Date.now(),
    sessionStart: Date.now() - 60_000,
    cwd: '/home/u/projects/my-app',
    model: 'claude-opus-5-5',
    claudeClosed: false,
    ...over,
  };
  writeFileSync(`${p}.${process.pid}.tmp`, JSON.stringify(body));
  renameSync(`${p}.${process.pid}.tmp`, p);
}

function vscodeStub() {
  const item = {
    text: '',
    visible: false,
    show() {
      this.visible = true;
    },
    hide() {
      this.visible = false;
    },
    dispose() {},
  };
  const noop = () => ({ dispose() {} });
  return {
    item,
    api: {
      StatusBarAlignment: { Left: 1, Right: 2 },
      ThemeColor: class {},
      MarkdownString: class {
        constructor(v) {
          this.value = v;
        }
      },
      Uri: { parse: (s) => s },
      env: { openExternal() {} },
      commands: { registerCommand: noop },
      window: {
        createStatusBarItem: () => item,
        showQuickPick: async () => undefined,
        showInformationMessage: async () => undefined,
        showErrorMessage() {},
        createTerminal: () => ({ show() {}, sendText() {} }),
      },
      workspace: {
        getConfiguration: () => ({ get: (_k, d) => d }),
        onDidChangeConfiguration: noop,
      },
    },
  };
}

test('extension: status bar shows the live per-session state and follows its updates', async (t) => {
  t.after(() => rmSync(SANDBOX, { recursive: true, force: true }));
  writeSession('s1', { status: 'working' });

  const stub = vscodeStub();
  const Module = require('node:module');
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? stub.api : origLoad.call(this, request, ...rest);
  };
  t.after(() => {
    Module._load = origLoad;
  });

  const ext = require('../vscode-extension/extension.js');
  const context = { subscriptions: [] };
  ext.activate(context);
  t.after(() => {
    for (const d of context.subscriptions) d.dispose();
  });

  assert.equal(stub.item.visible, true);
  assert.match(stub.item.text, /Working · my-app/, `got ${JSON.stringify(stub.item.text)}`);
  assert.ok(!/Away/.test(stub.item.text));

  // A hook rewrites the session file → the watcher (or the 3s poll) re-renders.
  writeSession('s1', { status: 'thinking' });
  const end = Date.now() + 6000;
  while (Date.now() < end && !/Thinking/.test(stub.item.text)) await delay(25);
  assert.match(stub.item.text, /Thinking · my-app/);
});
