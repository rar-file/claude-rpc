// Auto-update for npm global installs.
//
// The daemon checks the npm registry every few hours; when a newer release in
// the SAME major line exists it runs `npm install -g claude-rpc@<exact
// version>`, then restarts itself. Hooks and config follow on their own — the
// daemon's self-heal-on-update (daemon.js) re-wires them on first boot of the
// new version. Everything else (brew, npx, the packaged exe, a source checkout)
// is never touched: those get a one-line "update available" with the right
// command. A new MAJOR is never installed unattended.
//
// Pure decision functions up top (unit-tested); side effects below.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR, ROOT, IS_PACKAGED, IS_NPM_INSTALL, IS_NPX } from './paths.js';

export const UPDATE_STATE_PATH = join(STATE_DIR, 'update.json');
export const REGISTRY_URL = 'https://registry.npmjs.org/claude-rpc/latest';
const RETRY_FAILED_MS = 24 * 3_600_000;   // don't hammer a version that failed to install
const INSTALL_TIMEOUT_MS = 180_000;
const FETCH_TIMEOUT_MS = 8_000;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;   // no prereleases: only stable tags are ever considered

export function parseVersion(v) {
  const m = SEMVER.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function sameMajor(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  return !!x && !!y && x[0] === y[0];
}

// How this copy was installed → whether we may update it ourselves and what to
// tell the user otherwise.
export function installKind({ packaged = IS_PACKAGED, npm = IS_NPM_INSTALL, npx = IS_NPX, root = ROOT } = {}) {
  if (packaged) return 'packaged';
  if (npx) return 'npx';
  if (/[\\/]Cellar[\\/]/.test(root)) return 'brew';
  if (npm) return 'npm-global';
  return 'dev';
}

export function updateCommand(kind) {
  switch (kind) {
    case 'packaged': return 'download the latest release from https://github.com/rar-file/claude-rpc/releases/latest';
    case 'npx': return 'npx claude-rpc@latest setup';
    case 'brew': return 'brew upgrade claude-rpc';
    case 'dev': return 'git pull';
    default: return 'npm install -g claude-rpc@latest';
  }
}

// → { action: 'none' | 'notify' | 'install', reason }
export function planUpdate({ current, latest, auto = true, kind, failed = null, now = Date.now() }) {
  if (!isNewer(latest, current)) return { action: 'none', reason: 'up to date' };
  if (kind !== 'npm-global') return { action: 'notify', reason: `installed via ${kind}` };
  if (!auto) return { action: 'notify', reason: 'auto-update is off' };
  if (!sameMajor(latest, current)) return { action: 'notify', reason: 'new major version — update manually' };
  if (failed && failed.version === latest && now - failed.at < RETRY_FAILED_MS) {
    return { action: 'notify', reason: 'last install attempt failed — retrying later' };
  }
  return { action: 'install', reason: 'newer release available' };
}

export function readUpdateState(path = UPDATE_STATE_PATH) {
  try { return JSON.parse(readFileSync(path, 'utf8')) || {}; } catch { return {}; }
}
export function writeUpdateState(patch, path = UPDATE_STATE_PATH) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify({ ...readUpdateState(path), ...patch }));
  } catch { /* best-effort: state is advisory */ }
}

// Latest published version, or null on any failure. Only the version string is
// read; nothing about this machine is sent (a bare GET to the public registry).
export async function fetchLatest({ url = REGISTRY_URL, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const v = (await res.json())?.version;
    return parseVersion(v) ? v : null;
  } catch { return null; }
}

// Install exactly `version` globally. Resolves { ok, output }. `npm` is a .cmd
// shim on Windows, which only spawns through a shell.
export async function installVersion(version) {
  if (!parseVersion(version)) return { ok: false, output: 'bad version' };   // also keeps the shell arg safe
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    let out = '';
    const win = process.platform === 'win32';
    const child = spawn(win ? 'npm.cmd' : 'npm', ['install', '-g', `claude-rpc@${version}`, '--no-fund', '--no-audit'],
      { shell: win, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, INSTALL_TIMEOUT_MS);
    const take = (d) => { out = (out + d).slice(-2000); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: out.trim() }); });
  });
}

// One check cycle. Returns { plan, latest, installed }. `install` is injectable
// for tests; callers restart the daemon when `installed` is true.
export async function checkForUpdate({ current, auto, kind = installKind(), fetchLatestFn = fetchLatest, install = installVersion, now = Date.now(), statePath = UPDATE_STATE_PATH } = {}) {
  const latest = await fetchLatestFn();
  writeUpdateState({ checkedAt: now, ...(latest ? { latest } : {}) }, statePath);
  if (!latest) return { plan: { action: 'none', reason: 'registry unreachable' }, latest: null, installed: false };
  const state = readUpdateState(statePath);
  const plan = planUpdate({ current, latest, auto, kind, failed: state.failed || null, now });
  if (plan.action !== 'install') return { plan, latest, installed: false };
  const res = await install(latest);
  if (res.ok) {
    writeUpdateState({ updatedFrom: current, updatedTo: latest, updatedAt: now, failed: null }, statePath);
    return { plan, latest, installed: true };
  }
  writeUpdateState({ failed: { version: latest, at: now, output: res.output.slice(-300) } }, statePath);
  return { plan: { action: 'notify', reason: 'install failed' }, latest, installed: false, error: res.output };
}
