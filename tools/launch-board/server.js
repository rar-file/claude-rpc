// Launch Board — a tiny local web app to draft, queue, and post build-in-public
// updates to YOUR OWN X account. Run it, paste your 4 X keys once, then compose
// and post from the browser. Claude can also post the next queued item from the
// CLI (see post.js) so "you auth, I post" works.
//
//   node tools/launch-board/server.js   →   http://localhost:8787
//
// No dependencies. Credentials + queue live in ./.data/ (gitignored) and never
// leave your machine except as a normal API call to x.com.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { verify, postTweet } from './x.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA = join(DIR, '.data');
const CREDS = join(DATA, 'creds.json');
const QUEUE = join(DATA, 'queue.json');
const PORT = process.env.PORT || 8787;
// Bind all interfaces by default so the board is reachable over a Tailscale /
// LAN address, not just localhost. Override with HOST=127.0.0.1 to restrict.
// NOTE: there's no auth on this board — anyone who can reach HOST:PORT can post
// to your X account. Keep it on a trusted network (a tailnet is fine).
const HOST = process.env.HOST || '0.0.0.0';

const readJson = (p, fb) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fb; } };
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2)); };

export const loadCreds = () => readJson(CREDS, null);
const loadQueue = () => readJson(QUEUE, []);
const saveQueue = (q) => writeJson(QUEUE, q);

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
const readBody = (req) => new Promise((r) => {
  let d = ''; req.on('data', (c) => d += c); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } });
});

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>claude-rpc · launch board</title><style>
:root{--paper:#f4ede0;--ink:#2b2722;--mute:#6b6357;--rust:#d97757;--rust3:#b8552f;--grass:#5a7d4f;--card:#ebe2d2}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 -apple-system,system-ui,sans-serif}
.wrap{max-width:680px;margin:0 auto;padding:34px 20px}h1{font-size:1.5rem;margin:0 0 2px}.sub{color:var(--mute);font-size:.85rem;margin-bottom:22px}
.card{background:var(--card);border:1.5px solid var(--ink);box-shadow:5px 5px 0 rgba(43,39,34,.12);padding:18px;margin-bottom:20px}
.card h2{font-size:.78rem;text-transform:uppercase;letter-spacing:.1em;color:var(--mute);margin:0 0 12px}
textarea,input{width:100%;font:14px ui-monospace,monospace;padding:9px;border:1.5px solid var(--ink);background:var(--paper);color:var(--ink)}
textarea{min-height:80px;resize:vertical}.row{display:flex;gap:8px;margin-top:8px;align-items:center}
button{font:700 13px ui-monospace,monospace;padding:8px 14px;border:1.5px solid var(--ink);background:var(--ink);color:var(--paper);cursor:pointer}
button.alt{background:var(--paper);color:var(--ink)}button:disabled{opacity:.5;cursor:default}
.count{color:var(--mute);font:12px ui-monospace,monospace;margin-left:auto}.count.over{color:var(--rust3)}
.status{font:12px ui-monospace,monospace}.ok{color:var(--grass)}.bad{color:var(--rust3)}
.q{border-top:1px solid rgba(43,39,34,.15);padding:11px 0;display:flex;gap:10px;align-items:flex-start}
.q .t{flex:1;white-space:pre-wrap;font:13px ui-monospace,monospace}.q .x{cursor:pointer;color:var(--rust3);font-weight:700}
.keys{display:grid;grid-template-columns:1fr 1fr;gap:8px}.keys input{font-size:12px}.hide{display:none}
a{color:var(--rust3)}
</style></head><body><div class="wrap">
<h1>claude-rpc · launch board</h1>
<div class="sub">Draft → queue → post to <b>your own</b> X account. Everything stays local.</div>

<div class="card"><h2>X account <span id="who" class="status"></span></h2>
  <div id="connectForm">
    <div class="keys">
      <input id="apiKey" placeholder="API Key (consumer key)">
      <input id="apiSecret" placeholder="API Key Secret">
      <input id="accessToken" placeholder="Access Token">
      <input id="accessSecret" placeholder="Access Token Secret">
    </div>
    <div class="row"><button onclick="connect()">Connect & verify</button>
      <span class="status" id="connStatus"></span></div>
    <div class="sub" style="margin-top:10px">Get these at <a href="https://developer.x.com/en/portal/dashboard" target="_blank">developer.x.com</a> → your app → <b>Keys and tokens</b>. App permissions must be <b>Read and write</b>. See README.md.</div>
  </div>
</div>

<div class="card"><h2>Compose</h2>
  <textarea id="text" oninput="cnt()" placeholder="What did you ship today?"></textarea>
  <div class="row">
    <button class="alt" onclick="queue()">Add to queue</button>
    <button onclick="postNow()" id="postBtn">Post now</button>
    <span class="count" id="count">0 / 280</span>
  </div>
  <div class="status" id="postStatus" style="margin-top:8px"></div>
</div>

<div class="card"><h2>Queue (<span id="qn">0</span>)</h2><div id="queue"></div></div>
</div>
<script>
const $=id=>document.getElementById(id);
function cnt(){const n=$('text').value.length;const c=$('count');c.textContent=n+' / 280';c.className='count'+(n>280?' over':'');}
async function api(p,b){const r=await fetch(p,{method:b?'POST':'GET',headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});return r.json();}
async function refresh(){const s=await api('/api/state');
  $('who').innerHTML=s.connected?'<span class="ok">● @'+s.handle+'</span>':'<span class="bad">● not connected</span>';
  $('connectForm').classList.toggle('hide',s.connected);
  $('qn').textContent=s.queue.length;
  $('queue').innerHTML=s.queue.map(q=>'<div class="q"><div class="t">'+esc(q.text)+'</div>'+
    '<button class="alt" onclick="postId(\\''+q.id+'\\')" '+(s.connected?'':'disabled')+'>post</button>'+
    '<span class="x" onclick="del(\\''+q.id+'\\')">✕</span></div>').join('')||'<div class="sub">empty</div>';}
function esc(s){return s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
async function connect(){$('connStatus').textContent='verifying…';
  const r=await api('/api/connect',{apiKey:$('apiKey').value.trim(),apiSecret:$('apiSecret').value.trim(),accessToken:$('accessToken').value.trim(),accessSecret:$('accessSecret').value.trim()});
  $('connStatus').innerHTML=r.ok?'<span class="ok">connected as @'+r.handle+'</span>':'<span class="bad">'+esc(r.error||'failed')+'</span>';refresh();}
async function queue(){const t=$('text').value.trim();if(!t)return;await api('/api/queue',{text:t});$('text').value='';cnt();refresh();}
async function del(id){await api('/api/queue/delete',{id});refresh();}
async function postNow(){const t=$('text').value.trim();if(!t)return;$('postStatus').textContent='posting…';
  const r=await api('/api/post',{text:t});$('postStatus').innerHTML=r.ok?'<span class="ok">posted → <a href="'+r.url+'" target="_blank">'+r.url+'</a></span>':'<span class="bad">'+esc(r.error)+'</span>';if(r.ok){$('text').value='';cnt();}refresh();}
async function postId(id){$('postStatus').textContent='posting…';const r=await api('/api/post',{id});
  $('postStatus').innerHTML=r.ok?'<span class="ok">posted → <a href="'+r.url+'" target="_blank">'+r.url+'</a></span>':'<span class="bad">'+esc(r.error)+'</span>';refresh();}
refresh();
</script></body></html>`;

const routes = {
  'GET /': (req, res) => send(res, 200, PAGE, 'text/html'),
  'GET /api/state': (req, res) => {
    const c = loadCreds();
    send(res, 200, { connected: !!(c && c.handle), handle: c?.handle || null, queue: loadQueue() });
  },
  'POST /api/connect': async (req, res) => {
    const b = await readBody(req);
    const creds = { apiKey: b.apiKey, apiSecret: b.apiSecret, accessToken: b.accessToken, accessSecret: b.accessSecret };
    const v = await verify(creds);
    if (!v.ok) return send(res, 200, { ok: false, error: v.error });
    writeJson(CREDS, { ...creds, handle: v.handle });
    send(res, 200, { ok: true, handle: v.handle });
  },
  'POST /api/queue': async (req, res) => {
    const b = await readBody(req); const q = loadQueue();
    q.push({ id: Math.random().toString(36).slice(2, 9), text: String(b.text || '').slice(0, 280) });
    saveQueue(q); send(res, 200, { ok: true });
  },
  'POST /api/queue/delete': async (req, res) => {
    const b = await readBody(req); saveQueue(loadQueue().filter((x) => x.id !== b.id)); send(res, 200, { ok: true });
  },
  'POST /api/post': async (req, res) => {
    const b = await readBody(req); const creds = loadCreds();
    if (!creds) return send(res, 200, { ok: false, error: 'connect your X account first' });
    let text = b.text, id = b.id;
    if (id) { const item = loadQueue().find((x) => x.id === id); if (!item) return send(res, 200, { ok: false, error: 'not in queue' }); text = item.text; }
    const r = await postTweet(text, creds);
    if (r.ok && id) saveQueue(loadQueue().filter((x) => x.id !== id));
    send(res, 200, r);
  },
};

createServer(async (req, res) => {
  const key = `${req.method} ${req.url.split('?')[0]}`;
  const handler = routes[key];
  if (handler) { try { await handler(req, res); } catch (e) { send(res, 500, { ok: false, error: e.message }); } }
  else send(res, 404, { ok: false, error: 'not found' });
}).listen(PORT, HOST, () => {
  console.log(`launch board listening on ${HOST}:${PORT}`);
  const addrs = Object.values(networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal);
  console.log(`  local:     http://localhost:${PORT}`);
  for (const a of addrs) {
    const tailscale = a.address.startsWith('100.') ? '   ← Tailscale' : '';
    console.log(`  network:   http://${a.address}:${PORT}${tailscale}`);
  }
});
