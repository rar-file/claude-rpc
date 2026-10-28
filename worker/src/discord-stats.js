// Public Discord growth aggregate: GET /discord.json. Read-only over KV —
// click counters (ref:dc-<src>, written by /discord), join counts
// (dcjoin:<src>) and the member count (dc:members), the last two mirrored in by
// the bot that runs on our own server (bot/index.js). No PII.

export async function handleDiscordJson(env) {
  const clicks = {}, joins = {};
  const refs = await env.TOTALS.list({ prefix: 'ref:dc-' });
  for (const { name } of refs.keys) clicks[name.slice(7)] = Number(await env.TOTALS.get(name)) || 0;
  const js = await env.TOTALS.list({ prefix: 'dcjoin:' });
  for (const { name } of js.keys) joins[name.slice(7)] = Number(await env.TOTALS.get(name)) || 0;
  const m = Number(await env.TOTALS.get('dc:members'));
  return new Response(JSON.stringify({ schemaVersion: 1, clicks, joins, members: Number.isFinite(m) && m > 0 ? m : null, ts: Date.now() }, null, 2), {
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}
