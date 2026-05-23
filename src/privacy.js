// Privacy mode — controls what the Discord card shows about a given cwd.
// Three layers, highest-priority first:
//
//   1. Per-project ./.claude-rpc.json file in the project root.
//      { "visibility": "hidden|name-only|public", "projectName": "alias" }
//      Shortcut: { "private": true } == { "visibility": "hidden" }
//   2. Runtime list at ~/.claude-rpc/private-list.json, toggled by
//      `claude-rpc private` / `claude-rpc public`.
//   3. Auto-detection of GitHub private repos via the `gh` CLI when
//      installed. Best-effort, silently skips when gh isn't available
//      or auth isn't set up. Cached per-cwd with 5min TTL.
//
// "Visibility" levels:
//   public      everything as-is (default)
//   name-only   project name kept, but currentFile / currentTool / files
//               arrays cleared so the card doesn't leak paths
//   hidden      cwd cleared entirely; daemon then short-circuits to
//               clearActivity (same effect as hideWhenStale)
//
// Aggregates (scanner) and the local TUI/web dashboards are NEVER affected
// by these flags. Privacy is a one-way valve from local state → Discord.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename, dirname, resolve as resolvePath } from 'node:path';
import { DATA_DIR } from './paths.js';

const PRIVATE_LIST_PATH = join(DATA_DIR, 'private-list.json');
const TTL_MS = 5 * 60 * 1000;

const projectFileCache = new Map();   // cwd → { ts, value | null }
const ghPrivateCache  = new Map();    // cwd → { ts, value: bool | null }

// ── Per-project .claude-rpc.json ────────────────────────────────────────

// Walk up from `cwd` looking for a .claude-rpc.json. Stops at the first
// match or at a .git directory (the project root). Lets a subdirectory
// inherit the parent's privacy config.
function findProjectFile(cwd) {
  if (!cwd) return null;
  let dir = cwd;
  while (true) {
    const candidate = join(dir, '.claude-rpc.json');
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, '.git'))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readProjectConfig(cwd) {
  if (!cwd) return null;
  const cached = projectFileCache.get(cwd);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.value;
  let value = null;
  const path = findProjectFile(cwd);
  if (path) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed && typeof parsed === 'object') value = parsed;
    } catch { /* broken JSON ≡ no override */ }
  }
  projectFileCache.set(cwd, { ts: Date.now(), value });
  return value;
}

function normalizeProjectConfig(cfg) {
  if (!cfg) return null;
  let visibility = cfg.visibility;
  if (cfg.private === true && !visibility) visibility = 'hidden';
  if (!['public', 'name-only', 'hidden'].includes(visibility)) visibility = null;
  return {
    visibility,
    projectName: typeof cfg.projectName === 'string' ? cfg.projectName : null,
  };
}

// ── Runtime private-list ────────────────────────────────────────────────

function readPrivateList() {
  if (!existsSync(PRIVATE_LIST_PATH)) return { paths: [] };
  try {
    const v = JSON.parse(readFileSync(PRIVATE_LIST_PATH, 'utf8'));
    if (Array.isArray(v?.paths)) return v;
  } catch { /* broken JSON ≡ no list (treat as empty rather than crash) */ }
  return { paths: [] };
}

function writePrivateList(list) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PRIVATE_LIST_PATH, JSON.stringify(list, null, 2));
}

export function addPrivateCwd(cwd) {
  const list = readPrivateList();
  const abs = resolvePath(cwd);
  if (!list.paths.includes(abs)) {
    list.paths.push(abs);
    writePrivateList(list);
  }
  return list.paths;
}

export function removePrivateCwd(cwd) {
  const list = readPrivateList();
  const abs = resolvePath(cwd);
  list.paths = list.paths.filter((p) => p !== abs);
  writePrivateList(list);
  return list.paths;
}

export function listPrivateCwds() {
  return readPrivateList().paths;
}

function isInPrivateList(cwd) {
  if (!cwd) return false;
  const abs = resolvePath(cwd);
  return readPrivateList().paths.some(
    (p) => abs === p || abs.startsWith(p + '/') || abs.startsWith(p + '\\')
  );
}

// ── GitHub-private detection (best-effort, gh CLI) ──────────────────────

function detectGithubPrivate(cwd) {
  if (!cwd) return null;
  const cached = ghPrivateCache.get(cwd);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.value;
  let value = null;
  try {
    const out = execFileSync(
      'gh',
      ['repo', 'view', '--json', 'isPrivate', '-q', '.isPrivate'],
      { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 }
    ).toString().trim();
    if (out === 'true') value = true;
    else if (out === 'false') value = false;
  } catch { /* gh missing, not auth'd, not a repo, timeout — unknown */ }
  ghPrivateCache.set(cwd, { ts: Date.now(), value });
  return value;
}

// ── Resolution + application ────────────────────────────────────────────

// Resolve effective visibility for a cwd.
// Returns: { visibility, projectName, reason }
export function resolveVisibility(cwd, config = {}) {
  const proj = normalizeProjectConfig(readProjectConfig(cwd));
  if (proj?.visibility) {
    return { visibility: proj.visibility, projectName: proj.projectName, reason: '.claude-rpc.json' };
  }
  if (isInPrivateList(cwd)) {
    return { visibility: 'hidden', projectName: proj?.projectName ?? null, reason: 'private-list' };
  }
  const patterns = config?.privacy?.patterns || [];
  if (patterns.length && cwd) {
    const leaf = basename(cwd);
    for (const p of patterns) {
      if (matchesPattern(leaf, p)) {
        const mode = config?.privacy?.mode || 'hidden';
        return { visibility: mode, projectName: proj?.projectName ?? null, reason: `config pattern '${p}'` };
      }
    }
  }
  if (config?.privacy?.autoDetectGithubPrivate !== false) {
    const isPrivate = detectGithubPrivate(cwd);
    if (isPrivate === true) {
      const mode = config?.privacy?.githubPrivateMode || 'hidden';
      return { visibility: mode, projectName: proj?.projectName ?? null, reason: 'github private repo' };
    }
  }
  return { visibility: 'public', projectName: proj?.projectName ?? null, reason: 'default' };
}

// Glob-lite. '*' matches any run; otherwise plain text. Case-insensitive.
function matchesPattern(name, pattern) {
  if (pattern === name) return true;
  if (!pattern.includes('*')) return false;
  const re = new RegExp('^' + pattern.split('*').map(escapeRe).join('.*') + '$', 'i');
  return re.test(name);
}
function escapeRe(s) { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }

// Apply privacy to a post-applyIdle state. Pure function — no IO.
export function applyPrivacy(state, config = {}) {
  if (!state || state.status === 'stale') return state;
  const { visibility, projectName } = resolveVisibility(state.cwd || '', config);

  if (visibility === 'public') {
    if (projectName) {
      return { ...state, cwd: joinCwdAlias(state.cwd, projectName), _privacy: { visibility, alias: true } };
    }
    return state;
  }

  if (visibility === 'name-only') {
    return {
      ...state,
      cwd: projectName ? joinCwdAlias(state.cwd, projectName) : state.cwd,
      currentTool: null,
      currentFile: null,
      filesEdited: [],
      filesRead: [],
      filesOpened: [],
      _privacy: { visibility, alias: !!projectName },
    };
  }

  // hidden
  return {
    ...state,
    cwd: '',
    currentTool: null,
    currentFile: null,
    filesEdited: [],
    filesRead: [],
    filesOpened: [],
    _privacy: { visibility, alias: false },
  };
}

function joinCwdAlias(cwd, alias) {
  if (!cwd) return alias;
  const sep = cwd.includes('\\') ? '\\' : '/';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return alias;
  parts[parts.length - 1] = alias;
  return (cwd.startsWith('/') ? '/' : '') + parts.join(sep);
}
