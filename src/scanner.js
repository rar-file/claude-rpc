import { readdirSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync, renameSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { CLAUDE_PROJECTS, SCAN_CACHE_PATH, AGGREGATE_PATH, DATA_DIR, EVENTS_LOG_PATH } from './paths.js';
import { languageOf } from './languages.js';
import { costFor, pricingKeyFor } from './pricing.js';

// Bumping this forces a full re-parse on next scan. Increment whenever the
// per-transcript summary schema changes in a way old caches can't satisfy.
const CACHE_VERSION = 4;

// Cap counted gap between consecutive timestamps. Anything larger is treated
// as the user walking away — we count only what's plausibly active time.
const ACTIVE_GAP_CAP_MS = 5 * 60 * 1000;

// Local-time YYYY-MM-DD key for bucketing.
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ISO week key like "2026-W21" using local time. Monday-start.
function weekKey(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  // ISO 8601: week starts Monday; week 1 contains Jan 4.
  const day = (d.getDay() + 6) % 7; // Mon = 0
  d.setDate(d.getDate() - day + 3); // move to Thursday of this week
  const firstThursday = new Date(d.getFullYear(), 0, 4);
  const week = 1 + Math.round(((d - firstThursday) / 86_400_000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function hourKey(ts) {
  return new Date(ts).getHours();
}

// Reject malformed or implausible transcript timestamps before they poison
// firstTs/lastTs (which drive wallMs) and the day/week/hour buckets. A NaN from
// a bad string, a year-0 epoch artifact, or a far-future entry from a skewed
// clock would otherwise inflate lifetime totals. Floor: before Claude Code
// could plausibly exist. Ceiling: now + a generous clock-skew margin.
const TS_FLOOR = Date.UTC(2020, 0, 1);
const TS_SKEW_MS = 48 * 60 * 60 * 1000;
function parseTs(raw) {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  if (t < TS_FLOOR || t > Date.now() + TS_SKEW_MS) return null;
  return t;
}

// Calendar day index (whole days since the Unix epoch) anchored at UTC noon.
// Subtracting two of these always yields an exact number of calendar days —
// immune to DST, where subtracting two local-midnight Dates gives a 23h or 25h
// span that Math.floor/Math.round can turn into an off-by-one day.
function dayNum(y, mZeroBased, d) {
  return Math.floor(Date.UTC(y, mZeroBased, d, 12) / 86_400_000);
}
function dayKeyNum(key) {
  const [y, m, d] = key.split('-').map(Number);
  return dayNum(y, m - 1, d);
}

const EDITING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// First non-env token of a shell command. `FOO=bar git status` → `git`.
// Strips `sudo`, `time`, and tee-style decorators that aren't the "real" command.
function firstShellToken(cmd) {
  if (!cmd || typeof cmd !== 'string') return '';
  // Strip leading whitespace + env assignments (VAR=value chains).
  const stripped = cmd.replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, '').trim();
  // First token, then strip path: `/usr/bin/python3` → `python3`.
  let first = stripped.split(/\s+/)[0] || '';
  if (first === 'sudo' || first === 'time') {
    const rest = stripped.slice(first.length).trim();
    return firstShellToken(rest);
  }
  // Drop pipe/redirect prefix oddities and trailing chars.
  first = first.replace(/^[`(]+|[`)]+$/g, '');
  const slash = first.lastIndexOf('/');
  if (slash !== -1) first = first.slice(slash + 1);
  return first.toLowerCase();
}

function domainOf(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    const m = url.match(/^https?:\/\/([^/?#]+)/i);
    return m ? m[1].replace(/^www\./, '') : '';
  }
}

function countLines(text) {
  if (!text || typeof text !== 'string') return 0;
  // Treat empty trailing newline as not contributing — line count is the
  // number of "\n"-separated chunks that actually have content, plus one for
  // the final segment if non-empty.
  if (text === '') return 0;
  const lines = text.split('\n');
  // Drop a single trailing empty string from a trailing newline.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

// Trailing ISO-ish datetime suffix (e.g. "-2026-04-25T185311Z"). When a cwd's
// basename ends with one of these, collapse it so all "archive-*" snapshots
// aggregate under a single project name.
export const DATE_SUFFIX_RE = /[-_.]\d{4}[-_.]?\d{2}[-_.]?\d{2}(?:[Tt._-]?\d{0,6})?Z?$/;
export function cleanProjectName(name) {
  if (!name) return name;
  return name.replace(DATE_SUFFIX_RE, '') || name;
}

function blankDay() {
  return {
    activeMs: 0,
    userMessages: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    sessions: 0,
    linesAdded: 0,
    linesRemoved: 0,
    cost: 0,
    notifications: 0,
    firstTs: null,
    lastTs: null,
  };
}

function mergeDay(target, src) {
  target.activeMs += src.activeMs || 0;
  target.userMessages += src.userMessages || 0;
  target.toolCalls += src.toolCalls || 0;
  target.inputTokens += src.inputTokens || 0;
  target.outputTokens += src.outputTokens || 0;
  target.cacheReadTokens += src.cacheReadTokens || 0;
  target.cacheWriteTokens += src.cacheWriteTokens || 0;
  target.sessions += src.sessions || 0;
  target.linesAdded += src.linesAdded || 0;
  target.linesRemoved += src.linesRemoved || 0;
  target.cost += src.cost || 0;
  target.notifications += src.notifications || 0;
  if (src.firstTs && (!target.firstTs || src.firstTs < target.firstTs)) target.firstTs = src.firstTs;
  if (src.lastTs && (!target.lastTs || src.lastTs > target.lastTs)) target.lastTs = src.lastTs;
}

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function safeJson(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function isRealUserMessage(record) {
  if (record.type !== 'user' || record.isMeta) return false;
  const c = record.message?.content;
  if (typeof c === 'string') {
    if (c.startsWith('<local-command') || c.startsWith('<system-reminder') || c.startsWith('<command-')) return false;
    return c.trim().length > 0;
  }
  if (Array.isArray(c)) {
    const hasToolResult = c.some((b) => b.type === 'tool_result');
    if (hasToolResult) return false;
    return c.some((b) => b.type === 'text' && String(b.text || '').trim().length > 0);
  }
  return false;
}

function collectFilePath(input = {}) {
  return input.file_path || input.path || input.notebook_path || null;
}

// Iterate newline-delimited lines of a string without materializing the full
// `.split('\n')` array (a second full-size copy of the file). Peak overhead is
// one line slice instead of N strings — meaningful for multi-MB transcripts.
function* iterLines(raw) {
  let start = 0;
  let nl;
  while ((nl = raw.indexOf('\n', start)) !== -1) {
    yield raw.slice(start, nl);
    start = nl + 1;
  }
  if (start < raw.length) yield raw.slice(start);
}

// Read up to `maxBytes` from the head of a file without loading the whole
// thing. Used to pull the cwd from a transcript's first lines — reading a
// multi-MB transcript in full just to inspect its head was pure waste.
function readHead(path, maxBytes = 65536) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

function blankTranscriptSummary() {
  return {
    sessionId: null,
    project: null,
    cwd: null,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    userMessages: 0,
    toolCalls: 0,
    toolBreakdown: {},
    files: [],
    firstTs: null,
    lastTs: null,
    activeMs: 0,
    byDay: {},     // day-key → blankDay
    byWeek: {},    // ISO week key → blankDay
    byHour: {},    // hour-of-day (0..23) → blankDay
    fileEdits: {}, // absolute path → edit count
    fileEditTs: {}, // absolute path → most-recent edit timestamp (hotspot aging)
    // Phase 1 enrichments
    linesAdded: 0,
    linesRemoved: 0,
    bashCommands: {},     // first token → count
    webDomains: {},       // hostname → count
    subagents: {},        // subagent_type → count
    cost: 0,              // estimated USD
    costByModel: {},      // pricing key → USD
    modelsUsed: {},       // raw model id → assistant turns
    byModel: {},          // pricing key → { turns, tokens, cost } (model split)
  };
}

// Sliding window for assistant message-id dedup (see parseChunkInto). Blocks
// of one message land on ADJACENT lines, so a small window catches every real
// split while staying cheap to persist in the scan cache.
const RECENT_IDS_MAX = 200;

// Parse complete JSONL lines into `summary`, mutating it in place. `pstate`
// carries the cross-chunk bookkeeping that incremental (append-only) parsing
// needs to behave exactly like a full parse:
//   recentIds — recently counted assistant message.ids. Claude Code splits
//               one assistant message (a single message.id) across several
//               JSONL lines — one per content block — repeating the SAME
//               `usage` object on every line. Token/cost/turn counting must
//               happen once per message.id, or a 3-block turn counts 3×.
//               Content blocks themselves are distinct per line, so those
//               stay counted per line.
//   lastRec   — the previous chunk's final timestamped record, so the
//               active-time gap across a chunk boundary still accrues.
function parseChunkInto(text, summary, pstate) {
  const fileSet = new Set(summary.files || []);
  // Records in their original order, retaining timestamps for per-day bucketing.
  const records = [];

  for (const line of iterLines(text)) {
    if (!line) continue;
    const r = safeJson(line);
    if (!r) continue;
    if (r.sessionId && !summary.sessionId) summary.sessionId = r.sessionId;
    if (r.cwd && !summary.cwd) {
      summary.cwd = r.cwd;
      summary.project = cleanProjectName(basename(r.cwd));
    }
    const ts = parseTs(r.timestamp);
    const day = ts ? dayKey(ts) : null;
    const week = ts ? weekKey(ts) : null;
    const hour = ts ? hourKey(ts) : null;
    const dayBucket  = day  ? (summary.byDay[day]   ||= blankDay()) : null;
    const weekBucket = week ? (summary.byWeek[week] ||= blankDay()) : null;
    const hourBucket = hour !== null ? (summary.byHour[hour] ||= blankDay()) : null;
    const allBuckets = [dayBucket, weekBucket, hourBucket].filter(Boolean);

    if (r.type === 'assistant') {
      const turnModel = r.message?.model || summary.model;
      const u = r.message?.usage;
      // Count usage/cost/turn only the first time we see this message.id (see
      // the pstate.recentIds note above). No id (rare/legacy) → count it.
      const msgId = r.message?.id;
      const firstSeen = !msgId || !pstate.recentIds.includes(msgId);
      if (msgId && firstSeen) {
        pstate.recentIds.push(msgId);
        if (pstate.recentIds.length > RECENT_IDS_MAX) pstate.recentIds.shift();
      }
      // Per-model split bucket, keyed by pricing key so cost/tokens/turns align.
      const mkey = turnModel ? pricingKeyFor(turnModel) : null;
      const mb = mkey ? (summary.byModel[mkey] ||= { turns: 0, tokens: 0, cost: 0 }) : null;
      if (u && firstSeen) {
        summary.inputTokens += u.input_tokens || 0;
        summary.outputTokens += u.output_tokens || 0;
        summary.cacheReadTokens += u.cache_read_input_tokens || 0;
        summary.cacheWriteTokens += u.cache_creation_input_tokens || 0;
        for (const bucket of allBuckets) {
          bucket.inputTokens += u.input_tokens || 0;
          bucket.outputTokens += u.output_tokens || 0;
          bucket.cacheReadTokens += u.cache_read_input_tokens || 0;
          bucket.cacheWriteTokens += u.cache_creation_input_tokens || 0;
        }
        if (mb) {
          mb.tokens += (u.input_tokens || 0) + (u.output_tokens || 0)
                     + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        }
        // Per-turn cost — uses this turn's model id, not the session's first-seen one.
        const turnCost = costFor({ model: turnModel, usage: u });
        if (turnCost > 0) {
          summary.cost += turnCost;
          // When the turn has no model id, mkey is null but costFor charged it
          // at sonnet rates (pricing's default) — bucket it under 'sonnet', not
          // a literal "null" key that renders as a "null" bar on the dashboard.
          const ck = mkey || 'sonnet';
          summary.costByModel[ck] = (summary.costByModel[ck] || 0) + turnCost;
          if (mb) mb.cost += turnCost;
          for (const bucket of allBuckets) bucket.cost += turnCost;
        }
      }
      if (turnModel) {
        if (!summary.model) summary.model = turnModel;
        if (firstSeen) {
          summary.modelsUsed[turnModel] = (summary.modelsUsed[turnModel] || 0) + 1;
          if (mb) mb.turns += 1;
        }
      }
      const blocks = r.message?.content || [];
      for (const b of blocks) {
        if (b.type === 'tool_use') {
          summary.toolCalls += 1;
          summary.toolBreakdown[b.name] = (summary.toolBreakdown[b.name] || 0) + 1;
          for (const bucket of allBuckets) bucket.toolCalls += 1;
          const input = b.input || {};
          const f = collectFilePath(input);
          if (f) {
            fileSet.add(f);
            if (EDITING_TOOLS.has(b.name)) {
              summary.fileEdits[f] = (summary.fileEdits[f] || 0) + 1;
              if (ts && ts > (summary.fileEditTs[f] || 0)) summary.fileEditTs[f] = ts;
            }
          }
          // Code churn — lines added/removed. For Edit, we count
          // new_string / old_string lines once; `replace_all` would technically
          // multiply by the number of occurrences in the target file, but we
          // can't see file contents here, so we under-count those uniformly.
          if (b.name === 'Edit') {
            const adds = countLines(input.new_string);
            const rems = countLines(input.old_string);
            summary.linesAdded += adds;
            summary.linesRemoved += rems;
            for (const bucket of allBuckets) {
              bucket.linesAdded += adds;
              bucket.linesRemoved += rems;
            }
          } else if (b.name === 'MultiEdit') {
            // One MultiEdit carries N independent edits; sum their churn the
            // same way Edit does. (File-edit count above already credited it
            // once, the right granularity for hotspots.)
            for (const e of (Array.isArray(input.edits) ? input.edits : [])) {
              const adds = countLines(e.new_string);
              const rems = countLines(e.old_string);
              summary.linesAdded += adds;
              summary.linesRemoved += rems;
              for (const bucket of allBuckets) {
                bucket.linesAdded += adds;
                bucket.linesRemoved += rems;
              }
            }
          } else if (b.name === 'Write') {
            const adds = countLines(input.content);
            summary.linesAdded += adds;
            for (const bucket of allBuckets) bucket.linesAdded += adds;
          } else if (b.name === 'NotebookEdit') {
            const adds = countLines(input.new_source);
            summary.linesAdded += adds;
            for (const bucket of allBuckets) bucket.linesAdded += adds;
          } else if (b.name === 'Bash') {
            const cmd = firstShellToken(input.command);
            if (cmd) summary.bashCommands[cmd] = (summary.bashCommands[cmd] || 0) + 1;
          } else if (b.name === 'WebFetch' || b.name === 'WebSearch') {
            const host = b.name === 'WebFetch' ? domainOf(input.url) : '';
            if (host) summary.webDomains[host] = (summary.webDomains[host] || 0) + 1;
          } else if (b.name === 'Agent' || b.name === 'Task') {
            const kind = input.subagent_type || 'general-purpose';
            summary.subagents[kind] = (summary.subagents[kind] || 0) + 1;
          }
        }
      }
    } else if (isRealUserMessage(r)) {
      summary.userMessages += 1;
      for (const bucket of allBuckets) bucket.userMessages += 1;
    }
    if (ts) records.push({ ts, day, week, hour });
  }

  summary.files = Array.from(fileSet);
  if (records.length) {
    records.sort((a, b) => a.ts - b.ts);
    if (!summary.firstTs || records[0].ts < summary.firstTs) summary.firstTs = records[0].ts;
    const chunkLast = records[records.length - 1].ts;
    if (!summary.lastTs || chunkLast > summary.lastTs) summary.lastTs = chunkLast;
    // Charge each gap's active time to the day/week/hour of the earlier
    // record. The first record's "earlier" is the previous chunk's last.
    let prev = pstate.lastRec;
    for (const rec of records) {
      if (prev) {
        const gap = rec.ts - prev.ts;
        if (gap > 0 && gap < ACTIVE_GAP_CAP_MS) {
          summary.activeMs += gap;
          if (prev.day)  (summary.byDay[prev.day]   ||= blankDay()).activeMs += gap;
          if (prev.week) (summary.byWeek[prev.week] ||= blankDay()).activeMs += gap;
          if (prev.hour !== null && prev.hour !== undefined) {
            (summary.byHour[prev.hour] ||= blankDay()).activeMs += gap;
          }
        }
      }
      prev = rec;
    }
    pstate.lastRec = prev;
  }
}

// Parse a single transcript JSONL into a per-file summary.
//
// With a prior cache entry (`prev`), parses only the bytes appended since the
// last scan — transcripts are append-only, and an active session's multi-MB
// file otherwise gets fully re-read every rescan tick. The entry carries
// `_offset` (bytes consumed through the last complete line) and `_parse`
// (the cross-chunk bookkeeping for parseChunkInto); anything that breaks the
// append assumption (file shrank, entry predates these fields, `_offset`
// null) falls back to a from-scratch parse.
export function parseTranscript(filePath, prev = null) {
  const st = statSync(filePath);
  const canAppend = !!(prev && prev._parse && typeof prev._offset === 'number'
    && st.size >= prev._offset);
  const summary = canAppend ? structuredClone(prev) : blankTranscriptSummary();
  const pstate = canAppend
    ? { recentIds: (prev._parse.recentIds || []).slice(), lastRec: prev._parse.lastRec || null }
    : { recentIds: [], lastRec: null };
  const startOffset = canAppend ? prev._offset : 0;

  let text = '';
  const len = st.size - startOffset;
  if (len > 0) {
    let fd;
    try {
      fd = openSync(filePath, 'r');
      const buf = Buffer.allocUnsafe(len);
      const n = readSync(fd, buf, 0, len, startOffset);
      text = buf.toString('utf8', 0, n);
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
    }
  }

  // Consume through the last newline; \n is single-byte ASCII so the boundary
  // is exact even with multi-byte content in the lines.
  const lastNl = text.lastIndexOf('\n');
  const complete = lastNl === -1 ? '' : text.slice(0, lastNl + 1);
  const remainder = lastNl === -1 ? text : text.slice(lastNl + 1);
  parseChunkInto(complete, summary, pstate);
  let offset = startOffset + Buffer.byteLength(complete, 'utf8');
  if (remainder.trim()) {
    if (safeJson(remainder) !== null) {
      // A complete final line that just isn't newline-terminated (fully
      // written file). Count it, but mark the entry non-appendable — if more
      // bytes ever land we can't tell whether they extend this line.
      parseChunkInto(remainder, summary, pstate);
      offset = null;
    }
    // else: a partial line mid-write — leave it for the next (append) read.
  }
  summary._offset = offset;
  summary._parse = { recentIds: pstate.recentIds, lastRec: pstate.lastRec };
  return summary;
}

function listTranscripts(projectsDir) {
  if (!existsSync(projectsDir)) return [];
  const results = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) results.push(full);
    }
  };
  walk(projectsDir);
  return results;
}

// Walk multiple project roots in one pass. Used by scan() to support
// `additionalProjectsDirs` config + the `claude-rpc backfill <path>` command
// for ad-hoc imports. Deduplicates by absolute path so overlapping roots
// don't double-count.
function listAllTranscripts(dirs) {
  const all = new Set();
  for (const d of dirs) {
    for (const fp of listTranscripts(d)) all.add(fp);
  }
  return Array.from(all);
}

function isSubagentPath(p) {
  return /[\\/]subagents[\\/]/.test(p);
}

// The daemon runs for weeks; these per-transcript caches would otherwise grow
// one entry per file ever observed. LRU with a generous cap — the hot set is
// the handful of live sessions, so an eviction just costs one re-read.
const CACHE_MAX_ENTRIES = 512;
function lruTouch(map, key, value) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size > CACHE_MAX_ENTRIES) map.delete(map.keys().next().value);
}

// Pull the real cwd from the head of a transcript so live sessions can show
// "my-app" instead of the slugified directory name.
const cwdCache = new Map(); // path → { mtime, cwd }
function readTranscriptCwd(path, mtimeMs) {
  const cached = cwdCache.get(path);
  if (cached && cached.mtime === mtimeMs) {
    lruTouch(cwdCache, path, cached);
    return cached.cwd;
  }
  let cwd = null;
  try {
    let seen = 0;
    for (const line of iterLines(readHead(path))) {
      if (++seen > 25) break;
      if (!line) continue;
      const r = safeJson(line);
      if (r?.cwd) { cwd = r.cwd; break; }
    }
  } catch { /* transcript head unreadable — cwd stays null, project name falls back to slug */ }
  lruTouch(cwdCache, path, { mtime: mtimeMs, cwd });
  return cwd;
}

// Per-transcript token cache. Reading a multi-MB .jsonl on every push tick
// (4s) would be wasteful, so we only re-parse when the file's mtime has
// advanced since the last read.
const sessionTokenCache = new Map();  // path → { mtime, size, offset, tokens }

// Accumulate assistant-usage tokens from a chunk of complete JSONL lines.
function sumUsageLines(text, tokens) {
  for (const line of iterLines(text)) {
    if (!line) continue;
    const r = safeJson(line);
    if (!r || r.type !== 'assistant') continue;
    const u = r.message?.usage;
    if (!u) continue;
    tokens.input      += u.input_tokens || 0;
    tokens.output     += u.output_tokens || 0;
    tokens.cacheRead  += u.cache_read_input_tokens || 0;
    tokens.cacheWrite += u.cache_creation_input_tokens || 0;
  }
}

// Sum input/output/cache tokens from a single transcript JSONL.
//
// We need this because Claude Code's hook payloads don't carry usage data —
// tokens are an assistant-message field, not a tool-call field, so PostToolUse
// hooks fire with no `usage` block to capture. The live transcript is the
// only source of truth for the current session's running token count.
//
// Returns null when the file can't be read; { input, output, cacheRead,
// cacheWrite } otherwise. Cached by mtime — repeat calls with no file
// activity are O(1).
export function readSessionTokens(path) {
  let st;
  try { st = statSync(path); } catch { return null; }
  const cached = sessionTokenCache.get(path);
  if (cached && cached.mtime === st.mtimeMs) {
    lruTouch(sessionTokenCache, path, cached);
    return cached.tokens;
  }

  // Transcripts are append-only JSONL. If the file only grew since the last
  // read, parse just the appended tail from the cached byte offset instead of
  // re-reading the whole (growing) file on every 4s daemon tick. Anything else
  // (shrunk/truncated/rewritten) falls back to a full re-read.
  const canAppend = cached && st.size >= cached.size && cached.offset <= st.size;
  const tokens = canAppend
    ? { ...cached.tokens }
    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const startOffset = canAppend ? cached.offset : 0;
  let newOffset = startOffset;

  let fd;
  try {
    fd = openSync(path, 'r');
    const len = st.size - startOffset;
    if (len > 0) {
      const buf = Buffer.allocUnsafe(len);
      const n = readSync(fd, buf, 0, len, startOffset);
      const text = buf.toString('utf8', 0, n);
      // Only consume through the last newline; a trailing partial line is left
      // for a later read (offset stays before it). \n is single-byte ASCII so
      // the boundary is exact even with multi-byte content in the lines.
      const lastNl = text.lastIndexOf('\n');
      if (lastNl !== -1) {
        const complete = text.slice(0, lastNl + 1);
        newOffset = startOffset + Buffer.byteLength(complete, 'utf8');
        sumUsageLines(complete, tokens);
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }

  lruTouch(sessionTokenCache, path, { mtime: st.mtimeMs, size: st.size, offset: newOffset, tokens });
  return tokens;
}

// Detect live sessions by transcript mtime. Returns array of { path, project, cwd, mtime, ageSec }.
// A session is "live" if its .jsonl was modified within thresholdMs.
// Roots default to the same set scan() uses — the canonical ~/.claude/projects
// plus any discovered alt locations — so live presence, concurrent-session
// detection, the web API, doctor and the TUI don't go silent on XDG-strict /
// AppData / Library-relocated installs. Legacy single-root `projectsDir` and
// explicit multi-root `projectsDirs` are both still accepted.
export function findLiveSessions({ projectsDir, projectsDirs, thresholdMs = 90_000 } = {}) {
  const dirs = projectsDirs && projectsDirs.length ? projectsDirs
    : projectsDir ? [projectsDir]
    : [CLAUDE_PROJECTS, ...discoverAltProjectDirs()];
  const now = Date.now();
  const live = [];
  for (const root of dirs) {
    if (!existsSync(root)) continue;
    let projects;
    try { projects = readdirSync(root); } catch { continue; }
    for (const proj of projects) {
      const projPath = join(root, proj);
      let entries;
      try { entries = readdirSync(projPath, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        // Only top-level transcripts count as sessions, not subagent files.
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const full = join(projPath, e.name);
        let st;
        try { st = statSync(full); } catch { continue; }
        const age = now - st.mtimeMs;
        if (age <= thresholdMs) {
          const cwd = readTranscriptCwd(full, st.mtimeMs);
          const project = cleanProjectName(cwd ? basename(cwd) : proj);
          live.push({ path: full, project, cwd: cwd || '', mtime: st.mtimeMs, ageSec: Math.round(age / 1000) });
        }
      }
    }
  }
  live.sort((a, b) => b.mtime - a.mtime);
  return live;
}

function readCache() {
  ensureDataDir();
  if (!existsSync(SCAN_CACHE_PATH)) return { _v: CACHE_VERSION, files: {} };
  try {
    const raw = JSON.parse(readFileSync(SCAN_CACHE_PATH, 'utf8'));
    if (!raw || raw._v !== CACHE_VERSION) return { _v: CACHE_VERSION, files: {} };
    return raw;
  } catch { return { _v: CACHE_VERSION, files: {} }; }
}

function writeCache(cache) {
  ensureDataDir();
  cache._v = CACHE_VERSION;
  const tmp = SCAN_CACHE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(cache));
  renameSync(tmp, SCAN_CACHE_PATH);
}

// Per-day notification counts come from a hook-side append log, since
// transcripts don't carry Notification events reliably.
function readNotificationsByDay() {
  if (!existsSync(EVENTS_LOG_PATH)) return {};
  const out = {};
  try {
    const raw = readFileSync(EVENTS_LOG_PATH, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const e = safeJson(line);
      if (!e || e.type !== 'notification' || !e.ts) continue;
      const k = dayKey(e.ts);
      out[k] = (out[k] || 0) + 1;
    }
  } catch { /* events log unreadable/truncated — return whatever we got, the aggregate will just under-count notifications */ }
  return out;
}

function writeAggregate(agg) {
  ensureDataDir();
  const tmp = AGGREGATE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(agg, null, 2));
  renameSync(tmp, AGGREGATE_PATH);
}

export function readAggregate() {
  if (!existsSync(AGGREGATE_PATH)) return null;
  try { return JSON.parse(readFileSync(AGGREGATE_PATH, 'utf8')); }
  catch { return null; }
}

export { dayKey, weekKey, hourKey };

function aggregateFrom(cache) {
  const agg = {
    sessions: 0,
    subagentRuns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    userMessages: 0,
    toolCalls: 0,
    toolBreakdown: {},
    projects: {},
    activeMs: 0,
    wallMs: 0,
    uniqueFiles: 0,
    firstTs: null,
    lastTs: null,
    byDay: {},
    byWeek: {},
    byHour: {},
    byWeekday: {},
    fileEdits: {},
    fileEditTs: {},
    streak: 0,
    longestStreak: 0,
    daysSinceFirst: 0,
    bestDay: null,
    peakHour: null,
    topEditedFiles: [],
    // Phase 1 enrichments
    linesAdded: 0,
    linesRemoved: 0,
    linesNet: 0,
    bashCommands: {},
    webDomains: {},
    subagents: {},
    languages: {},
    mcpToolCalls: 0,
    builtinToolCalls: 0,
    estimatedCost: 0,
    costByModel: {},
    modelsUsed: {},
    byModel: {},
    modelSplit: [],
    notifications: 0,
    generatedAt: Date.now(),
    _v: CACHE_VERSION,
  };
  const fileSet = new Set();
  for (const [path, summary] of Object.entries(cache.files)) {
    if (!summary) continue;
    const isSub = summary.isSubagent ?? isSubagentPath(path);
    // Tokens and tools always count.
    agg.inputTokens += summary.inputTokens || 0;
    agg.outputTokens += summary.outputTokens || 0;
    agg.cacheReadTokens += summary.cacheReadTokens || 0;
    agg.cacheWriteTokens += summary.cacheWriteTokens || 0;
    agg.toolCalls += summary.toolCalls || 0;
    for (const [name, count] of Object.entries(summary.toolBreakdown || {})) {
      agg.toolBreakdown[name] = (agg.toolBreakdown[name] || 0) + count;
    }
    for (const f of summary.files || []) fileSet.add(f);
    // Lines/cost from this transcript roll up regardless of subagent vs top-level
    // — they represent real work done by Claude.
    agg.linesAdded += summary.linesAdded || 0;
    agg.linesRemoved += summary.linesRemoved || 0;
    agg.estimatedCost += summary.cost || 0;
    for (const [m, v] of Object.entries(summary.costByModel || {})) {
      agg.costByModel[m] = (agg.costByModel[m] || 0) + v;
    }
    for (const [m, v] of Object.entries(summary.modelsUsed || {})) {
      agg.modelsUsed[m] = (agg.modelsUsed[m] || 0) + v;
    }
    for (const [m, v] of Object.entries(summary.byModel || {})) {
      const t = agg.byModel[m] ||= { turns: 0, tokens: 0, cost: 0 };
      t.turns += v.turns || 0;
      t.tokens += v.tokens || 0;
      t.cost += v.cost || 0;
    }
    for (const [f, t] of Object.entries(summary.fileEditTs || {})) {
      if (t > (agg.fileEditTs[f] || 0)) agg.fileEditTs[f] = t;
    }
    for (const [c, n] of Object.entries(summary.bashCommands || {})) {
      agg.bashCommands[c] = (agg.bashCommands[c] || 0) + n;
    }
    for (const [d, n] of Object.entries(summary.webDomains || {})) {
      agg.webDomains[d] = (agg.webDomains[d] || 0) + n;
    }
    for (const [k, n] of Object.entries(summary.subagents || {})) {
      agg.subagents[k] = (agg.subagents[k] || 0) + n;
    }
    if (isSub) {
      agg.subagentRuns += 1;
      // Subagents still contribute tokens/tools/lines/cost to per-day/week/hour buckets.
      const mergeSubBuckets = (srcMap, destMap) => {
        for (const [k, src] of Object.entries(srcMap || {})) {
          const target = destMap[k] ||= blankDay();
          target.inputTokens += src.inputTokens || 0;
          target.outputTokens += src.outputTokens || 0;
          target.cacheReadTokens += src.cacheReadTokens || 0;
          target.cacheWriteTokens += src.cacheWriteTokens || 0;
          target.toolCalls += src.toolCalls || 0;
          target.linesAdded += src.linesAdded || 0;
          target.linesRemoved += src.linesRemoved || 0;
          target.cost += src.cost || 0;
        }
      };
      mergeSubBuckets(summary.byDay, agg.byDay);
      mergeSubBuckets(summary.byWeek, agg.byWeek);
      mergeSubBuckets(summary.byHour, agg.byHour);
      // Subagent file edits also count toward hotspots.
      for (const [f, n] of Object.entries(summary.fileEdits || {})) {
        agg.fileEdits[f] = (agg.fileEdits[f] || 0) + n;
      }
    } else {
      // Top-level sessions only — these are the real "chats".
      agg.sessions += 1;
      agg.userMessages += summary.userMessages || 0;
      agg.activeMs += summary.activeMs || 0;
      if (summary.firstTs && summary.lastTs) agg.wallMs += summary.lastTs - summary.firstTs;
      if (summary.project) {
        const p = agg.projects[summary.project] = agg.projects[summary.project] || {
          sessions: 0, activeMs: 0, inputTokens: 0, outputTokens: 0, userMessages: 0, toolCalls: 0,
          linesAdded: 0, linesRemoved: 0, cost: 0,
        };
        p.sessions += 1;
        p.activeMs += summary.activeMs || 0;
        p.inputTokens += summary.inputTokens || 0;
        p.outputTokens += summary.outputTokens || 0;
        p.userMessages += summary.userMessages || 0;
        p.toolCalls += summary.toolCalls || 0;
        p.linesAdded += summary.linesAdded || 0;
        p.linesRemoved += summary.linesRemoved || 0;
        p.cost += summary.cost || 0;
      }
      if (summary.firstTs) agg.firstTs = agg.firstTs ? Math.min(agg.firstTs, summary.firstTs) : summary.firstTs;
      if (summary.lastTs) agg.lastTs = agg.lastTs ? Math.max(agg.lastTs, summary.lastTs) : summary.lastTs;
      // Full per-day/week/hour merge for top-level sessions.
      for (const [k, day] of Object.entries(summary.byDay || {})) {
        mergeDay(agg.byDay[k] ||= blankDay(), day);
      }
      for (const [k, w] of Object.entries(summary.byWeek || {})) {
        mergeDay(agg.byWeek[k] ||= blankDay(), w);
      }
      for (const [k, h] of Object.entries(summary.byHour || {})) {
        mergeDay(agg.byHour[k] ||= blankDay(), h);
      }
      // Bump session count on the day, week, and hour where the session started.
      if (summary.firstTs) {
        (agg.byDay[dayKey(summary.firstTs)]   ||= blankDay()).sessions += 1;
        (agg.byWeek[weekKey(summary.firstTs)] ||= blankDay()).sessions += 1;
        (agg.byHour[hourKey(summary.firstTs)] ||= blankDay()).sessions += 1;
      }
      // File hotspots — top-level sessions.
      for (const [f, n] of Object.entries(summary.fileEdits || {})) {
        agg.fileEdits[f] = (agg.fileEdits[f] || 0) + n;
      }
    }
  }
  agg.uniqueFiles = fileSet.size;

  // Derived: streak (consecutive days with activity ending today or yesterday),
  // longest streak, days since first, best day.
  const days = Object.keys(agg.byDay).sort();
  if (days.length) {
    // Best day by activeMs.
    let best = null;
    for (const k of days) {
      const d = agg.byDay[k];
      if (!best || d.activeMs > best.activeMs) best = { day: k, ...d };
    }
    agg.bestDay = best;

    // Days since first — computed on DST-immune calendar day indices.
    const now = new Date();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayNum = dayNum(now.getFullYear(), now.getMonth(), now.getDate());
    agg.daysSinceFirst = todayNum - dayKeyNum(days[0]) + 1;

    // Current streak: walk back from today.
    const has = (offset) => {
      const d = new Date(today);
      d.setDate(d.getDate() - offset);
      return !!agg.byDay[dayKey(d)];
    };
    let streak = 0;
    let offset = has(0) ? 0 : 1; // if no activity today, start from yesterday
    while (has(offset)) { streak += 1; offset += 1; }
    agg.streak = streak;

    // Longest streak across all history.
    let longest = 0;
    let run = 0;
    let prev = null;
    for (const k of days) {
      if (prev) {
        const diff = dayKeyNum(k) - dayKeyNum(prev);
        run = diff === 1 ? run + 1 : 1;
      } else {
        run = 1;
      }
      if (run > longest) longest = run;
      prev = k;
    }
    agg.longestStreak = longest;
  }

  // Peak hour-of-day across all-time (by activeMs).
  const hourEntries = Object.entries(agg.byHour);
  if (hourEntries.length) {
    let bestHour = null;
    for (const [h, data] of hourEntries) {
      if (!bestHour || data.activeMs > bestHour.activeMs) bestHour = { hour: Number(h), ...data };
    }
    agg.peakHour = bestHour;
  }

  // Top edited files (paths + counts), descending. Carries last-edit time and
  // age in days so the dashboard / insights can flag a hotspot cooling off.
  const nowMs = Date.now();
  agg.topEditedFiles = Object.entries(agg.fileEdits)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([path, count]) => {
      const lastTs = agg.fileEditTs[path] || 0;
      return {
        path,
        count,
        lastEditedTs: lastTs || null,
        daysSinceLastEdit: lastTs ? Math.floor((nowMs - lastTs) / 86_400_000) : null,
      };
    });

  // Model split — per pricing key, sorted by cost. Each entry carries its share
  // of total cost so the dashboard / card can show "Sonnet · 61% of spend".
  const splitCostTotal = Object.values(agg.byModel).reduce((s, v) => s + (v.cost || 0), 0);
  const splitTokenTotal = Object.values(agg.byModel).reduce((s, v) => s + (v.tokens || 0), 0);
  agg.modelSplit = Object.entries(agg.byModel)
    .map(([model, v]) => ({
      model,
      turns: v.turns || 0,
      tokens: v.tokens || 0,
      cost: v.cost || 0,
      costPct: splitCostTotal > 0 ? (v.cost || 0) / splitCostTotal : 0,
      tokenPct: splitTokenTotal > 0 ? (v.tokens || 0) / splitTokenTotal : 0,
    }))
    .sort((a, b) => b.cost - a.cost);

  // Languages: bucket file edits by extension via languages.js.
  for (const [path, count] of Object.entries(agg.fileEdits)) {
    const lang = languageOf(path);
    if (!lang) continue;
    const bucket = agg.languages[lang] = agg.languages[lang] || { files: 0, edits: 0 };
    bucket.files += 1;
    bucket.edits += count;
  }

  // MCP vs built-in tool split. mcp__server__action → MCP, everything else built-in.
  for (const [name, count] of Object.entries(agg.toolBreakdown || {})) {
    if (name.startsWith('mcp__')) agg.mcpToolCalls += count;
    else agg.builtinToolCalls += count;
  }

  // Day-of-week fold (Sun=0..Sat=6). Aggregates active time + prompts.
  for (const [k, day] of Object.entries(agg.byDay)) {
    const d = new Date(k + 'T00:00:00');
    const wd = d.getDay();
    const target = agg.byWeekday[wd] ||= blankDay();
    mergeDay(target, day);
  }

  // Folded line totals.
  agg.linesNet = (agg.linesAdded || 0) - (agg.linesRemoved || 0);

  // Notifications from the hook-side append log.
  const notifByDay = readNotificationsByDay();
  let notifTotal = 0;
  for (const [k, n] of Object.entries(notifByDay)) {
    const d = agg.byDay[k] ||= blankDay();
    d.notifications = (d.notifications || 0) + n;
    notifTotal += n;
  }
  agg.notifications = notifTotal;

  return agg;
}

// Known alternate locations Claude Code transcripts could live in besides
// ~/.claude/projects. Returned filtered to those that actually exist. Most
// installs only use the default; this is for older Claude Code versions,
// XDG-strict setups, or restored backups.
export function discoverAltProjectDirs() {
  const home = homedir();
  const candidates = [
    join(home, '.config', 'claude', 'projects'),
    join(home, '.local', 'share', 'claude', 'projects'),
    join(home, 'AppData', 'Roaming', 'claude', 'projects'),
    join(home, 'AppData', 'Local', 'claude', 'projects'),
    join(home, 'Library', 'Application Support', 'claude', 'projects'),
  ];
  return candidates.filter((p) => existsSync(p) && p !== CLAUDE_PROJECTS);
}

// Incremental scan: re-parse only changed files. Returns {aggregate, scanned, skipped, removed}.
//
// Accepts either:
//   { projectsDir: '/path' }       — single root (legacy)
//   { projectsDirs: ['a', 'b'] }   — multi-root (backfill/import)
// When neither is set, defaults to [CLAUDE_PROJECTS, ...discoverAltProjectDirs()].
// Auto-discovery is cheap (existsSync per known location) so it runs every
// scan — a freshly-restored backup at one of the alt paths gets picked up
// without any user action.
export function scan({ projectsDir, projectsDirs, onProgress, force = false, extraDirs = [] } = {}) {
  const dirs = [];
  if (projectsDirs && projectsDirs.length) dirs.push(...projectsDirs);
  else if (projectsDir) dirs.push(projectsDir);
  else {
    dirs.push(CLAUDE_PROJECTS);
    dirs.push(...discoverAltProjectDirs());
  }
  for (const d of extraDirs) if (!dirs.includes(d)) dirs.push(d);

  const cache = readCache();
  cache.files = cache.files || {};
  const seen = new Set();
  const transcripts = listAllTranscripts(dirs);
  let scanned = 0;
  let skipped = 0;
  for (const fp of transcripts) {
    seen.add(fp);
    let st;
    try { st = statSync(fp); } catch { continue; }
    const sig = `${st.mtimeMs}:${st.size}`;
    if (!force && cache.files[fp]?._sig === sig) {
      skipped += 1;
      continue;
    }
    try {
      // Hand the prior entry to parseTranscript so an active session's
      // growing transcript parses only its appended tail (force = from scratch).
      const summary = parseTranscript(fp, force ? null : cache.files[fp]);
      summary._sig = sig;
      summary.isSubagent = isSubagentPath(fp);
      cache.files[fp] = summary;
      scanned += 1;
      if (onProgress) onProgress({ scanned, skipped, total: transcripts.length, file: fp });
    } catch (e) {
      // skip corrupt file but keep prior cache entry
    }
  }
  // Remove cache entries for transcripts that disappeared from disk. Only
  // wipe entries whose root is one of the dirs we just scanned — otherwise
  // a one-off backfill against a subset of dirs would nuke cache for
  // unrelated paths.
  let removed = 0;
  const sep = process.platform === 'win32' ? '\\' : '/';
  const dirPrefixes = dirs.map((d) => d.replace(/[/\\]+$/, '') + sep);
  for (const key of Object.keys(cache.files)) {
    if (seen.has(key)) continue;
    if (dirPrefixes.some((p) => key.startsWith(p))) {
      delete cache.files[key];
      removed += 1;
    }
  }
  const changed = scanned > 0 || removed > 0;
  if (changed) {
    writeCache(cache);
  } else {
    // Nothing parsed, nothing removed — the cache on disk is byte-identical,
    // so skip rewriting it (it can be tens of MB) AND skip the aggregate
    // recompute, UNLESS the local day has rolled since the aggregate was
    // generated: streak / daysSinceFirst / hotspot-aging are derived from
    // "today" and go stale at midnight even with no new data.
    const existing = readAggregate();
    if (existing && existing._v === CACHE_VERSION
        && dayKey(existing.generatedAt || 0) === dayKey(Date.now())) {
      return { aggregate: existing, scanned, skipped, removed, total: transcripts.length, dirs };
    }
  }
  const aggregate = aggregateFrom(cache);
  writeAggregate(aggregate);
  return { aggregate, scanned, skipped, removed, total: transcripts.length, dirs };
}
