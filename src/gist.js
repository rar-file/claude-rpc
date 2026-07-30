// Publishes a single SVG file to a GitHub gist so a README can render it
// via raw.githubusercontent.com. Two paths:
//
//   1. The `gh` CLI (if installed + authed). This is the common terminal
//      flow — no token plumbing required. We shell out to `gh gist create`
//      / `gh gist edit` against a temp file.
//   2. The GitHub REST API directly, using GH_TOKEN / GITHUB_TOKEN. Falls
//      through here when `gh` is missing — useful for CI cron jobs that
//      can mint a fine-grained token but can't install gh.
//
// On create we capture { id, owner } and return them so cli.js can persist
// the linkage in config.json. Subsequent runs hit the EDIT path against
// the same gist, so the README markdown URL stays stable across updates.

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `gh` on Windows is gh.cmd/gh.exe — a bare 'gh' spawn (no shell) won't resolve
// the extension, so detection and publish silently fell through to the REST
// path (which then needs GH_TOKEN). Run via the shell on win32 so PATHEXT
// resolves it. shell:true does NOT auto-quote, and our args include a
// space-bearing --desc, so quote anything with whitespace/quotes ourselves.
const WIN = process.platform === 'win32';
function ghQuote(a) {
  return /[\s"]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a;
}
function gh(args, opts = {}) {
  // windowsHide so the gh.exe/cmd shim doesn't flash a console window on
  // Windows (shell:true routes through cmd.exe; hide that too). No-op elsewhere.
  return WIN
    ? spawnSync('gh', args.map(ghQuote), { ...opts, shell: true, windowsHide: true })
    : spawnSync('gh', args, { ...opts, windowsHide: true });
}

// Bare fetch has no total timeout; a stalled GitHub endpoint would hang the
// publish forever. 10s is plenty for a gist round-trip.
const FETCH_TIMEOUT_MS = 10_000;

// Extract { owner, id } from a "https://gist.github.com/<user>/<hash>"
// URL. Returns null on no match — callers throw with the raw output so
// debugging an unparseable gh response is straightforward.
export function parseGistUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/gist\.github\.com\/([^/\s]+)\/([0-9a-fA-F]+)/);
  if (!m) return null;
  return { owner: m[1], id: m[2] };
}

// Stable raw URL for a gist file — GitHub camo will cache + serve through
// this in a README image tag. The /raw/ path with no SHA resolves to the
// latest revision, so `claude-rpc badge --gist` runs always end up rendered
// without README edits.
export function rawGistUrl({ owner, id, filename }) {
  return `https://gist.githubusercontent.com/${owner}/${id}/raw/${filename}`;
}

// Markdown snippet a user can paste into a README. The filename trailing
// the URL doubles as the alt-text/title hint.
export function gistMarkdown({ owner, id, filename, label = 'Claude' }) {
  return `![${label}](${rawGistUrl({ owner, id, filename })})`;
}

export function hasGh() {
  try {
    const r = gh(['--version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    // gh missing entirely → spawn throws on some platforms instead of
    // returning a non-zero status. Either signal means "not available".
    return false;
  }
}

// The login of the account `gh` is authed as, or null when gh is missing or
// logged out. `gh api user` needs auth, so a non-zero status covers both.
export function ghLogin() {
  try {
    const r = gh(['api', 'user', '--jq', '.login'], { encoding: 'utf8' });
    if (r.status === 0) return (r.stdout || '').trim() || null;
  } catch { /* same "not available" signals as hasGh */ }
  return null;
}

function ghCreate(filePath, description, isPublic) {
  const args = ['gist', 'create', filePath, '--desc', description];
  if (isPublic) args.push('--public');
  const r = gh(args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`gh gist create failed: ${(r.stderr || r.stdout || '').trim()}`);
  }
  const out = (r.stdout || '').trim();
  // gh prints assorted progress lines; the actual URL is the only token
  // beginning with http(s)://.
  const url = out.split(/\s+/).filter((s) => /^https?:\/\//.test(s)).pop() || out;
  const parsed = parseGistUrl(url);
  if (!parsed) throw new Error(`could not parse gist URL from gh output: ${out}`);
  return { ...parsed, htmlUrl: url };
}

function ghEdit(gistId, filePath) {
  const r = gh(['gist', 'edit', gistId, filePath], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`gh gist edit failed: ${(r.stderr || r.stdout || '').trim()}`);
  }
}

async function restCreate({ svg, filename, description, isPublic, token }) {
  const res = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      description,
      public: !!isPublic,
      files: { [filename]: { content: svg } },
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`POST /gists ${res.status}: ${body.slice(0, 200)}`);
  }
  const j = await res.json();
  return { id: j.id, owner: j.owner?.login || '', htmlUrl: j.html_url };
}

async function restEdit({ svg, filename, gistId, token }) {
  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ files: { [filename]: { content: svg } } }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`PATCH /gists/${gistId} ${res.status}: ${body.slice(0, 200)}`);
  }
}

// Publish (create or update) a single file in a gist. `gistId` + `owner`
// passed in => EDIT path; absent => CREATE path. Returns the resolved
// gist identity + raw URL the caller can put in a README.
export async function publishGistFile({
  svg,
  filename = 'claude.svg',
  description = 'claude-rpc badge — autogenerated',
  gistId,
  owner,
  isPublic = true,
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
}) {
  if (!svg || typeof svg !== 'string') throw new Error('publishGistFile: svg must be a non-empty string');
  if (hasGh()) {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rpc-gist-'));
    const path = join(dir, filename);
    writeFileSync(path, svg);
    try {
      if (gistId) {
        ghEdit(gistId, path);
        return { id: gistId, owner: owner || '', filename, rawUrl: rawGistUrl({ owner: owner || '', id: gistId, filename }) };
      }
      const created = ghCreate(path, description, isPublic);
      return {
        id: created.id,
        owner: created.owner,
        filename,
        htmlUrl: created.htmlUrl,
        rawUrl: rawGistUrl({ owner: created.owner, id: created.id, filename }),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (!token) {
    throw new Error('neither `gh` CLI nor GH_TOKEN/GITHUB_TOKEN available — run `gh auth login` or set GH_TOKEN');
  }
  if (gistId) {
    await restEdit({ svg, filename, gistId, token });
    return { id: gistId, owner: owner || '', filename, rawUrl: rawGistUrl({ owner: owner || '', id: gistId, filename }) };
  }
  const created = await restCreate({ svg, filename, description, isPublic, token });
  return {
    id: created.id,
    owner: created.owner,
    filename,
    htmlUrl: created.htmlUrl,
    rawUrl: rawGistUrl({ owner: created.owner, id: created.id, filename }),
  };
}
