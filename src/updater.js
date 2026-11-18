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

import { readFileSync, writeFileSync, mkdirSync, accessSync, constants as fsConstants } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { STATE_DIR, ROOT, IS_PACKAGED, IS_NPM_INSTALL, IS_NPX } from './paths.js';

export const UPDATE_STATE_PATH = join(STATE_DIR, 'update.json');
export const REGISTRY_URL = 'https://registry.npmjs.org/claude-rpc/latest';
const RETRY_FAILED_MS = 24 * 3_600_000;   // don't hammer a version that failed to install
const COOLDOWN_MS = 2 * 3_600_000;        // a release must be seen this long before it's installed — a yank window
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
export function planUpdate({ current, latest, auto = true, kind, writable = true, failed = null, seen = null, cooldownMs = COOLDOWN_MS, now = Date.now() }) {
  if (!isNewer(latest, current)) return { action: 'none', reason: 'up to date' };
  if (kind !== 'npm-global') return { action: 'notify', reason: `installed via ${kind}` };
  if (!auto) return { action: 'notify', reason: 'auto-update is off' };
  // A root-owned global (system node, `sudo npm i -g`) fails with EACCES every
  // single attempt — say so once instead of failing silently every day.
  if (!writable) return { action: 'notify', reason: 'the global npm folder needs admin rights — update manually' };
  if (!sameMajor(latest, current)) return { action: 'notify', reason: 'new major version — update manually' };
  if (failed && failed.version === latest && now - failed.at < RETRY_FAILED_MS) {
    return { action: 'notify', reason: 'last install attempt failed — retrying later' };
  }
  if (cooldownMs > 0 && !(seen && seen.version === latest && now - seen.at >= cooldownMs)) {
    return { action: 'notify', reason: 'new release is settling — installing after the cooldown' };
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
      // Put the running node's own dir first so `npm` is the one that belongs to
      // this node (nvm/fnm/volta installs; a login-launched daemon often has a
      // bare PATH) — i.e. the npm that created the global we're replacing.
      { shell: win, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}` } });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, INSTALL_TIMEOUT_MS);
    const take = (d) => { out = (out + d).slice(-2000); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: out.trim() }); });
  });
}

// Can this process replace its own package? (npm writes the new copy into the
// folder that holds ours: …/lib/node_modules on POSIX, %AppData%\npm\node_modules.)
export function installDirWritable(root = ROOT) {
  try { accessSync(dirname(root), fsConstants.W_OK); return true; } catch { return false; }
}

// The version now on disk where THIS copy lives. npm exiting 0 doesn't mean it
// replaced us: with a different npm prefix (volta, pnpm/yarn/bun globals, a
// changed `npm config prefix`) it installs somewhere else, the restart comes
// back up on the old code, and the daemon reinstalled again every 5 minutes.
export function installedVersion(root = ROOT) {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || null; } catch { return null; }
}

// One check cycle. Returns { plan, latest, installed }. `install`, `verify`
// and `writable` are injectable for tests; callers restart the daemon when
// `installed` is true.
export async function checkForUpdate({ current, auto, kind = installKind(), fetchLatestFn = fetchLatest, install = installVersion, verify = (v) => installedVersion() === v, writable = installDirWritable, now = Date.now(), cooldownMs = COOLDOWN_MS, statePath = UPDATE_STATE_PATH } = {}) {
  const latest = await fetchLatestFn();
  writeUpdateState({ checkedAt: now, ...(latest ? { latest } : {}) }, statePath);
  if (!latest) return { plan: { action: 'none', reason: 'registry unreachable' }, latest: null, installed: false };
  let state = readUpdateState(statePath);
  if (state.seen?.version !== latest) {            // first sighting starts the cooldown clock
    writeUpdateState({ seen: { version: latest, at: now } }, statePath);
    state = readUpdateState(statePath);
  }
  const plan = planUpdate({ current, latest, auto, kind, writable: kind === 'npm-global' ? writable() : true, failed: state.failed || null, seen: state.seen || null, cooldownMs, now });
  writeUpdateState({ lastPlan: { action: plan.action, reason: plan.reason, latest, at: now } }, statePath);
  if (plan.action !== 'install') return { plan, latest, installed: false };
  const res = await install(latest);
  if (res.ok && !verify(latest)) {
    res.ok = false;
    res.output = `npm reported success but this copy (${ROOT}) is still v${current} — npm installs its globals somewhere else here (npm prefix / volta / pnpm). Update with the tool that installed claude-rpc.`;
  }
  if (res.ok) {
    writeUpdateState({ updatedFrom: current, updatedTo: latest, updatedAt: now, failed: null }, statePath);
    return { plan, latest, installed: true };
  }
  writeUpdateState({ failed: { version: latest, at: now, output: res.output.slice(-300) } }, statePath);
  return { plan: { action: 'notify', reason: 'install failed' }, latest, installed: false, error: res.output };
}
