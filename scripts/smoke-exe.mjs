// Smoke-test a built SEA binary — ON THIS OS, the way real callers invoke it.
// The exe used to ship without ever being executed in CI, so a broken SEA
// build or a startup crash in piped-stdio contexts (exactly how the Electron
// dashboard and Claude Code's hook runner spawn it) could reach users silently.
//
//   node scripts/smoke-exe.mjs dist/claude-rpc[.exe]
//
// Everything runs in a throwaway sandbox (HOME/APPDATA/TMPDIR redirected) so
// CI runners and dev machines are never touched.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exe = resolve(process.argv[2] || 'dist/claude-rpc');
if (!existsSync(exe)) {
  console.error(`✗ ${exe} not found — build it first (npm run build:exe)`);
  process.exit(1);
}

const sb = mkdtempSync(join(tmpdir(), 'rpc-smoke-'));
const sbTmp = join(sb, 'tmp');
const sbCfg = join(sb, '.config', 'claude-rpc');
mkdirSync(sbTmp, { recursive: true });
mkdirSync(sbCfg, { recursive: true });
mkdirSync(join(sb, 'appdata', 'claude-rpc'), { recursive: true });
// autostart:false — the SessionStart hook would otherwise self-heal a daemon
// into existence and leave it running on the CI runner. The config files
// alone don't cover every runner: on macOS the config dir is
// ~/Library/Application Support/claude-rpc, which neither write below
// targets — so the env var further down is the guarantee.
const cfg = JSON.stringify({ autostart: false, community: { enabled: false } });
writeFileSync(join(sbCfg, 'config.json'), cfg);
writeFileSync(join(sb, 'appdata', 'claude-rpc', 'config.json'), cfg);

const env = {
  ...process.env,
  HOME: sb,
  USERPROFILE: sb,
  APPDATA: join(sb, 'appdata'),
  LOCALAPPDATA: join(sb, 'appdata'),
  XDG_CONFIG_HOME: join(sb, '.config'),
  TMPDIR: sbTmp,
  TEMP: sbTmp,
  TMP: sbTmp,
  // Per-environment autostart opt-out the SessionStart hook honors on every
  // OS, whatever config it finds (src/hook.js).
  CLAUDE_RPC_NO_AUTOSTART: '1',
};

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

function run(args, input) {
  // stdio fully PIPED on purpose — the dashboard and the hook runner never
  // give the exe a console, and that context must not crash it.
  return spawnSync(exe, args, { input, env, encoding: 'utf8', timeout: 120_000 });
}

console.log(`smoke: ${exe}`);

// 1. --version through pipes: the bare-minimum "the binary boots" check.
{
  const r = run(['--version']);
  check('--version exits 0 (piped stdio)', r.status === 0, `status=${r.status} err=${(r.stderr || '').slice(0, 300)}`);
  check('--version prints a version', /claude-rpc \d+\.\d+\.\d+/.test(r.stdout || ''), JSON.stringify((r.stdout || '').slice(0, 80)));
}

// 2. Hook round-trip: JSON on stdin → state file on disk + {continue} ack.
//    This is the exact hot path Claude Code drives on every lifecycle event.
{
  const r = run(['hook', 'SessionStart'], JSON.stringify({ session_id: 'smoke', cwd: sb }) + '\n');
  check('hook SessionStart exits 0', r.status === 0, `status=${r.status} err=${(r.stderr || '').slice(0, 300)}`);
  check('hook acks {continue:true}', (r.stdout || '').includes('"continue"'), JSON.stringify((r.stdout || '').slice(0, 80)));
  const statePath = join(sbTmp, 'claude-rpc', 'state-smoke.json');
  check('hook wrote session state', existsSync(statePath), statePath);
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    check('state carries the session cwd', state.cwd === sb, JSON.stringify(state.cwd));
  }
}

// 3. vars: pulls in the format/scanner graph + template engine.
{
  const r = run(['vars']);
  check('vars exits 0', r.status === 0, `status=${r.status} err=${(r.stderr || '').slice(0, 300)}`);
  check('vars lists template variables', /statusVerbose|"vars"/.test(r.stdout || ''), JSON.stringify((r.stdout || '').slice(0, 80)));
}

if (failures) {
  console.error(`\n✗ ${failures} smoke check(s) failed`);
  process.exit(1);
}
console.log('\n✓ all smoke checks passed');
