// MCP server mode — exposes your own Claude Code stats as MCP tools so you can
// ask Claude, mid-session, "how long have I worked today?" / "what's my top
// file this week?" / "am I over budget?". Minimal newline-delimited JSON-RPC
// over stdio (no SDK dep). Wire it into Claude Code as an MCP server:
//   claude mcp add claude-rpc -- claude-rpc mcp
//
// The tool HANDLERS are pure functions of an aggregate, so they're unit-tested
// without standing up the transport.

import { readAggregate, dayKey } from './scanner.js';
import { VERSION } from './version.js';

function fmtH(ms) { const h = (ms || 0) / 3_600_000; return h < 1 ? `${Math.round(h * 60)}m` : `${h.toFixed(1)}h`; }
function fmtN(n) {
  if (!n) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1e3).toFixed(1)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(2)}M`;
  return `${(n / 1e9).toFixed(2)}B`;
}

// ── Tool handlers — pure(aggregate) → string. Exported for tests. ──────────
export const TOOLS = {
  get_lifetime_stats: {
    description: 'Overall all-time Claude Code stats: active hours, sessions, current/longest streak, total tokens, estimated cost, top language.',
    handler(agg) {
      const tokens = (agg.inputTokens || 0) + (agg.outputTokens || 0) + (agg.cacheReadTokens || 0) + (agg.cacheWriteTokens || 0);
      const lang = Object.entries(agg.languages || {}).sort((a, b) => (b[1].edits || 0) - (a[1].edits || 0))[0];
      return [
        `Active time:   ${fmtH(agg.activeMs)}`,
        `Sessions:      ${fmtN(agg.sessions || 0)}`,
        `Streak:        ${agg.streak || 0} days (best ${agg.longestStreak || 0})`,
        `Prompts:       ${fmtN(agg.userMessages || 0)}`,
        `Tokens:        ${fmtN(tokens)}`,
        `Est. cost:     $${(agg.estimatedCost || 0).toFixed(2)}`,
        `Top language:  ${lang ? `${lang[0]} (${fmtN(lang[1].edits)} edits)` : '—'}`,
        `Since:         day ${agg.daysSinceFirst || 0}`,
      ].join('\n');
    },
  },
  get_today: {
    description: "Today's Claude Code activity: active hours, prompts, tool calls, tokens, estimated cost.",
    handler(agg) {
      // Key by LOCAL date via the same dayKey the scanner uses to WRITE byDay
      // (and format.js uses to read it). A UTC slice here silently surfaced the
      // wrong/empty bucket for anyone not on UTC once local and UTC dates split.
      const today = (agg.byDay || {})[dayKey(Date.now())] || {};
      const tokens = (today.inputTokens || 0) + (today.outputTokens || 0) + (today.cacheReadTokens || 0) + (today.cacheWriteTokens || 0);
      return [
        `Active time:  ${fmtH(today.activeMs)}`,
        `Prompts:      ${today.userMessages || 0}`,
        `Tool calls:   ${today.toolCalls || 0}`,
        `Tokens:       ${fmtN(tokens)}`,
        `Est. cost:    $${(today.cost || 0).toFixed(2)}`,
      ].join('\n');
    },
  },
  get_top_files: {
    description: 'Most-edited files all-time, with edit counts and how long since each was last touched.',
    handler(agg) {
      const list = (agg.topEditedFiles || []).slice(0, 10);
      if (!list.length) return 'No edited files recorded yet.';
      return list.map((f, i) => {
        const name = String(f.path || '').replace(/\\/g, '/').split('/').pop();
        const age = f.daysSinceLastEdit == null ? '' : f.daysSinceLastEdit === 0 ? ' · today' : ` · ${f.daysSinceLastEdit}d ago`;
        return `${i + 1}. ${name} — ${f.count} edits${age}`;
      }).join('\n');
    },
  },
  get_model_split: {
    description: 'Per-model breakdown of spend, tokens, and turns across all of Claude Code history.',
    handler(agg) {
      const split = agg.modelSplit || [];
      if (!split.length) return 'No model usage recorded yet.';
      return split.map((m) => `${m.model}: $${(m.cost || 0).toFixed(2)} (${Math.round((m.costPct || 0) * 100)}%) · ${fmtN(m.tokens)} tokens · ${m.turns} turns`).join('\n');
    },
  },
};

// Build a tools/list payload from the registry.
export function toolList() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }));
}

/**
 * Dispatch a tools/call by name. Reads a fresh aggregate per call (cheap).
 * @param {string} name - Tool name (a key of TOOLS).
 * @param {() => object} [getAgg] - Aggregate provider; defaults to readAggregate (injectable for tests).
 * @returns {string} The tool's text result.
 * @throws {Error} If the tool name is unknown.
 */
export function callTool(name, getAgg = readAggregate) {
  const t = TOOLS[name];
  if (!t) throw new Error(`unknown tool: ${name}`);
  const agg = getAgg();
  // No aggregate at all (fresh install / standalone MCP / scanner never ran):
  // a `|| {}` here would render all-zeros, indistinguishable from a genuinely
  // idle day. Surface the same hint every other surface uses instead.
  if (agg == null) return 'No stats yet — run `claude-rpc scan` to build your history.';
  return t.handler(agg);
}

/**
 * stdio JSON-RPC transport (newline-delimited). Wires the MCP protocol methods
 * (initialize, tools/list, tools/call, ping) to the tool handlers.
 * @param {{input?: NodeJS.ReadableStream, output?: {write: (s: string) => void}}} [io]
 *   Streams to read requests from / write responses to. Defaults to process stdio;
 *   injectable for tests.
 * @returns {void}
 */
export function runMcpServer({ input = process.stdin, output = process.stdout } = {}) {
  let buf = '';
  const MAX_BUF = 4 * 1024 * 1024; // hard cap on a single un-terminated line
  const DEFAULT_PROTOCOL = '2024-11-05';
  const SUPPORTED_PROTOCOLS = new Set([DEFAULT_PROTOCOL, '2025-03-26', '2025-06-18']);
  const send = (msg) => output.write(JSON.stringify(msg) + '\n');
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const replyErr = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  function handle(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
      // Echo the client's protocol version when we recognize it; otherwise fall
      // back to our baseline (our surface — initialize/tools/*/ping — is stable
      // across these revisions).
      const requested = params?.protocolVersion;
      return reply(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'claude-rpc', version: VERSION },
      });
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return; // notifications: no reply
    if (method === 'tools/list') return reply(id, { tools: toolList() });
    if (method === 'tools/call') {
      const name = params?.name;
      // "No such tool" is a protocol error, not a tool that ran and failed —
      // validate before dispatch so we don't conflate the two (or leak the
      // literal "undefined" when params.name is omitted).
      if (!name) return replyErr(id, -32602, 'missing tool name');
      if (!TOOLS[name]) return replyErr(id, -32602, `unknown tool: ${name}`);
      try {
        const text = callTool(name);
        return reply(id, { content: [{ type: 'text', text }], isError: false });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    if (method === 'ping') return reply(id, {});
    if (id !== undefined) replyErr(id, -32601, `method not found: ${method}`);
  }

  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      try { handle(msg); } catch (e) { process.stderr.write(`mcp handler error: ${e.message}\n`); }
    }
    // A single line larger than the cap (no newline yet) would grow buf without
    // bound — drop the partial and resync on the next newline.
    if (buf.length > MAX_BUF) {
      process.stderr.write(`mcp: dropping oversized line (>${MAX_BUF} bytes)\n`);
      buf = '';
    }
  });
  input.on('end', () => process.exit(0));
  input.on('error', () => process.exit(0));
  process.stderr.write(`claude-rpc MCP server v${VERSION} ready (stdio)\n`);
}
