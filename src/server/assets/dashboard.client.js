(() => {
  const $ = (id) => document.getElementById(id);
  const LANGS = {
  'JavaScript': '#f7df1e', 'TypeScript': '#3178c6', 'Python': '#3776ab', 'Rust': '#dea584',
  'Go': '#00add8', 'Ruby': '#cc342d', 'Java': '#b07219', 'Kotlin': '#a97bff',
  'C': '#555', 'C++': '#f34b7d', 'C#': '#178600', 'PHP': '#4f5b93',
  'Swift': '#ffac45', 'HTML': '#e34c26', 'CSS': '#563d7c', 'SCSS': '#c6538c',
  'Markdown': '#888', 'JSON': '#888', 'Shell': '#89e051', 'YAML': '#cb171e',
  'Vue': '#41b883', 'Svelte': '#ff3e00', 'Notebook': '#da5b0b', 'SQL': '#dad8d8',
  'GraphQL': '#e10098', 'Dockerfile': '#384d54', 'Make': '#427819', 'CMake': '#da3434',
  'Lua': '#000080', 'Dart': '#00b4ab', 'Elm': '#60b5cc', 'Elixir': '#6e4a7e',
  'Erlang': '#a90533', 'Haskell': '#5d4f85', 'OCaml': '#3be133', 'Clojure': '#db5855',
  'ClojureScript': '#db5855', 'R': '#198ce7', 'Julia': '#a270ba', 'Zig': '#ec915c',
  'PowerShell': '#012456', 'Batch': '#c1f12e', 'TOML': '#9c4221', 'INI': '#888',
  'XML': '#0060ac', 'Protobuf': '#888', 'LaTeX': '#3D6117', 'Text': '#888',
  'reStructuredText': '#888', 'Lockfile': '#444', 'Gradle': '#02303a',
  'Crystal': '#000100', 'Nim': '#ffc200', 'V': '#4f87c4', 'Objective-C': '#438eff',
  'Objective-C++': '#6866fb', 'Sass': '#a53b70', 'Less': '#1d365d',
  'Scala': '#c22d40', 'Groovy': '#4298b8', 'Interface Builder': '#888', 'Env': '#888',
  'Config': '#888', 'Git': '#f1502f',
};

  let range = '90d';
  let liveData = null;
  let aggData = null;
  let heatmapByDay = null; // dedicated fixed-90d source, independent of the range pill
  let allFrames = [];
  let currentLiveIdx = 0;
  let rotationTimer = null;
  let chartSeries = [];   // [{ d: Date, ms }]   — for the activity-chart hover tooltip
  let churnSeries = [];   // [{ d: Date, add, rem }] — for the churn-sparkline tooltip

  // ── Utilities ───────────────────────────────────────────
  // Escape before any innerHTML interpolation: project/file/command/model
  // names come from the aggregate, i.e. ultimately from directory and file
  // names on disk — a repo named `<img onerror=…>` must render, not run.
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const fmtH = (ms) => {
    if (!ms) return '0h';
    const h = ms / 3_600_000;
    if (h < 1) return Math.round(h * 60) + 'm';
    if (h < 10) return h.toFixed(1) + 'h';
    return Math.round(h) + 'h';
  };
  const fmtN = (n) => {
    if (!n) return '0';
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1e3).toFixed(1) + 'k';
    if (n < 1e9) return (n / 1e6).toFixed(2) + 'M';
    return (n / 1e9).toFixed(2) + 'B';
  };
  const fmtCost = (usd) => {
    if (!usd) return '$0';
    if (usd < 0.01) return '$' + usd.toFixed(4);
    if (usd < 100) return '$' + usd.toFixed(2);
    if (usd < 1000) return '$' + Math.round(usd);
    if (usd < 10000) return '$' + (usd / 1000).toFixed(2) + 'k';
    return '$' + (usd / 1000).toFixed(1) + 'k';
  };
  const dayKey = (ts) => {
    const d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const splitTime = (s) => {
    if (!s) return ['—', ''];
    const m = String(s).match(/^([\d.]+)([a-z]*)$/i);
    return m ? [m[1], m[2]] : [s, ''];
  };
  const setDelta = (node, ms, suffix) => {
    if (ms === 0) { node.className = 'delta flat'; node.textContent = '—'; return; }
    const sign = ms > 0 ? 'up' : 'down';
    const arrow = ms > 0 ? '↑' : '↓';
    node.className = 'delta ' + sign;
    node.textContent = arrow + ' ' + fmtH(Math.abs(ms)) + (suffix ? ' ' + suffix : '');
  };
  const elapsedStr = (start) => {
    if (!start) return '—';
    const s = Math.floor((Date.now() - start) / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h) return h + 'h ' + m + 'm';
    return m + 'm ' + (s % 60) + 's';
  };

  // ── Theme ───────────────────────────────────────────────
  function applyTheme() {
    const saved = localStorage.getItem('theme') || 'dark';
    document.documentElement.classList.toggle('light', saved === 'light');
  }
  $('theme-btn').addEventListener('click', () => {
    const cur = localStorage.getItem('theme') || 'dark';
    localStorage.setItem('theme', cur === 'dark' ? 'light' : 'dark');
    applyTheme();
  });
  applyTheme();

  // ── Range pills ─────────────────────────────────────────
  document.querySelectorAll('#range-pills button').forEach((b) => {
    b.addEventListener('click', () => {
      range = b.dataset.range;
      for (const x of document.querySelectorAll('#range-pills button')) x.classList.toggle('active', x === b);
      $('chart-title').textContent = range === 'all' ? 'All time' : 'Last ' + range;
      fetchAggregate();
    });
  });

  // ── Chart ───────────────────────────────────────────────
  function renderChart(byDay, days) {
    const svg = $('chart');
    [...svg.querySelectorAll('.dyn')].forEach((n) => n.remove());
    const ns = 'http://www.w3.org/2000/svg';
    const VIEW_W = 800, VIEW_H = 130, PAD_T = 6, PAD_B = 16;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const ms = (byDay[dayKey(d.getTime())] || {}).activeMs || 0;
      series.push({ d, ms });
    }
    chartSeries = series;
    const max = Math.max(...series.map((p) => p.ms), 1);
    const h = VIEW_H - PAD_T - PAD_B;
    const xAt = (i) => series.length > 1 ? (i / (series.length - 1)) * VIEW_W : VIEW_W / 2;
    const yAt = (ms) => PAD_T + h - (ms / max) * h;
    for (let r = 1; r <= 3; r++) {
      const y = PAD_T + (h / 3) * r;
      const ln = document.createElementNS(ns, 'line');
      ln.setAttribute('x1', 0); ln.setAttribute('x2', VIEW_W);
      ln.setAttribute('y1', y); ln.setAttribute('y2', y);
      ln.setAttribute('class', 'grid dyn');
      svg.appendChild(ln);
    }
    let path = '';
    series.forEach((p, i) => {
      const x = xAt(i), y = yAt(p.ms);
      path += (i === 0 ? 'M' : ' L') + x.toFixed(1) + ',' + y.toFixed(1);
    });
    const area = document.createElementNS(ns, 'path');
    area.setAttribute('d', path + ' L' + xAt(series.length - 1).toFixed(1) + ',' + (PAD_T + h) + ' L0,' + (PAD_T + h) + ' Z');
    area.setAttribute('class', 'area dyn');
    svg.appendChild(area);
    const line = document.createElementNS(ns, 'path');
    line.setAttribute('d', path);
    line.setAttribute('class', 'line dyn');
    svg.appendChild(line);
    const last = series[series.length - 1];
    if (last.ms > 0) {
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', xAt(series.length - 1));
      dot.setAttribute('cy', yAt(last.ms));
      dot.setAttribute('r', 3);
      dot.setAttribute('class', 'dot dyn');
      svg.appendChild(dot);
    }
    const totalMs = series.reduce((s, p) => s + p.ms, 0);
    const peakDay = series.reduce((m, p) => p.ms > m.ms ? p : m, { ms: 0, d: null });
    $('chart-total').textContent = fmtH(totalMs) + ' total';
    $('chart-peak').textContent = peakDay.ms > 0 ? fmtH(peakDay.ms) + ' on ' + peakDay.d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';
  }

  // ── Heatmap ─────────────────────────────────────────────
  function renderHeatmap(byDay) {
    const grid = $('heatmap-grid');
    grid.innerHTML = '';
    byDay = byDay || {};
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const start = new Date(today); start.setDate(start.getDate() - 90);
    while (start.getDay() !== 0) start.setDate(start.getDate() - 1);
    // The day keys actually drawn — a fixed window ending today, independent of
    // the range pill (so 7d/30d don't blank the grid).
    const keys = [];
    const cur = new Date(start);
    while (cur <= today) { keys.push(dayKey(cur.getTime())); cur.setDate(cur.getDate() + 1); }
    // Normalize against the max of ONLY the drawn cells, so an off-window peak
    // (from a wider range selection) can't dim the visible grid.
    let max = 0;
    for (const k of keys) max = Math.max(max, (byDay[k] || {}).activeMs || 0);
    for (const k of keys) {
      const ms = (byDay[k] || {}).activeMs || 0;
      const cell = document.createElement('div');
      cell.className = 'cell';
      if (ms > 0 && max > 0) {
        const lvl = Math.min(1, ms / max);
        cell.style.background = 'rgba(74, 222, 128, ' + (0.18 + lvl * 0.72).toFixed(2) + ')';
      }
      cell.title = k + ' · ' + fmtH(ms);
      cell.addEventListener('click', () => openDay(k));
      grid.appendChild(cell);
    }
  }

  // ── Churn sparkline ─────────────────────────────────────
  function renderChurn(byDay, days) {
    const svg = $('churn-svg');
    svg.innerHTML = '';
    const ns = 'http://www.w3.org/2000/svg';
    const W = 800, H = 60;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const day = byDay[dayKey(d.getTime())] || {};
      series.push({ d, add: day.linesAdded || 0, rem: day.linesRemoved || 0 });
    }
    churnSeries = series;
    const maxAdd = Math.max(1, ...series.map((s) => s.add));
    const maxRem = Math.max(1, ...series.map((s) => s.rem));
    const maxBoth = Math.max(maxAdd, maxRem);
    const half = H / 2;
    const bw = W / series.length;
    series.forEach((s, i) => {
      const ah = (s.add / maxBoth) * (half - 2);
      const rh = (s.rem / maxBoth) * (half - 2);
      const a = document.createElementNS(ns, 'rect');
      a.setAttribute('x', (i * bw + 0.5).toFixed(1));
      a.setAttribute('y', (half - ah).toFixed(1));
      a.setAttribute('width', (bw - 1).toFixed(1));
      a.setAttribute('height', ah.toFixed(1));
      a.setAttribute('class', 'add');
      svg.appendChild(a);
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', (i * bw + 0.5).toFixed(1));
      r.setAttribute('y', half.toFixed(1));
      r.setAttribute('width', (bw - 1).toFixed(1));
      r.setAttribute('height', rh.toFixed(1));
      r.setAttribute('class', 'rem');
      svg.appendChild(r);
    });
  }

  // ── Tables ──────────────────────────────────────────────
  function renderTable(target, rows, opts = {}) {
    const tbl = $(target);
    tbl.innerHTML = '';
    if (!rows.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td class="name" style="color: var(--text-3);">—</td><td class="val">—</td>';
      tbl.appendChild(tr);
      return;
    }
    rows.forEach((r) => {
      const tr = document.createElement('tr');
      if (r.onClick) tr.classList.add('clickable');
      const ico = r.color ? '<span class="ico" style="background:' + r.color + '"></span>' : '';
      const nameHtml = opts.mono
        ? '<code style="font-family: JetBrains Mono, monospace; font-size: 12px;">' + ico + esc(r.name) + '</code>'
        : ico + esc(r.name);
      tr.innerHTML = '<td class="name">' + nameHtml + '</td>' +
                     '<td class="val">' + esc(r.val) + (r.unit ? '<span class="u">' + esc(r.unit) + '</span>' : '') + '</td>';
      if (r.onClick) tr.addEventListener('click', r.onClick);
      tbl.appendChild(tr);
    });
  }

  // ── Achievements ────────────────────────────────────────
  function renderAchievements(a) {
    const list = [
      { t: 'First session',   ok: (a.sessions || 0) >= 1,   s: '1', ico: '◉' },
      { t: 'Week streak',     ok: (a.longestStreak || 0) >= 7,  s: '7 days', ico: '◆' },
      { t: 'Month streak',    ok: (a.longestStreak || 0) >= 30, s: '30 days', ico: '◇' },
      { t: '1k prompts',      ok: (a.userMessages || 0) >= 1000, s: '1k', ico: '◈' },
      { t: '10k lines',       ok: (a.linesAdded || 0) >= 10000, s: '10k', ico: '◍' },
      { t: '100 sessions',    ok: (a.sessions || 0) >= 100, s: '100', ico: '◎' },
    ];
    const root = $('achievements');
    root.innerHTML = '';
    for (const it of list) {
      const el = document.createElement('div');
      el.className = 'achievement' + (it.ok ? ' unlocked' : '');
      el.innerHTML = '<span class="ico">' + it.ico + '</span><div class="t">' + it.t + '</div><div class="s">' + it.s + '</div>';
      root.appendChild(el);
    }
  }

  // ── Cost panel ──────────────────────────────────────────
  function renderCost(a) {
    $('cost-figure').textContent = fmtCost(a.estimatedCost || 0);
    const hours = (a.activeMs || 0) / 3_600_000;
    const perHour = hours > 0.05 ? a.estimatedCost / hours : 0;
    $('cost-figure-sub').textContent = (perHour ? fmtCost(perHour) + ' / hour' : 'across the range');
    const byModel = a.costByModel || {};
    const entries = Object.entries(byModel).sort((x, y) => y[1] - x[1]).slice(0, 6);
    const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
    const bars = $('cost-bars');
    bars.innerHTML = '';
    for (const [model, cost] of entries) {
      const w = Math.max(2, (cost / total) * 100);
      const row = document.createElement('div');
      row.className = 'cost-bar';
      row.innerHTML = '<span class="name">' + esc(model) + '</span>' +
        '<span class="track"><span class="fill" style="width:' + w.toFixed(0) + '%"></span></span>' +
        '<span class="val">' + fmtCost(cost) + '</span>';
      bars.appendChild(row);
    }
    if (!entries.length) bars.innerHTML = '<div style="color: var(--text-3); font-size: 12px;">No data in range</div>';
  }

  // ── Languages panel ─────────────────────────────────────
  function renderLanguages(langs) {
    const entries = Object.entries(langs || {}).sort((x, y) => y[1].edits - x[1].edits).slice(0, 5);
    const total = entries.reduce((s, [, v]) => s + v.edits, 0) || 1;
    const stack = $('lang-stack');
    stack.innerHTML = '';
    for (const [name, v] of entries) {
      const span = document.createElement('span');
      span.style.background = LANGS[name] || '#888';
      span.style.width = ((v.edits / total) * 100).toFixed(2) + '%';
      span.title = name + ' · ' + v.edits;
      stack.appendChild(span);
    }
    const list = $('lang-list');
    list.innerHTML = '';
    for (const [name, v] of entries) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = '<span class="swatch" style="background:' + (LANGS[name] || '#888') + '"></span>' +
        '<span class="name">' + esc(name) + '</span>' +
        '<span class="val">' + fmtN(v.edits) + ' edits · ' + fmtN(v.files) + ' files</span>';
      list.appendChild(row);
    }
    if (!entries.length) list.innerHTML = '<div style="color: var(--text-3); font-size: 12px;">No language data yet</div>';
  }

  // ── Discord rotation ────────────────────────────────────
  function renderRotation() {
    const live = allFrames.filter((f) => f.passes);
    if (live.length) {
      currentLiveIdx = currentLiveIdx % live.length;
      const f = live[currentLiveIdx];
      const liveOrder = allFrames.map((af, i) => af.passes ? i : -1).filter((i) => i >= 0);
      const allIdx = liveOrder[currentLiveIdx];
      // Mirror to both the top live rail and the bottom Discord card.
      $('frame-details').textContent = f.details || '—';
      $('frame-state').textContent = f.state || '—';
      $('frame-details-2').textContent = f.details || '—';
      $('frame-state-2').textContent = f.state || '—';
      $('frame-num').textContent = 'Frame ' + (allIdx + 1) + '/' + allFrames.length;
      $('frame-no').textContent = 'Frame ' + (allIdx + 1) + ' of ' + allFrames.length;
    }
    $('frames-live').textContent = live.length;
    $('frames-total').textContent = allFrames.length;
    const ul = $('rotation-list');
    ul.innerHTML = '';
    const liveOrder = allFrames.map((af, i) => af.passes ? i : -1).filter((i) => i >= 0);
    const onAir = liveOrder[currentLiveIdx];
    allFrames.forEach((f, i) => {
      const li = document.createElement('li');
      const isCurrent = i === onAir;
      li.className = isCurrent ? 'current' : f.passes ? 'live' : 'skip';
      const summary = f.passes ? ((f.details || '—') + (f.state ? ' · ' + f.state : '')) : (f.details || '—');
      li.innerHTML = '<span class="pip"></span><span class="frame-text">' + esc(summary) + '</span>';
      ul.appendChild(li);
    });
  }

  // ── Drawer (project) ────────────────────────────────────
  async function openProject(name) {
    location.hash = '#projects/' + encodeURIComponent(name);
    const p = (aggData?.projects || {})[name];
    if (!p) return;
    $('drawer-title').textContent = name;
    $('drawer-sub').textContent = p.sessions + ' sessions · ' + fmtH(p.activeMs) + ' active';
    $('drawer-body').innerHTML = [
      ['Active time', fmtH(p.activeMs)],
      ['Prompts', fmtN(p.userMessages)],
      ['Tool calls', fmtN(p.toolCalls)],
      ['Lines added', fmtN(p.linesAdded || 0)],
      ['Lines removed', fmtN(p.linesRemoved || 0)],
      ['Estimated cost', fmtCost(p.cost || 0)],
      ['Tokens in', fmtN(p.inputTokens)],
      ['Tokens out', fmtN(p.outputTokens)],
    ].map(([k, v]) => '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>').join('');
    $('scrim').classList.add('open');
    $('drawer').classList.add('open');
  }
  function closeDrawer() {
    $('scrim').classList.remove('open');
    $('drawer').classList.remove('open');
    if (location.hash.startsWith('#projects/')) location.hash = '';
  }
  $('scrim').addEventListener('click', closeDrawer);
  $('drawer-close').addEventListener('click', closeDrawer);

  // ── Modal (day) ─────────────────────────────────────────
  async function openDay(k) {
    location.hash = '#days/' + k;
    const day = (aggData?.byDay || {})[k];
    if (!day) {
      $('modal-title').textContent = k;
      $('modal-sub').textContent = 'No activity';
      $('modal-body').innerHTML = '';
    } else {
      $('modal-title').textContent = new Date(k + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      $('modal-sub').textContent = fmtH(day.activeMs) + ' active · ' + (day.sessions || 0) + ' sessions';
      $('modal-body').innerHTML = [
        ['Prompts', fmtN(day.userMessages)],
        ['Tool calls', fmtN(day.toolCalls)],
        ['Lines added', fmtN(day.linesAdded || 0)],
        ['Lines removed', fmtN(day.linesRemoved || 0)],
        ['Cost', fmtCost(day.cost || 0)],
        ['Tokens', fmtN((day.inputTokens || 0) + (day.outputTokens || 0) + (day.cacheReadTokens || 0) + (day.cacheWriteTokens || 0))],
        ['Notifications', day.notifications || 0],
      ].map(([k, v]) => '<div class="kv" style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px;"><span style="color:var(--text-3);">' + k + '</span><span style="font-weight:500;">' + v + '</span></div>').join('');
    }
    $('modal').classList.add('open');
    $('scrim').classList.add('open');
  }
  function closeModal() {
    $('modal').classList.remove('open');
    $('scrim').classList.remove('open');
    if (location.hash.startsWith('#days/')) location.hash = '';
  }
  $('modal-close').addEventListener('click', closeModal);
  $('scrim').addEventListener('click', closeModal);

  // ── Help ────────────────────────────────────────────────
  $('help').addEventListener('click', () => $('help').classList.remove('open'));
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === '?') { e.preventDefault(); $('help').classList.toggle('open'); }
    if (e.key === 'Escape') { closeDrawer(); closeModal(); $('help').classList.remove('open'); }
    if (e.key === 't') {
      const cur = localStorage.getItem('theme') || 'dark';
      localStorage.setItem('theme', cur === 'dark' ? 'light' : 'dark'); applyTheme();
    }
    if (e.key >= '1' && e.key <= '5') {
      const pills = ['7d', '30d', '90d', '1y', 'all'];
      const target = document.querySelector('[data-range="' + pills[parseInt(e.key, 10) - 1] + '"]');
      if (target) target.click();
    }
  });

  // ── State refresh ───────────────────────────────────────
  async function fetchAggregate() {
    try {
      const r = await fetch('/api/aggregate?range=' + range, { cache: 'no-store' });
      aggData = await r.json();
      drawAggregate();
    } catch (e) { console.error(e); }
  }

  // The heatmap always shows the same fixed ~90-day window, so it has its own
  // fetch decoupled from the range pill.
  async function fetchHeatmap() {
    try {
      const r = await fetch('/api/aggregate?range=90d', { cache: 'no-store' });
      heatmapByDay = (await r.json()).byDay || {};
      renderHeatmap(heatmapByDay);
    } catch (e) { console.error(e); }
  }

  async function fetchInsights() {
    try {
      const r = await fetch('/api/insights');
      const j = await r.json();
      const root = $('insights');
      root.innerHTML = '';
      for (const line of (j.insights || [])) {
        const el = document.createElement('div');
        el.className = 'insight';
        el.textContent = line;
        root.appendChild(el);
      }
      if (!(j.insights || []).length) root.innerHTML = '<div class="insight">Keep working — insights appear once you have a few days of activity.</div>';
    } catch (e) { console.error(e); }
  }

  function drawAggregate() {
    if (!aggData) return;
    const days = range === '7d' ? 7 : range === '30d' ? 30 : range === '1y' ? 365 : range === 'all' ? 365 : 90;
    renderChart(aggData.byDay || {}, days);
    renderHeatmap(heatmapByDay || aggData.byDay || {});
    renderChurn(aggData.byDay || {}, Math.min(days, 90));
    renderCost(aggData);
    renderLanguages(aggData.languages);
    renderAchievements(aggData);

    // Range stat card
    const [rn, ru] = splitTime(fmtH(aggData.activeMs || 0));
    $('range-num').textContent = rn;
    $('range-unit').textContent = ru === 'h' ? 'hrs' : ru;
    $('range-sub').textContent = fmtN(aggData.userMessages || 0) + ' prompts · ' + fmtN(aggData.grandTokens || 0) + ' tok';

    // Range delta vs the prior identical window (server-computed priorActiveMs).
    // Neutral when there's no prior data (fresh install / the 'all' range), so
    // we don't show a misleading full-height arrow against an empty baseline.
    if (aggData.priorActiveMs > 0) {
      setDelta($('range-delta'), (aggData.activeMs || 0) - aggData.priorActiveMs, 'vs prior');
    } else {
      setDelta($('range-delta'), 0, '');
    }

    // Cost card
    $('cost-num').textContent = fmtCost(aggData.estimatedCost || 0);
    $('cost-sub').textContent = fmtN(aggData.grandTokens || 0) + ' tokens';

    // Lifetime tokens card
    const grand = (aggData.inputTokens || 0) + (aggData.outputTokens || 0) + (aggData.cacheReadTokens || 0) + (aggData.cacheWriteTokens || 0);
    $('tok-grand').textContent = fmtN(grand);
    $('tok-out').textContent = fmtN(aggData.outputTokens || 0);
    const cache = (aggData.cacheReadTokens || 0) + (aggData.cacheWriteTokens || 0);
    $('tok-cache').textContent = fmtN(cache);
    $('tok-in-sub').textContent = 'input ' + fmtN(aggData.inputTokens || 0);
    $('tok-cache-sub').textContent = 'read ' + fmtN(aggData.cacheReadTokens || 0) + ' · write ' + fmtN(aggData.cacheWriteTokens || 0);
    $('tok-cache-pct').textContent = grand ? Math.round((cache / grand) * 100) + '%' : '0%';

    // Code churn numbers
    $('churn-added').textContent = '+' + fmtN(aggData.linesAdded || 0);
    $('churn-removed').textContent = '−' + fmtN(aggData.linesRemoved || 0);
    const net = (aggData.linesAdded || 0) - (aggData.linesRemoved || 0);
    $('churn-net').textContent = (net >= 0 ? '+' : '−') + fmtN(Math.abs(net));

    // Leaderboards
    const projs = Object.entries(aggData.projects || {}).sort((x, y) => y[1].activeMs - x[1].activeMs).slice(0, 8);
    renderTable('projects-tbl', projs.map(([name, p]) => {
      const h = p.activeMs / 3_600_000;
      const val = h < 1 ? Math.round(h * 60) : h < 10 ? h.toFixed(1) : Math.round(h);
      return { name, val: String(val), unit: h < 1 ? 'm' : 'h', onClick: () => openProject(name) };
    }));
    const tools = Object.entries(aggData.toolBreakdown || {}).sort((x, y) => y[1] - x[1]).slice(0, 8);
    renderTable('tools-tbl', tools.map(([name, count]) => ({ name, val: fmtN(count), unit: '' })), { mono: true });
    const files = (aggData.topEditedFiles || []).slice(0, 8);
    renderTable('files-tbl', files.map((f) => ({ name: f.file || (f.path || '').split('/').pop(), val: fmtN(f.count), unit: '' })), { mono: true });

    // Bash / domains / subagents
    const bash = Object.entries(aggData.bashCommands || {}).sort((x, y) => y[1] - x[1]).slice(0, 8);
    renderTable('bash-tbl', bash.map(([name, count]) => ({ name, val: fmtN(count), unit: '' })), { mono: true });
    const domains = Object.entries(aggData.webDomains || {}).sort((x, y) => y[1] - x[1]).slice(0, 8);
    renderTable('domains-tbl', domains.map(([name, count]) => ({ name, val: fmtN(count), unit: '' })), { mono: true });
    const sa = Object.entries(aggData.subagents || {}).sort((x, y) => y[1] - x[1]).slice(0, 8);
    renderTable('subagents-tbl', sa.map(([name, count]) => ({ name, val: fmtN(count), unit: '' })));

    const tot = (aggData.mcpToolCalls || 0) + (aggData.builtinToolCalls || 0);
    $('mcp-label').textContent = tot ? Math.round(((aggData.mcpToolCalls || 0) / tot) * 100) + '% MCP · ' + Math.round(((aggData.builtinToolCalls || 0) / tot) * 100) + '% built-in' : '—';

    $('lb-sessions').textContent = fmtN(aggData.sessions || 0);
  }

  function drawState() {
    if (!liveData) return;
    const a = liveData.aggregate;
    const v = liveData.vars;
    const s = liveData.state;

    // Top bar
    const now = new Date();
    $('meta').textContent = 'No. ' + (v.daysSinceFirst || '—') + ' · ' + now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    $('model').textContent = v.modelPretty;
    $('statustext').textContent = v.statusVerbose;
    $('dot').className = 'dot ' + (s.status === 'working' || s.status === 'thinking' ? '' : s.status === 'idle' ? 'idle' : 'stale');

    // Live avatar
    const cfgAvatar = (s.status && liveData.config?.statusAssets?.[s.status]) || '';
    $('live-avatar').innerHTML = cfgAvatar
      ? '<img src="' + cfgAvatar.replace(/"/g, '&quot;') + '" alt="" />'
      : '';
    $('elapsed').textContent = elapsedStr(s.sessionStart);

    // Hero
    const [hn, hu] = splitTime(v.allHours);
    $('hero-num').textContent = hn;
    $('hero-unit').textContent = hu === 'h' ? 'hours' : hu === 'm' ? 'minutes' : hu;
    $('hero-caption').innerHTML =
      'on Claude Code · day <strong>' + (v.daysSinceFirst || 1) + '</strong> · ' +
      '<strong>' + (a.sessions || 0).toLocaleString() + '</strong> sessions · ' +
      '<strong>' + (a.userMessages || 0).toLocaleString() + '</strong> prompts.';

    // Today
    const [tn, tu] = splitTime(v.todayHours);
    $('today-num').textContent = tn;
    $('today-unit').textContent = tu === 'h' ? 'hrs' : tu;
    $('today-sub').textContent = (v.todayPrompts || 0) + ' prompts · ' + (v.todayTokensFmt || '0');

    const todayMs = ((a.byDay || {})[dayKey(Date.now())] || {}).activeMs || 0;
    const yest = new Date(); yest.setHours(0,0,0,0); yest.setDate(yest.getDate() - 1);
    const yMs = ((a.byDay || {})[dayKey(yest.getTime())] || {}).activeMs || 0;
    setDelta($('today-delta'), todayMs - yMs, 'vs yest.');

    // Streak
    $('streak-num').textContent = v.streak;
    $('streak-sub').textContent = 'Longest ' + v.longestStreak + ' · best ' + (v.bestDayHours || '—');

    // Discord
    allFrames = liveData.frames || [];
    renderRotation();
  }

  // ── SSE ────────────────────────────────────────────────
  function startSse() {
    try {
      $('conn-state').textContent = 'connecting';
      const ev = new EventSource('/events');
      ev.onopen = () => { $('conn-state').textContent = 'live'; };
      ev.onmessage = async (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d.type === 'state') await refreshState();
          if (d.type === 'aggregate') {
            await refreshState();
            await fetchAggregate();
            await fetchInsights();
            await fetchHeatmap();
          }
        } catch { /* malformed SSE frame — wait for the next one */ }
      };
      // CLOSED = EventSource gave up (no auto-retry); otherwise a native
      // reconnect is already in flight. No blind timer flipping back to "live"
      // while the daemon is actually down.
      ev.onerror = () => { $('conn-state').textContent = ev.readyState === EventSource.CLOSED ? 'offline' : 'reconnecting'; };
    } catch { /* EventSource constructor failed (very old browser) — dashboard falls back to one-shot fetches */ }
  }

  async function refreshState() {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      liveData = await r.json();
      drawState();
    } catch (e) { console.error(e); }
  }

  // Elapsed tick — light, just updates the number.
  setInterval(() => {
    if (liveData?.state?.sessionStart) $('elapsed').textContent = elapsedStr(liveData.state.sessionStart);
  }, 1000);

  // Rotation cycle
  rotationTimer = setInterval(() => { currentLiveIdx++; renderRotation(); }, 4000);

  // ── Chart hover tooltips ────────────────────────────────────────────────
  // Native SVG charts, no library. preserveAspectRatio="none" means the
  // x-axis scales linearly with rendered width, so the cursor's fraction
  // across the SVG maps straight to a data index. A single cursor-following
  // tooltip is reused for both the activity chart and the churn sparkline.
  function setupChartTooltips() {
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    document.body.appendChild(tip);
    const hide = () => tip.classList.remove('show');
    const show = (e, text) => {
      tip.textContent = text;
      tip.classList.add('show');
      tip.style.left = (e.clientX + 12) + 'px';
      tip.style.top  = (e.clientY - 34) + 'px';
    };
    const idxAt = (e, svg, n) => {
      if (!n) return -1;
      const r = svg.getBoundingClientRect();
      if (r.width <= 0) return -1;
      const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      return Math.round(frac * (n - 1));
    };
    const wire = (svg, getSeries, fmt) => {
      if (!svg) return;
      const host = svg.parentElement || svg;
      host.addEventListener('mousemove', (e) => {
        const s = getSeries();
        const i = idxAt(e, svg, s.length);
        if (i < 0) { hide(); return; }
        show(e, fmt(s[i]));
      });
      host.addEventListener('mouseleave', hide);
    };
    const md = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    wire($('chart'),     () => chartSeries, (p) => md(p.d) + ' · ' + fmtH(p.ms));
    wire($('churn-svg'), () => churnSeries, (s) => md(s.d) + ' · +' + fmtN(s.add) + ' / −' + fmtN(s.rem));
  }
  setupChartTooltips();

  // Initial load.
  (async () => {
    await refreshState();
    await fetchAggregate();
    await fetchInsights();
    await fetchHeatmap();
    startSse();
    // Restore deep link.
    if (location.hash.startsWith('#projects/')) openProject(decodeURIComponent(location.hash.slice(10)));
    else if (location.hash.startsWith('#days/')) openDay(location.hash.slice(6));
  })();
})();
