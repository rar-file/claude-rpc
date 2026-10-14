// Cheap, cached lookups into a project's .git directory.
//
// Everything here reads `.git/config` or `.git/HEAD` directly — no shell-out,
// no spawn, no recursion up parent dirs. The daemon calls these on every
// presence push, so each result is cached per-cwd with a short TTL.
//
// The detached-HEAD case (HEAD contains a raw SHA, not `ref: refs/heads/...`)
// returns an empty branch — template `requires` will hide the branch frame.

import { createRequire } from 'node:module';
import { basename, join, isAbsolute } from 'node:path';

// require()d, not imported — on the hook hot path; see hook.js.
const { readFileSync, statSync } = createRequire(import.meta.url)('node:fs');

const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // cwd → { ts, github, branch, repo }

function fresh(entry) {
  return entry && (Date.now() - entry.ts) < TTL_MS;
}

// Resolve a cwd's `.git` to the directory that actually holds HEAD etc.
// Usually `.git` IS that directory, but in a linked worktree or a submodule
// it's a one-line FILE — "gitdir: <path>" — pointing at the real location
// (e.g. <main>/.git/worktrees/<name>). Treating the file as a directory made
// every read below fail silently, so worktrees lost branch/repo/GitHub-button
// detection entirely.
function resolveGitDir(cwd) {
  const dotGit = join(cwd, '.git');
  let st;
  try { st = statSync(dotGit); } catch { return null; }
  if (st.isDirectory()) return dotGit;
  try {
    const m = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    if (!m) return null;
    return isAbsolute(m[1]) ? m[1] : join(cwd, m[1]);
  } catch { return null; }
}

// The COMMON git dir — where `config` lives. For a linked worktree the
// per-worktree gitdir holds a `commondir` file with a (usually relative)
// path back to the main `.git`; everywhere else the gitdir is its own
// common dir (main repos, submodules).
function commonGitDir(gitDir) {
  try {
    const rel = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    return isAbsolute(rel) ? rel : join(gitDir, rel);
  } catch { return gitDir; }
}

function readGitInfo(cwd) {
  const out = { github: null, branch: '', repo: '' };
  if (!cwd) return out;

  // Repo name fallback is always the cwd basename — overwritten below if we
  // find a github origin.
  out.repo = basename(cwd) || '';

  const gitDir = resolveGitDir(cwd);
  if (!gitDir) return out;

  // origin URL → github URL + repo name.
  try {
    const cfg = readFileSync(join(commonGitDir(gitDir), 'config'), 'utf8');
    // Isolate the [remote "origin"] section (everything up to the next section
    // header) and read its url= line. The old single regex used `[^[]*?`
    // between the header and url=, so any stray `[` in between — e.g. a
    // bracketed comment above the url — aborted the match and silently dropped
    // GitHub detection.
    const oi = cfg.search(/\[remote\s+"origin"\]/i);
    const rest = oi === -1 ? '' : cfg.slice(oi);
    const nextSec = rest ? rest.slice(1).search(/\n[ \t]*\[/) : -1;
    const section = nextSec === -1 ? rest : rest.slice(0, nextSec + 1);
    const m = section.match(/^[ \t]*url\s*=\s*(.+)$/mi);
    if (m) {
      const raw = m[1].trim();
      const ssh = raw.match(/^git@github\.com:([^\s]+?)(?:\.git)?$/i);
      if (ssh) {
        out.github = `https://github.com/${ssh[1]}`;
        out.repo = basename(ssh[1]);
      } else if (/^https?:\/\/github\.com\//i.test(raw)) {
        out.github = raw.replace(/\.git$/i, '');
        out.repo = basename(out.github);
      } else {
        // Non-github remote — still pull the repo name out of the URL.
        const tail = raw.replace(/\.git$/i, '').replace(/[\\/]+$/, '');
        const leaf = tail.split(/[\\/:]/).filter(Boolean).pop();
        if (leaf) out.repo = leaf;
      }
    }
  } catch { /* missing/unreadable .git/config — out.repo stays at cwd basename */ }

  // HEAD → branch (or empty when detached).
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = head.match(/^ref:\s+refs\/heads\/(.+)$/);
    if (ref) out.branch = ref[1].trim();
  } catch { /* missing/unreadable HEAD — leave branch blank, template will hide */ }

  return out;
}

function lookup(cwd) {
  if (!cwd) return { github: null, branch: '', repo: '' };
  const cached = cache.get(cwd);
  if (fresh(cached)) return cached;
  const info = readGitInfo(cwd);
  cache.set(cwd, { ts: Date.now(), ...info });
  return info;
}

export function detectGithubUrl(cwd) { return lookup(cwd).github; }
export function detectGitBranch(cwd) { return lookup(cwd).branch; }
export function detectGitRepo(cwd)   { return lookup(cwd).repo; }

// Last commit subject for the "just shipped" frame. Read on demand from
// `.git/COMMIT_EDITMSG` (written by `git commit` and left in place after).
// Falls back to the last line of `.git/logs/HEAD` when COMMIT_EDITMSG is
// missing — that file always reflects the most recent ref movement.
//
// Not cached on purpose: this is only called the moment a `git
// push`/`git commit` is detected, so we want the freshest possible value,
// and a cache hit might return the *previous* commit's subject if the user
// just made a new one.
export function detectLastCommitSubject(cwd, max = 80) {
  if (!cwd) return '';
  // Follow a worktree/submodule `.git` file to the real gitdir —
  // COMMIT_EDITMSG and logs/HEAD are per-worktree, so the resolved
  // dir (not the common dir) is the right place for both.
  const gitDir = resolveGitDir(cwd);
  if (!gitDir) return '';

  // COMMIT_EDITMSG: the editor buffer from the most recent `git commit`.
  // First non-blank, non-comment line is the subject.
  try {
    const raw = readFileSync(join(gitDir, 'COMMIT_EDITMSG'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      return trimmed.slice(0, max);
    }
  } catch { /* file may not exist on a freshly cloned repo */ }

  // logs/HEAD line shape:
  //   <old> <new> Name <email> <ts> <tz>\t<action>: <subject>
  // We split on the tab, take the action message, strip a leading
  // "commit: " / "commit (initial): " / "merge ..." prefix.
  try {
    const raw = readFileSync(join(gitDir, 'logs', 'HEAD'), 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return '';
    const last = lines[lines.length - 1];
    const tab = last.indexOf('\t');
    if (tab < 0) return '';
    let msg = last.slice(tab + 1).trim();
    msg = msg.replace(/^(commit(?:\s+\([^)]+\))?:\s*)/, '');
    return msg.slice(0, max);
  } catch { /* no logs/HEAD — repo too young or .git/logs disabled */ }

  return '';
}
