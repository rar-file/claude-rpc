// claude-rpc Discord bot — runs on our own server as a systemd service
// (bot/claude-rpc-bot.service), NOT in the npm package (package.json `files`
// is an allowlist that excludes bot/). Zero dependencies: Node's built-in
// WebSocket + fetch.
//
// It holds a real gateway connection (so it shows online), serves the OS-role
// buttons over INTERACTION_CREATE, keeps one permanent invite per source and
// attributes joins by invite-use deltas, and posts the weekly leaderboard +
// growth summary. The totals worker keeps serving /discord (redirect + click
// counts) from KV; this process mirrors invite codes and join counts into that
// KV through Cloudflare's API so the two stay in step.
//
// Env: DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, CLOUDFLARE_API_TOKEN (KV mirror),
//      optional BOT_STATE (default ./state.json).

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD = process.env.DISCORD_GUILD_ID || '1564964247589355551';
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_ACCOUNT = 'ed1c11fc244524eda6fa839672ecfd7a';
const CF_KV = '6ca3b87cd4cc46469008d28558701dac';
const WORKER = 'https://claude-rpc-totals.claude-rpc.workers.dev';
const STATE_PATH = process.env.BOT_STATE || join(HERE, 'state.json');
const OS_ROLES = ['1564966622261673995', '1564966694491783228', '1564966760841740369']; // Windows, macOS, Linux
const SOURCES = ['site', 'readme', 'cli', 'npm', 'wrapped', 'card', 'vscode', 'github', 'get', 'other'];
const API = 'https://discord.com/api/v10';

if (!TOKEN) { console.error('DISCORD_BOT_TOKEN is not set'); process.exit(1); }
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ── state (atomic write) ────────────────────────────────────────────────
let state = { invites: {}, uses: {}, joins: {}, lastWeekly: '' };
try { if (existsSync(STATE_PATH)) state = { ...state, ...JSON.parse(readFileSync(STATE_PATH, 'utf8')) }; } catch { /* start fresh */ }
function save() {
  writeFileSync(STATE_PATH + '.tmp', JSON.stringify(state, null, 2));
  renameSync(STATE_PATH + '.tmp', STATE_PATH);
}

// ── REST ────────────────────────────────────────────────────────────────
async function dapi(method, path, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429) { const j = await res.json().catch(() => ({})); await sleep((j.retry_after || 1) * 1000 + 100); continue; }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)?.slice(0, 200)}`);
    return data;
  }
  throw new Error(`${method} ${path} → rate limited`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Cloudflare KV mirror (so the worker's /discord redirect + stats follow) ──
async function kv(method, key, value) {
  if (!CF_TOKEN) return null;
  const base = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/storage/kv/namespaces/${CF_KV}`;
  const res = await fetch(`${base}/values/${encodeURIComponent(key)}`, {
    method, headers: { Authorization: `Bearer ${CF_TOKEN}` }, body: method === 'PUT' ? String(value) : undefined,
  });
  return method === 'GET' ? (res.ok ? await res.text() : null) : res.ok;
}
async function kvList(prefix) {
  if (!CF_TOKEN) return [];
  const base = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/storage/kv/namespaces/${CF_KV}`;
  const res = await fetch(`${base}/keys?prefix=${encodeURIComponent(prefix)}&limit=1000`, { headers: { Authorization: `Bearer ${CF_TOKEN}` } });
  return res.ok ? (await res.json()).result.map((k) => k.name) : [];
}

// One-time adoption of what the (now retired) worker cron already created, so
// existing invites, baselines and join counts carry over instead of resetting.
async function adoptFromKv() {
  if (Object.keys(state.invites).length) return;
  for (const name of await kvList('dcinv:')) { const code = await kv('GET', name); if (code) state.invites[name.slice(6)] = code; }
  try { state.uses = JSON.parse((await kv('GET', 'dc:uses')) || '{}'); } catch { /* none */ }
  for (const name of await kvList('dcjoin:')) state.joins[name.slice(7)] = Number(await kv('GET', name)) || 0;
  save();
  log('adopted from KV:', Object.keys(state.invites).length, 'invites');
}

// ── invites + join attribution ─────────────────────────────────────────
async function channelId(name) {
  return (await dapi('GET', `/guilds/${GUILD}/channels`)).find((c) => c.name === name)?.id || null;
}

async function ensureInvites() {
  const welcome = await channelId('welcome');
  for (const src of SOURCES) {
    if (state.invites[src] || !welcome) continue;
    try {
      const inv = await dapi('POST', `/channels/${welcome}/invites`, { max_age: 0, max_uses: 0, unique: true });
      state.invites[src] = inv.code; save();
      await kv('PUT', `dcinv:${src}`, inv.code);
    } catch (e) { log('invite create failed for', src, e.message); }
  }
}

async function syncJoins() {
  const byCode = Object.fromEntries(Object.entries(state.invites).map(([s, c]) => [c, s]));
  const invites = await dapi('GET', `/guilds/${GUILD}/invites`);
  const fresh = Object.keys(state.uses).length === 0;
  const next = {}, deltas = {};
  for (const inv of invites) {
    next[inv.code] = inv.uses;
    const prev = state.uses[inv.code];
    if (prev === undefined) { if (!fresh && byCode[inv.code] && inv.uses > 0) deltas[byCode[inv.code]] = (deltas[byCode[inv.code]] || 0) + inv.uses; continue; }
    if (inv.uses > prev) {
      const src = byCode[inv.code] || 'other-invite';
      deltas[src] = (deltas[src] || 0) + (inv.uses - prev);
    }
  }
  const changed = JSON.stringify(next) !== JSON.stringify(state.uses);
  state.uses = next;
  for (const [src, n] of Object.entries(deltas)) {
    state.joins[src] = (state.joins[src] || 0) + n;
    log(`join(s) via ${src}: +${n} (total ${state.joins[src]})`);
    await kv('PUT', `dcjoin:${src}`, state.joins[src]);
  }
  if (changed) save();
}

async function mirrorMembers() {
  try { const g = await dapi('GET', `/guilds/${GUILD}?with_counts=true`); await kv('PUT', 'dc:members', g.approximate_member_count); } catch { /* best-effort */ }
}

// ── weekly posts (Mon 15:00 UTC) ───────────────────────────────────────
const fmt = (n) => n >= 1e12 ? (n / 1e12).toFixed(2) + 'T' : n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
async function weekly(now = new Date()) {
  if (!(now.getUTCDay() === 1 && now.getUTCHours() === 15)) return;
  const day = now.toISOString().slice(0, 10);
  if (state.lastWeekly === day) return;
  state.lastWeekly = day; save();
  const lb = await channelId('leaderboard');
  const board = (await (await fetch(`${WORKER}/leaderboard?limit=10`)).json()).leaderboard || [];
  if (lb && board.length) {
    const medals = ['🥇', '🥈', '🥉'];
    const lines = board.map((e, i) => `${medals[i] || `**${i + 1}.**`} [${e.displayName || e.handle}](https://claude-rpc.com/u/${encodeURIComponent(e.handle)}) · ${fmt(e.tokens)} tokens · ${e.sessions} sessions`);
    await dapi('POST', `/channels/${lb}/messages`, { embeds: [{ title: 'Weekly leaderboard — top 10', description: lines.join('\n'), color: 0xd97757, url: 'https://claude-rpc.com/leaderboard' }] });
  }
  const mod = await channelId('mod-updates');
  if (mod) {
    const stats = await (await fetch(`${WORKER}/discord.json`)).json();
    const row = (o) => Object.entries(o || {}).filter(([, v]) => v).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—';
    await dapi('POST', `/channels/${mod}/messages`, { embeds: [{ title: 'Weekly growth', color: 0x5865f2, fields: [
      { name: 'Members', value: String(stats.members ?? '?') },
      { name: 'Join clicks by source', value: row(stats.clicks) },
      { name: 'Joins by source', value: row(state.joins) },
    ] }] });
  }
}

// ── interactions (OS role buttons) ─────────────────────────────────────
async function onInteraction(i) {
  const respond = (content) => dapi('POST', `/interactions/${i.id}/${i.token}/callback`, { type: 4, data: { content, flags: 64 } });
  if (i.type !== 3 || !/^role:\d+$/.test(i.data?.custom_id || '')) return respond('Unsupported.');
  const roleId = i.data.custom_id.slice(5);
  if (!OS_ROLES.includes(roleId)) return respond('That role is not self-assignable.');
  const userId = i.member?.user?.id;
  if (!userId) return respond('Use this in the server.');
  const has = (i.member.roles || []).includes(roleId);
  try {
    await dapi(has ? 'DELETE' : 'PUT', `/guilds/${i.guild_id}/members/${userId}/roles/${roleId}`);
    await respond(has ? 'Role removed.' : 'Role added.');
  } catch (e) {
    log('role toggle failed:', e.message);
    await respond('I could not change that role — an admin needs to move my role above the OS roles.');
  }
}

// ── gateway ────────────────────────────────────────────────────────────
const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
let ws, seq = null, sessionId = null, resumeUrl = null, hbTimer = null, acked = true, backoff = 1000;

async function connect() {
  let url = resumeUrl;
  if (!url) url = (await dapi('GET', '/gateway/bot')).url;
  ws = new WebSocket(`${url}/?v=10&encoding=json`);
  ws.addEventListener('message', (ev) => { try { onFrame(JSON.parse(ev.data)); } catch (e) { log('frame error:', e.message); } });
  ws.addEventListener('close', (ev) => {
    clearInterval(hbTimer);
    log('gateway closed', ev.code);
    if (FATAL.has(ev.code)) { log('fatal gateway close — exiting'); process.exit(1); }
    if (ev.code === 4007 || ev.code === 4009) { sessionId = null; resumeUrl = null; }
    setTimeout(() => connect().catch((e) => log('reconnect failed:', e.message)), backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });
  ws.addEventListener('error', () => { /* 'close' follows */ });
}

function send(op, d) { ws.send(JSON.stringify({ op, d })); }

function onFrame({ op, d, s, t }) {
  if (s != null) seq = s;
  if (op === 10) {                                    // HELLO
    clearInterval(hbTimer); acked = true;
    setTimeout(() => { send(1, seq); hbTimer = setInterval(() => {
      if (!acked) { log('heartbeat not acked — reconnecting'); try { ws.close(4000); } catch { /* gone */ } return; }
      acked = false; send(1, seq);
    }, d.heartbeat_interval); }, d.heartbeat_interval * Math.random());
    if (sessionId) send(6, { token: TOKEN, session_id: sessionId, seq });
    else send(2, { token: TOKEN, intents: 1 /* GUILDS only — no privileged intents */,
      properties: { os: 'linux', browser: 'claude-rpc-bot', device: 'claude-rpc-bot' },
      presence: { status: 'online', afk: false, activities: [{ name: 'claude-rpc.com', type: 3 }] } });
  } else if (op === 11) acked = true;
  else if (op === 1) send(1, seq);
  else if (op === 7) { try { ws.close(4000); } catch { /* gone */ } }
  else if (op === 9) { if (!d) { sessionId = null; resumeUrl = null; } try { ws.close(4000); } catch { /* gone */ } }
  else if (op === 0) {
    if (t === 'READY') { sessionId = d.session_id; resumeUrl = d.resume_gateway_url; backoff = 1000; log('gateway ready as', d.user.username); }
    else if (t === 'INTERACTION_CREATE') onInteraction(d).catch((e) => log('interaction error:', e.message));
  }
}

// ── main ───────────────────────────────────────────────────────────────
await adoptFromKv();
await ensureInvites().catch((e) => log('ensureInvites:', e.message));
await connect();
const safe = (fn, name) => () => fn().catch((e) => log(`${name} failed:`, e.message));
setInterval(safe(syncJoins, 'syncJoins'), 60_000);
setInterval(safe(weekly, 'weekly'), 60_000);
setInterval(safe(mirrorMembers, 'mirrorMembers'), 15 * 60_000);
safe(syncJoins, 'syncJoins')();
safe(mirrorMembers, 'mirrorMembers')();
process.on('SIGTERM', () => { log('SIGTERM'); try { save(); } catch { /* ok */ } process.exit(0); });
