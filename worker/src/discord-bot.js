// The claude-rpc Discord bot, hosted inside the totals worker. REST + cron +
// interactions only — no gateway connection, so nothing runs between events.
//
//   POST /discord/interactions   OS-role buttons (Ed25519-verified)
//   GET  /discord.json           public aggregate: clicks, joins by source, members
//   cron (*/15)                  per-source invites, join attribution by invite
//                                use-count deltas, weekly leaderboard + stats posts
//
// Secrets/vars: DISCORD_BOT_TOKEN (secret), DISCORD_PUBLIC_KEY, DISCORD_GUILD_ID,
// DISCORD_OS_ROLES (comma-separated role ids the buttons may toggle).
// KV: dcinv:<src> → invite code; dc:uses → {code: lastUses}; dcjoin:<src> → joins.

const API = 'https://discord.com/api/v10';
export const INVITE_SOURCES = ['site', 'readme', 'cli', 'npm', 'wrapped', 'card', 'vscode', 'github', 'get', 'other'];
const WEEK_KEY = 'dc:lastweekly';

export async function dapi(env, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`discord ${method} ${path} → ${res.status} ${JSON.stringify(data)?.slice(0, 200)}`);
  return data;
}

const hex = (s) => Uint8Array.from(s.match(/../g) || [], (b) => parseInt(b, 16));

export async function verifySignature(rawBody, signature, timestamp, publicKeyHex) {
  try {
    const key = await crypto.subtle.importKey('raw', hex(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, hex(signature), new TextEncoder().encode(timestamp + rawBody));
  } catch { return false; }
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export async function handleInteractions(request, env) {
  const raw = await request.text();
  const ok = await verifySignature(raw, request.headers.get('x-signature-ed25519') || '',
    request.headers.get('x-signature-timestamp') || '', env.DISCORD_PUBLIC_KEY || '');
  if (!ok) return new Response('bad signature', { status: 401 });
  const i = JSON.parse(raw);
  if (i.type === 1) return json({ type: 1 });                                   // PING
  if (i.type === 3 && /^role:\d+$/.test(i.data?.custom_id || '')) {             // button
    const roleId = i.data.custom_id.slice(5);
    const allowed = String(env.DISCORD_OS_ROLES || '').split(',').filter(Boolean);
    const reply = (content) => json({ type: 4, data: { content, flags: 64 } });
    if (!allowed.includes(roleId)) return reply('That role is not self-assignable.');
    const userId = i.member?.user?.id;
    if (!userId) return reply('Use this in the server.');
    const has = (i.member.roles || []).includes(roleId);
    try {
      await dapi(env, has ? 'DELETE' : 'PUT', `/guilds/${i.guild_id}/members/${userId}/roles/${roleId}`);
      return reply(has ? 'Role removed.' : 'Role added.');
    } catch {
      return reply('I could not change that role — an admin needs to move my role above the OS roles.');
    }
  }
  return json({ type: 4, data: { content: 'Unsupported.', flags: 64 } });
}

async function channelByName(env, name) {
  const chans = await dapi(env, 'GET', `/guilds/${env.DISCORD_GUILD_ID}/channels`);
  return chans.find((c) => c.name === name)?.id || null;
}

async function readUses(env) {
  try { return JSON.parse((await env.TOTALS.get('dc:uses')) || '{}'); } catch { return {}; }
}

// Make sure every source has its own permanent invite, then turn use-count
// growth into per-source join counts. A new invite is baselined at its current
// uses (0), so only joins after creation are counted.
export async function syncInvites(env) {
  const guild = env.DISCORD_GUILD_ID;
  const welcome = await channelByName(env, 'welcome');
  const byCode = {};
  for (const src of INVITE_SOURCES) {
    let code = await env.TOTALS.get(`dcinv:${src}`);
    if (!code && welcome) {
      const inv = await dapi(env, 'POST', `/channels/${welcome}/invites`, { max_age: 0, max_uses: 0, unique: true });
      code = inv.code;
      await env.TOTALS.put(`dcinv:${src}`, code);
    }
    if (code) byCode[code] = src;
  }
  const invites = await dapi(env, 'GET', `/guilds/${guild}/invites`);
  const last = await readUses(env);
  const next = {};
  const deltas = {};
  let changed = false;
  for (const inv of invites) {
    const prev = last[inv.code];
    next[inv.code] = inv.uses;
    if (prev === undefined) {
      changed = true;   // first sighting: baseline it; our own invites count any uses they already have
      const own = byCode[inv.code];
      if (own && inv.uses > 0) deltas[own] = (deltas[own] || 0) + inv.uses;
      continue;
    }
    if (inv.uses > prev) {
      const src = byCode[inv.code] || (inv.code === env.DISCORD_INVITE?.split('/').pop() ? 'manual' : 'other-invite');
      deltas[src] = (deltas[src] || 0) + (inv.uses - prev);
      changed = true;
    }
  }
  for (const [src, n] of Object.entries(deltas)) {
    const cur = Number(await env.TOTALS.get(`dcjoin:${src}`)) || 0;
    await env.TOTALS.put(`dcjoin:${src}`, String(cur + n));
  }
  if (changed || Object.keys(next).length !== Object.keys(last).length) await env.TOTALS.put('dc:uses', JSON.stringify(next));
  return deltas;
}

export async function discordStats(env) {
  const clicks = {}, joins = {};
  const refs = await env.TOTALS.list({ prefix: 'ref:dc-' });
  for (const { name } of refs.keys) clicks[name.slice(7)] = Number(await env.TOTALS.get(name)) || 0;
  const js = await env.TOTALS.list({ prefix: 'dcjoin:' });
  for (const { name } of js.keys) joins[name.slice(7)] = Number(await env.TOTALS.get(name)) || 0;
  let members = null;
  try { members = (await dapi(env, 'GET', `/guilds/${env.DISCORD_GUILD_ID}?with_counts=true`)).approximate_member_count; } catch { /* bot not in guild yet */ }
  return { clicks, joins, members, ts: Date.now() };
}

export async function handleDiscordJson(env) {
  const s = await discordStats(env);
  return new Response(JSON.stringify({ schemaVersion: 1, ...s }, null, 2), {
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}

const fmt = (n) => n >= 1e12 ? (n / 1e12).toFixed(2) + 'T' : n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);

export async function weeklyPosts(env, getBoardIndex) {
  const board = Object.values(await getBoardIndex(env)).filter((e) => e?.handle)
    .sort((a, b) => (b.tokens || 0) - (a.tokens || 0)).slice(0, 10);
  const lb = await channelByName(env, 'leaderboard');
  if (lb && board.length) {
    const medals = ['🥇', '🥈', '🥉'];
    const lines = board.map((e, i) => `${medals[i] || `**${i + 1}.**`} [${e.displayName || e.handle}](https://claude-rpc.com/u/${encodeURIComponent(e.handle)}) · ${fmt(e.tokens || 0)} tokens · ${e.sessions || 0} sessions`);
    await dapi(env, 'POST', `/channels/${lb}/messages`, { embeds: [{ title: 'Weekly leaderboard — top 10', description: lines.join('\n'), color: 0xd97757, url: 'https://claude-rpc.com/leaderboard' }] });
  }
  const mod = await channelByName(env, 'mod-updates');
  if (mod) {
    const s = await discordStats(env);
    const row = (o) => Object.entries(o).filter(([, v]) => v).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—';
    await dapi(env, 'POST', `/channels/${mod}/messages`, { embeds: [{ title: 'Weekly growth', color: 0x5865f2, fields: [
      { name: 'Members', value: String(s.members ?? '?') },
      { name: 'Join clicks by source', value: row(s.clicks) },
      { name: 'Joins by source', value: row(s.joins) },
    ] }] });
  }
}

export async function scheduledBot(env, getBoardIndex, now = new Date()) {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) return;
  await syncInvites(env);
  // Weekly: Monday 15:00–15:14 UTC window, once (marker holds the ISO week day).
  if (now.getUTCDay() === 1 && now.getUTCHours() === 15 && now.getUTCMinutes() < 15) {
    const day = now.toISOString().slice(0, 10);
    if ((await env.TOTALS.get(WEEK_KEY)) !== day) {
      await env.TOTALS.put(WEEK_KEY, day);
      await weeklyPosts(env, getBoardIndex);
    }
  }
}
