// Cheap, cached lookups into a project's .git directory.
//
// Everything here reads `.git/config` or `.git/HEAD` directly — no shell-out,
// no spawn, no recursion up parent dirs. The daemon calls these on every
// presence push, so each result is cached per-cwd with a short TTL.
//
// The detached-HEAD case (HEAD contains a raw SHA, not `ref: refs/heads/...`)
// returns an empty branch — template `requires` will hide the branch frame.

import { readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // cwd → { ts, github, branch, repo }

function fresh(entry) {
  return entry && (Date.now() - entry.ts) < TTL_MS;
}

function readGitInfo(cwd) {
  const out = { github: null, branch: '', repo: '' };
  if (!cwd) return out;

  // Repo name fallback is always the cwd basename — overwritten below if we
  // find a github origin.
  out.repo = basename(cwd) || '';

  const gitDir = join(cwd, '.git');
  if (!existsSync(gitDir)) return out;

  // origin URL → github URL + repo name.
  try {
    const cfg = readFileSync(join(gitDir, 'config'), 'utf8');
    const m = cfg.match(/\[remote\s+"origin"\][^\[]*?url\s*=\s*([^\r\n]+)/i);
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
