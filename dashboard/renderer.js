// dashboard/renderer.js — single-file, vanilla, no bundler.
// Tabs: Presence / Discord / Assets / Timing / Daemon / Stats.

const $ = (id) => document.getElementById(id);
let currentConfig = null;
let liveVars = null;
let logTailUnsub = null;
let serveProc = null;
let rotationCursor = 0;
let rotationTimer = null;

// Sample values used as a fallback when no live state exists yet.
const SAMPLES = {
  status: 'working', statusVerbose: 'Working', statusIcon: 'working',
  project: 'CLAUDE', projectPretty: 'CLAUDE',
  model: 'claude-opus-4-7', modelPretty: 'Opus 4.7',
  messages: 8, messagesLabel: '8 prompts',
  tools: 23, toolsLabel: '23 tool calls',
  filesEdited: 3, filesEditedLabel: '3 edits',
  filesRead: 4, filesReadLabel: '4 file reads',
  filesOpened: 5, filesOpenedLabel: '5 files',
  tokens: 2300, tokensFmt: '2.3k', tokensRealFmt: '1.4k',
  inputTokens: '1.2k', outputTokens: '900', cacheTokens: '200',
  duration: '12m 5s', durationHours: '12m',
  currentTool: 'Edit', currentToolPretty: 'Edit',
  currentFile: 'page.tsx', currentFilePretty: 'src/app/page.tsx',
  sessionActive: 1,
  concurrent: 2, concurrentOther: 1,
  concurrentLabel: '2 live sessions', concurrentOtherLabel: '1 other session',
  concurrentListPretty: 'CLAUDE, my-app',
  allTokensFmt: '2.82B', allTokensRealFmt: '18M',
  allBillableFmt: '86M', allInputTokens: '204k', allOutputTokens: '18M',
  allCacheReadTokens: '2.78B', allCacheWriteTokens: '67.8M',
  allHours: '52h', allWallHours: '231h',
  allMessages: 767, allMessagesFmt: '767',
  allTools: 8997, allToolsFmt: '8.7k',
  allSessions: 69, allSessionsLabel: '69 sessions',
  allSubagentRuns: 44, allFiles: 1500, allFilesFmt: '1.5k',
  todayActiveMs: 3360000, todayHours: '56m',
  todayPrompts: 20, todayPromptsLabel: '20 prompts',
  todayToolsFmt: '250', todayToolsLabel: '250 tool calls',
  todayTokensFmt: '17.2M', todayTokensRealFmt: '350k', todayCacheTokensFmt: '17M',
  todaySessions: 3,
  streak: 1, streakLabel: '1-day streak', longestStreak: 9,
  daysSinceFirst: 31, daysSinceFirstLabel: 'Day 31',
  bestDayDate: '2026-04-29', bestDayHours: '6.3h',
  bestDayPrompts: 48, bestDayTokensFmt: '180M',
  weekActiveMs: 11160000, weekHours: '3.1h',
  weekPrompts: 50, weekPromptsLabel: '50 prompts',
  weekToolsFmt: '800', weekTokensFmt: '94.6M',
  weekSessions: 8, weekSessionsLabel: '8 sessions',
  peakHourNum: 22, peakHour: '22:00',
  peakHourHours: '6.6h', peakHourActiveLabel: '6.6h there',
  topEditedFile: 'index.html', topEditedCount: 73, topEditedCountLabel: '73 edits',
  projectHours: '22m', projectActiveMs: 1320000,
  projectPrompts: 8, projectPromptsLabel: '8 prompts',
  projectTools: 80, projectSessions: 1, projectSessionLabel: 'Session #1',
  streakIsMilestone: 0,
  // Phase 1 enrichments
  linesAdded: 24000, linesAddedFmt: '24k',
  linesRemoved: 5800, linesNet: 18200, linesNetFmt: '+18k',
  todayLinesAdded: 320, todayLinesAddedFmt: '320',
  todayLinesNet: 280, todayLinesNetFmt: '+280',
  weekLinesAdded: 2400, weekLinesNet: 1900, weekLinesNetFmt: '+1.9k',
  allLinesAddedFmt: '24k', allLinesNetFmt: '+18k',
  topLanguage: 'TypeScript', topLanguageEdits: 1450, languagesLabel: 'TypeScript · Python · Rust',
  topBashCmd: 'git', topBashCmdLabel: 'git × 820',
  topDomain: 'docs.anthropic.com', topDomainLabel: 'docs.anthropic.com × 28',
  topSubagent: 'Explore', subagentLabel: 'Explore × 18',
  mcpToolPercentLabel: '12% MCP',
  todayCostFmt: '$1.23', weekCostFmt: '$8.40', allCostFmt: '$89.42',
  costEstimateFmt: '$89.42',
  weekdayLabel: 'Thursday', startTimeLabel: 'started 09:14',
  notificationCount: 84, notificationLabel: '84 notifications',
};

const PRESETS = {
  tokens:  { details: '{currentToolPretty} · {currentFilePretty}', state: '{modelPretty} · {tokensFmt} tokens', requires: 'currentFile' },
  streak:  { details: '{streakLabel}', state: '{daysSinceFirstLabel} · {allSessionsLabel}', requires: 'streak' },
  cost:    { details: 'Cost · {todayCostFmt} today', state: '{weekCostFmt} this week · {allCostFmt} all-time', requires: 'todayCost' },
  lines:   { details: 'Wrote {todayLinesAddedFmt} lines today', state: '{todayLinesNetFmt} net · {topLanguage}', requires: 'todayLinesAdded' },
  hotspot: { details: 'Hotspot · {topEditedFile}', state: '{topEditedCountLabel} all-time', requires: 'topEditedCount' },
};

function render(template, vars) {
  if (!template) return '';
  return template.replace(/\{(\w+)\}/g, (m, key) => {
    if (vars && vars[key] !== undefined) return String(vars[key]);
    if (SAMPLES[key] !== undefined) return String(SAMPLES[key]);
    return m;
  });
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
function switchTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.dataset.panel !== name;
  if (name === 'daemon') refreshLog();
  if (name === 'privacy') loadWorkspaces();
  if (name === 'stats') ensureServeRunning();
}

// ── Privacy / workspaces tab ───────────────────────────────────────────────────
const WS_LEVELS = [
  ['public', 'Public'],
  ['name-only', 'Name only'],
  ['hidden', 'Hidden'],
];

async function loadWorkspaces() {
  const root = $('workspaceList');
  root.innerHTML = '<div class="ws-empty">Loading projects…</div>';
  const { workspaces, visibility } = await window.api.listWorkspaces();
  if (!workspaces || !workspaces.length) {
    root.innerHTML = '<div class="ws-empty">No projects discovered yet — open Claude Code in a project first.</div>';
    return;
  }
  root.innerHTML = '';
  for (const ws of workspaces) {
    const current = visibility[ws.cwd] || 'public';
    const row = document.createElement('div');
    row.className = 'ws-row';
    const seg = WS_LEVELS.map(([val, label]) =>
      `<button class="ws-seg${val === current ? ' active' : ''}" data-level="${val}">${label}</button>`
    ).join('');
    row.innerHTML =
      `<div class="ws-meta"><div class="ws-name">${escapeAttr(ws.name)}</div>` +
      `<div class="ws-path">${escapeAttr(ws.cwd)}</div></div>` +
      `<div class="ws-toggle" data-cwd="${escapeAttr(ws.cwd)}">${seg}</div>`;
    root.appendChild(row);
  }
  root.querySelectorAll('.ws-toggle').forEach((toggle) => {
    toggle.querySelectorAll('.ws-seg').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const cwd = toggle.dataset.cwd;
        const level = btn.dataset.level;
        const r = await window.api.setWorkspaceVisibility(cwd, level);
        if (r?.ok) {
          toggle.querySelectorAll('.ws-seg').forEach((b) => b.classList.toggle('active', b === btn));
          setStatus(`${level} · ${cwd.split(/[\\/]/).pop()}`, 'success');
        } else {
          setStatus(r?.error || 'Failed to update', 'error');
        }
      });
    });
  });
}

document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});

// ── Variable autocomplete ────────────────────────────────────────────────────
async function populateVarList() {
  let keys = Object.keys(SAMPLES);
  try {
    const res = await window.api.listVars();
    if (res && Array.isArray(res.vars) && res.vars.length) keys = res.vars;
    if (res && res.vars) liveVars = res.live || null;
  } catch {}
  const dl = $('varlist');
  dl.innerHTML = '';
  for (const k of keys) {
    const o = document.createElement('option');
    o.value = '{' + k + '}';
    dl.appendChild(o);
  }
}

// ── Frame cards ──────────────────────────────────────────────────────────────
function avatarHtml(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return `<img src="${escapeAttr(url)}" alt="" />`;
  return '';
}

function buildFrameCard(f = {}, avatar = '') {
  const el = document.createElement('div');
  el.className = 'frame';
  el.dataset.mode = 'view';
  el.draggable = true;

  el.innerHTML = `
    <button class="remove" title="Remove">×</button>
    <div class="view">
      <div class="avatar">${avatarHtml(avatar)}</div>
      <div class="content">
        <div class="appname">Claude Code</div>
        <div class="details-render"></div>
        <div class="state-render"></div>
      </div>
      <span class="req-tag"></span>
    </div>
    <div class="edit">
      <label>Top line
        <input class="details-input" list="varlist" placeholder="e.g. Working in {project}" />
      </label>
      <label>Bottom line
        <input class="state-input" list="varlist" placeholder="e.g. {modelPretty}" />
      </label>
      <label>Only show when
        <input class="req-input" list="varlist" placeholder="leave empty for always — e.g. currentFile" />
      </label>
      <div class="edit-actions">
        <button type="button" class="dup">Duplicate</button>
        <button type="button" class="done">Done</button>
      </div>
    </div>
  `;

  const requiresStr = Array.isArray(f.requires) ? f.requires.join(', ') : (f.requires || '');
  el.querySelector('.details-input').value = f.details || '';
  el.querySelector('.state-input').value = f.state || '';
  el.querySelector('.req-input').value = requiresStr;
  refreshFrame(el);

  el.querySelector('.remove').addEventListener('click', (e) => { e.stopPropagation(); el.remove(); });
  el.querySelector('.view').addEventListener('click', () => {
    closeAllEdits(el);
    el.dataset.mode = 'edit';
    setTimeout(() => el.querySelector('.details-input').focus(), 0);
  });
  el.querySelectorAll('.edit input').forEach((inp) => {
    inp.addEventListener('input', () => refreshFrame(el));
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); exitEdit(el); }
      if (e.key === 'Escape') { e.preventDefault(); exitEdit(el); }
    });
  });
  el.querySelector('.done').addEventListener('click', (e) => { e.stopPropagation(); exitEdit(el); });
  el.querySelector('.dup').addEventListener('click', (e) => {
    e.stopPropagation();
    const clone = collectFrame(el);
    const avatarUrl = currentAvatar();
    const newEl = buildFrameCard(clone, avatarUrl);
    el.parentNode.insertBefore(newEl, el.nextSibling);
  });

  // Drag reorder
  el.addEventListener('dragstart', () => el.classList.add('dragging'));
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag-over');
    const dragging = document.querySelector('.frame.dragging');
    if (dragging && dragging !== el) el.parentNode.insertBefore(dragging, el);
  });

  return el;
}

function refreshFrame(el) {
  const detailsTpl = el.querySelector('.details-input').value;
  const stateTpl = el.querySelector('.state-input').value;
  const req = el.querySelector('.req-input').value.trim();
  el.querySelector('.details-render').textContent = render(detailsTpl, liveVars) || 'Empty frame';
  el.querySelector('.state-render').textContent = render(stateTpl, liveVars);
  const reqTag = el.querySelector('.req-tag');
  reqTag.textContent = req ? '?' + req : '';
  reqTag.style.display = req ? '' : 'none';
}

function exitEdit(el) { el.dataset.mode = 'view'; refreshFrame(el); }
function closeAllEdits(except) {
  for (const frame of document.querySelectorAll('.frame[data-mode="edit"]')) {
    if (frame !== except) exitEdit(frame);
  }
}

function collectFrame(el) {
  const details = el.querySelector('.details-input').value.trim();
  const state = el.querySelector('.state-input').value.trim();
  const requiresStr = el.querySelector('.req-input').value.trim();
  const frame = {};
  if (details) frame.details = details;
  if (state) frame.state = state;
  if (requiresStr) {
    const parts = requiresStr.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 1) frame.requires = parts[0];
    else if (parts.length > 1) frame.requires = parts;
  }
  return frame;
}

function currentAvatar() {
  return (currentConfig?.statusAssets?.working) || (currentConfig?.presence?.largeImageKey) || '';
}

document.addEventListener('click', (e) => {
  const inFrame = e.target.closest('.frame');
  for (const frame of document.querySelectorAll('.frame[data-mode="edit"]')) {
    if (frame !== inFrame) exitEdit(frame);
  }
});

// ── Render frames into the Presence tab ──────────────────────────────────────
function renderFrames(frames) {
  const container = $('frames');
  container.innerHTML = '';
  const avatar = currentAvatar();
  for (const f of frames) container.appendChild(buildFrameCard(f, avatar));
}

$('addFrameBtn').addEventListener('click', () => {
  const card = buildFrameCard({}, currentAvatar());
  $('frames').appendChild(card);
  closeAllEdits(card);
  card.dataset.mode = 'edit';
  setTimeout(() => card.querySelector('.details-input').focus(), 0);
});

document.querySelectorAll('.preset').forEach((btn) => {
  btn.addEventListener('click', () => {
    const p = PRESETS[btn.dataset.preset];
    if (!p) return;
    const card = buildFrameCard(p, currentAvatar());
    $('frames').appendChild(card);
  });
});

// ── Discord tab ──────────────────────────────────────────────────────────────
function renderDiscordTab(cfg) {
  $('clientId').value = cfg.clientId || '';
  $('appName').value = cfg.appName || 'Claude Code';
  $('activityType').value = String(cfg.activityType ?? 0);
  $('showElapsed').checked = cfg.showElapsed !== false;
  renderButtons(cfg.presence?.buttons || []);
}

function renderButtons(buttons) {
  const root = $('buttons');
  root.innerHTML = '';
  for (const b of buttons) root.appendChild(buttonRow(b));
}

function buttonRow(b = {}) {
  const row = document.createElement('div');
  row.className = 'button-row';
  row.innerHTML = `
    <input type="text" class="btn-label" placeholder="Label" value="${escapeAttr(b.label || '')}" />
    <input type="url"  class="btn-url"   placeholder="https://…" value="${escapeAttr(b.url || '')}" />
    <button class="remove-cell" title="Remove">×</button>
  `;
  row.querySelector('.remove-cell').addEventListener('click', () => row.remove());
  return row;
}

$('addButtonBtn').addEventListener('click', () => {
  const rows = $('buttons').children.length;
  if (rows >= 2) return;
  $('buttons').appendChild(buttonRow());
});

function collectDiscord() {
  return {
    clientId: $('clientId').value.trim(),
    appName: $('appName').value.trim() || 'Claude Code',
    activityType: Number($('activityType').value) || 0,
    showElapsed: $('showElapsed').checked,
    buttons: [...$('buttons').children].map((row) => ({
      label: row.querySelector('.btn-label').value.trim(),
      url: row.querySelector('.btn-url').value.trim(),
    })).filter((b) => b.label && b.url).slice(0, 2),
  };
}

// ── Assets tab ───────────────────────────────────────────────────────────────
const STATUSES = ['working', 'thinking', 'idle', 'stale', 'notification'];

function renderAssetsTab(cfg) {
  const assets = cfg.statusAssets || {};
  const icons  = cfg.statusIcons  || {};
  const aRoot = $('assetRows');
  aRoot.innerHTML = '';
  for (const status of STATUSES) {
    const row = document.createElement('div');
    row.className = 'asset-row';
    const url = assets[status] || '';
    row.innerHTML = `
      <span class="status-name">${status}</span>
      <div class="preview">${avatarHtml(url) || '<span class="ph">no asset</span>'}</div>
      <input type="text" class="asset-url" data-status="${status}" placeholder="image key or https://…" value="${escapeAttr(url)}" />
    `;
    row.querySelector('input').addEventListener('input', (e) => {
      const v = e.target.value.trim();
      const prev = row.querySelector('.preview');
      prev.innerHTML = avatarHtml(v) || '<span class="ph">no asset</span>';
    });
    aRoot.appendChild(row);
  }

  const iRoot = $('iconRows');
  iRoot.innerHTML = '';
  for (const status of STATUSES) {
    const row = document.createElement('div');
    row.className = 'icon-row';
    row.innerHTML = `
      <span class="status-name">${status}</span>
      <input type="text" class="icon-key" data-status="${status}" placeholder="leave empty to hide" value="${escapeAttr(icons[status] || '')}" />
      <span></span>
    `;
    iRoot.appendChild(row);
  }
}

function collectAssets() {
  const assets = {};
  for (const inp of $('assetRows').querySelectorAll('input')) {
    const v = inp.value.trim();
    if (v) assets[inp.dataset.status] = v;
  }
  const icons = {};
  for (const inp of $('iconRows').querySelectorAll('input')) {
    icons[inp.dataset.status] = inp.value.trim();
  }
  return { statusAssets: assets, statusIcons: icons };
}

// ── Timing tab ───────────────────────────────────────────────────────────────
function renderTimingTab(cfg) {
  for (const row of document.querySelectorAll('.timing .row')) {
    const key = row.dataset.key;
    const mul = Number(row.dataset.mul) || 1;
    const stored = cfg[key];
    row.querySelector('input').value = stored != null ? stored / mul : '';
  }
}

function collectTiming(into) {
  for (const row of document.querySelectorAll('.timing .row')) {
    const key = row.dataset.key;
    const mul = Number(row.dataset.mul) || 1;
    const raw = row.querySelector('input').value;
    if (raw === '') { delete into[key]; continue; }
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) into[key] = Math.round(n * mul);
  }
}

// ── Daemon tab ───────────────────────────────────────────────────────────────
async function updateDaemonStatus() {
  const status = await window.api.daemonStatus();
  const badge = $('daemonBadge');
  const bigDot = $('daemonBigDot');
  if (status.running) {
    badge.textContent = 'running';
    badge.className = 'daemon-badge running';
    bigDot.className = 'big-dot running';
    $('daemonBigStatus').textContent = 'Running';
    $('daemonBigMeta').textContent = `pid ${status.pid}`;
  } else {
    badge.textContent = 'not running';
    badge.className = 'daemon-badge stopped';
    bigDot.className = 'big-dot stopped';
    $('daemonBigStatus').textContent = 'Not running';
    $('daemonBigMeta').textContent = '—';
  }
}

$('daemonStartBtn').addEventListener('click', async () => {
  await window.api.daemonStart();
  setTimeout(updateDaemonStatus, 500);
  setTimeout(refreshLog, 1200);
});
$('daemonStopBtn').addEventListener('click', async () => {
  await window.api.daemonStop();
  setTimeout(updateDaemonStatus, 500);
});
$('daemonRestartBtn').addEventListener('click', async () => {
  await window.api.daemonRestart();
  setTimeout(updateDaemonStatus, 1200);
  setTimeout(refreshLog, 1500);
});

async function refreshLog() {
  const out = await window.api.tailLog();
  if (out?.path) $('logPath').textContent = out.path;
  $('logBody').textContent = (out?.content || 'no log yet').slice(-8000);
  // Scroll to bottom.
  const body = $('logBody');
  body.scrollTop = body.scrollHeight;
}

// ── Stats tab ────────────────────────────────────────────────────────────────
async function ensureServeRunning() {
  const port = await window.api.getRpcPort();
  const url = `http://127.0.0.1:${port}`;
  $('statsUrl').textContent = url;
  if (serveProc) {
    $('statsIframe').src = url;
    return;
  }
  await window.api.startServe();
  serveProc = true;
  setTimeout(() => { $('statsIframe').src = url; }, 600);
}
$('statsOpenExternal').addEventListener('click', async () => {
  const port = await window.api.getRpcPort();
  await window.api.openExternal(`http://127.0.0.1:${port}`);
});

async function exportData(format) {
  setStatus('Exporting…');
  const r = await window.api.exportData(format);
  if (r?.ok) setStatus('Exported → ' + r.path, 'success');
  else if (r?.canceled) setStatus('');
  else setStatus(r?.error || 'Export failed', 'error');
}
$('exportJsonBtn').addEventListener('click', () => exportData('json'));
$('exportCsvBtn').addEventListener('click', () => exportData('csv'));

// ── Live preview rail ────────────────────────────────────────────────────────
function refreshLiveRail() {
  const frames = [...document.querySelectorAll('#frames .frame')].map((el) => collectFrame(el));
  const live = frames.filter((f) => !f.requires || passes(f.requires, liveVars || SAMPLES));
  if (!live.length) {
    $('liveDetails').textContent = 'No frames';
    $('liveState').textContent = '';
    $('liveFrameNum').textContent = '0/0';
    return;
  }
  rotationCursor = rotationCursor % live.length;
  const f = live[rotationCursor];
  $('liveDetails').textContent = render(f.details, liveVars) || 'Empty';
  $('liveState').textContent = render(f.state, liveVars) || '';
  $('liveFrameNum').textContent = (rotationCursor + 1) + '/' + live.length;

  const avatar = currentAvatar();
  const av = $('liveAvatar');
  if (avatar && /^https?:\/\//i.test(avatar)) {
    av.innerHTML = `<img src="${escapeAttr(avatar)}" alt="" />`;
  } else { av.innerHTML = ''; }

  // Status pill from live state.
  const status = liveVars?.status || 'working';
  $('liveStatus').textContent = liveVars?.statusVerbose || 'Working';
  $('liveDot').className = 'dot ' + (status === 'idle' ? 'idle' : status === 'stale' ? 'stale' : '');
}

function passes(req, vars) {
  const keys = Array.isArray(req) ? req : [req];
  for (const k of keys) {
    const v = vars[k];
    if (v === undefined || v === null || v === 0 || v === '' || v === '—' || v === '0') return false;
  }
  return true;
}

// ── Save ─────────────────────────────────────────────────────────────────────
function collect() {
  const cfg = JSON.parse(JSON.stringify(currentConfig || {}));

  // Timing fields.
  collectTiming(cfg);

  // Discord.
  const d = collectDiscord();
  cfg.clientId = d.clientId;
  cfg.appName = d.appName;
  cfg.activityType = d.activityType;
  cfg.showElapsed = d.showElapsed;
  cfg.presence = cfg.presence || {};
  cfg.presence.buttons = d.buttons;

  // Assets.
  const a = collectAssets();
  cfg.statusAssets = a.statusAssets;
  cfg.statusIcons = a.statusIcons;

  // Rotation.
  const rotation = [];
  for (const frameEl of $('frames').children) {
    const frame = collectFrame(frameEl);
    if (frame.details || frame.state) rotation.push(frame);
  }
  cfg.presence.rotation = rotation;

  return cfg;
}

function setStatus(text, kind) {
  const el = $('saveStatus');
  el.textContent = text;
  el.className = kind || '';
  if (text && kind === 'success') {
    setTimeout(() => { if (el.textContent === text) { el.textContent = ''; el.className = ''; } }, 2200);
  }
}

async function save() {
  if (!currentConfig) { setStatus('No config loaded', 'error'); return; }
  setStatus('Saving…');
  const cfg = collect();
  const result = await window.api.saveConfig(cfg);
  if (result.ok) {
    currentConfig = cfg;
    setStatus('Saved', 'success');
    refreshLiveRail();
  } else {
    setStatus(result.error || 'Error', 'error');
  }
}

$('saveBtn').addEventListener('click', save);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
});

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const result = await window.api.loadConfig();
  if (result.error) {
    setStatus(result.error, 'error');
    return;
  }
  currentConfig = result.config;
  $('configPath').textContent = result.configPath || '';

  await populateVarList();

  renderFrames((currentConfig.presence && currentConfig.presence.rotation) || []);
  renderDiscordTab(currentConfig);
  renderAssetsTab(currentConfig);
  renderTimingTab(currentConfig);

  updateDaemonStatus();
  setInterval(updateDaemonStatus, 3000);
  setInterval(refreshLiveRail, 4000);
  refreshLiveRail();

  // Cycle rail every 4s.
  rotationTimer = setInterval(() => { rotationCursor++; refreshLiveRail(); }, 4000);
}

init();
