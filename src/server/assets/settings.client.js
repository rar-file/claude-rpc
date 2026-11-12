// /settings runtime — vanilla, one IIFE, no build step.
//
// `base` is the config as the server showed it; `cfg` is the working copy the
// form edits. Save sends both, and the server writes only what differs (see
// src/config-edit.js), so defaults are never frozen into the user's file.
(function () {
  const $ = (id) => document.getElementById(id);
  const clone = (v) => JSON.parse(JSON.stringify(v));

  let base = null;       // config as loaded
  let cfg = null;        // working copy
  let live = {};         // live template variables, for the preview
  let statuses = [];
  let status = 'working';
  let lastTemplateInput = null;

  // ── tiny DOM helper ────────────────────────────────────────────────────
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children || [])) if (c) n.appendChild(c);
    return n;
  }

  async function api(path, body) {
    const opts = body === undefined ? {} : {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
    let res;
    try { res = await fetch(path, opts); }
    catch { return { error: "Can't reach the dashboard — is `claude-rpc serve` still running?" }; }
    try { return await res.json(); }
    catch { return { error: 'Unexpected reply from the dashboard (' + res.status + ')' }; }
  }

  // ── config accessors ───────────────────────────────────────────────────
  function statusBlock() {
    cfg.presence = cfg.presence || {};
    cfg.presence.byStatus = cfg.presence.byStatus || {};
    return (cfg.presence.byStatus[status] = cfg.presence.byStatus[status] || {});
  }
  function frames() {
    const b = statusBlock();
    return Array.isArray(b.rotation) ? b.rotation : [];
  }
  // An emptied list is stored as [] when the loaded config had frames there:
  // deleting the key would bring the default frames back on the next load.
  function storeFrames(block, name, list) {
    const had = Array.isArray((((base.presence || {}).byStatus || {})[name] || {}).rotation);
    if (list.length || had) block.rotation = list;
    else delete block.rotation;
  }
  function setFrames(list) { storeFrames(statusBlock(), status, list); }

  // ── template preview ───────────────────────────────────────────────────
  // Same shape as the daemon's fill: unknown or empty variables render as
  // nothing, then separators left dangling by an empty value are tidied.
  function fill(tpl) {
    if (!tpl) return '';
    return String(tpl)
      .replace(/\{(\w+)\}/g, (m, k) => (live[k] === undefined || live[k] === null ? '' : String(live[k])))
      .replace(/(\s*·\s*)+/g, ' · ')
      .replace(/^\s*·\s*|\s*·\s*$/g, '')
      .trim();
  }

  function renderPreview() {
    const b = statusBlock();
    $('pv-app').textContent = cfg.appName || 'Claude Code';
    $('pv-details').textContent = fill(b.details) || '—';
    $('pv-state').textContent = fill(b.state);
    const url = (cfg.statusAssets || {})[status] || (cfg.presence || {}).largeImageKey || '';
    const av = $('pv-avatar');
    av.textContent = '';
    if (/^https?:\/\//i.test(url)) av.appendChild(el('img', { src: url, alt: '' }));
  }

  // ── Card section ───────────────────────────────────────────────────────
  function renderTabs() {
    const root = $('status-tabs');
    root.textContent = '';
    for (const s of statuses) {
      root.appendChild(el('button', {
        role: 'tab', 'aria-selected': String(s === status), text: s,
        onclick: () => { status = s; renderCard(); },
      }));
    }
  }

  function requiresText(f) {
    return Array.isArray(f.requires) ? f.requires.join(', ') : (f.requires || '');
  }
  function parseRequires(text) {
    const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
    return parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : parts;
  }

  function templateInput(value, placeholder, label, oninput) {
    return el('input', {
      type: 'text', value: value || '', placeholder, 'aria-label': label, autocomplete: 'off',
      'data-template': true, oninput: (e) => oninput(e.target.value),
    });
  }

  function renderFrames() {
    const root = $('frames');
    root.textContent = '';
    const list = frames();
    if (!list.length) root.appendChild(el('div', { class: 'empty', text: 'No extra frames for this status.' }));
    list.forEach((f, i) => {
      const update = (key, val) => {
        const next = clone(frames());
        if (val === undefined || val === '') delete next[i][key];
        else next[i][key] = val;
        setFrames(next);
        changed();
      };
      root.appendChild(el('div', { class: 'frame-row' }, [
        templateInput(f.details, 'Top line', 'Frame ' + (i + 1) + ' top line', (v) => update('details', v)),
        templateInput(f.state, 'Bottom line', 'Frame ' + (i + 1) + ' bottom line', (v) => update('state', v)),
        el('input', {
          type: 'text', value: requiresText(f), placeholder: 'Only when…', autocomplete: 'off',
          'aria-label': 'Frame ' + (i + 1) + ' condition', title: 'Value name that must be non-empty, e.g. streak',
          oninput: (e) => update('requires', parseRequires(e.target.value)),
        }),
        el('button', {
          class: 'x', text: '×', 'aria-label': 'Remove frame ' + (i + 1),
          onclick: () => { const next = clone(frames()); next.splice(i, 1); setFrames(next); renderFrames(); changed(); },
        }),
      ]));
    });
  }

  function renderCard() {
    renderTabs();
    const b = statusBlock();
    $('f-details').value = b.details || '';
    $('f-state').value = b.state || '';
    $('f-hover').value = b.largeImageText || '';
    $('f-asset').value = (cfg.statusAssets || {})[status] || '';
    renderFrames();
    renderPreview();
  }

  // ── Discord section ────────────────────────────────────────────────────
  function buttons() { return Array.isArray((cfg.presence || {}).buttons) ? cfg.presence.buttons : []; }
  function setButtons(list) { cfg.presence = cfg.presence || {}; cfg.presence.buttons = list; }

  function renderButtons() {
    const root = $('buttons');
    root.textContent = '';
    const list = buttons();
    if (!list.length) root.appendChild(el('div', { class: 'empty', text: 'No buttons.' }));
    list.forEach((b, i) => {
      const update = (key, val) => { const next = clone(buttons()); next[i][key] = val; setButtons(next); changed(); };
      root.appendChild(el('div', { class: 'button-row' }, [
        el('input', { type: 'text', value: b.label || '', placeholder: 'Label', 'aria-label': 'Button ' + (i + 1) + ' label', maxlength: 32, oninput: (e) => update('label', e.target.value) }),
        el('input', { type: 'url', value: b.url || '', placeholder: 'https://…', 'aria-label': 'Button ' + (i + 1) + ' link', oninput: (e) => update('url', e.target.value.trim()) }),
        el('button', { class: 'x', text: '×', 'aria-label': 'Remove button ' + (i + 1), onclick: () => { const next = clone(buttons()); next.splice(i, 1); setButtons(next); renderButtons(); changed(); } }),
      ]));
    });
    $('add-button').disabled = list.length >= 2;
  }

  function renderForm() {
    renderCard();
    $('f-appName').value = cfg.appName || '';
    $('f-clientId').value = cfg.clientId || '';
    $('f-activityType').value = String(cfg.activityType == null ? 0 : cfg.activityType);
    $('f-showElapsed').checked = cfg.showElapsed !== false;
    $('f-githubButton').checked = (cfg.presence || {}).githubButton !== false;
    renderButtons();
    $('f-rotation').value = cfg.rotationIntervalMs == null ? '' : Math.round(cfg.rotationIntervalMs / 1000);
    $('f-idle').value = cfg.idleThresholdSec == null ? '' : cfg.idleThresholdSec;
    $('f-stale').value = cfg.staleSessionMin == null ? '' : cfg.staleSessionMin;
    $('f-shipped').value = cfg.shippedFrameSec == null ? '' : cfg.shippedFrameSec;
    $('f-hideWhenStale').checked = cfg.hideWhenStale !== false;
    $('f-notify').checked = !!(cfg.notify && cfg.notify.enabled);
  }

  // ── form → cfg bindings ────────────────────────────────────────────────
  function bind(id, apply, event) {
    $(id).addEventListener(event || 'input', (e) => { apply(e.target); changed(); });
  }
  // A cleared text line is removed from the block, so the daemon uses its default.
  const setOrDelete = (obj, key, val) => { if (val === '') delete obj[key]; else obj[key] = val; };
  // A cleared number is removed too; a typed one is stored scaled (sec → ms).
  const numOrDelete = (key, scale) => (t) => {
    if (t.value === '' || !Number.isFinite(Number(t.value))) delete cfg[key];
    else cfg[key] = Math.max(0, Number(t.value)) * (scale || 1);
  };

  function wire() {
    bind('f-details', (t) => { setOrDelete(statusBlock(), 'details', t.value); renderPreview(); });
    bind('f-state', (t) => { setOrDelete(statusBlock(), 'state', t.value); renderPreview(); });
    bind('f-hover', (t) => setOrDelete(statusBlock(), 'largeImageText', t.value));
    bind('f-asset', (t) => {
      cfg.statusAssets = cfg.statusAssets || {};
      setOrDelete(cfg.statusAssets, status, t.value.trim());
      renderPreview();
    });
    bind('f-appName', (t) => { setOrDelete(cfg, 'appName', t.value.trim()); renderPreview(); });
    bind('f-clientId', (t) => { cfg.clientId = t.value.trim(); });
    bind('f-activityType', (t) => { cfg.activityType = Number(t.value) || 0; }, 'change');
    bind('f-showElapsed', (t) => { cfg.showElapsed = t.checked; }, 'change');
    bind('f-githubButton', (t) => { cfg.presence = cfg.presence || {}; cfg.presence.githubButton = t.checked; }, 'change');
    bind('f-rotation', numOrDelete('rotationIntervalMs', 1000));
    bind('f-idle', numOrDelete('idleThresholdSec'));
    bind('f-stale', numOrDelete('staleSessionMin'));
    bind('f-shipped', numOrDelete('shippedFrameSec'));
    bind('f-hideWhenStale', (t) => { cfg.hideWhenStale = t.checked; }, 'change');
    bind('f-notify', (t) => { cfg.notify = cfg.notify || {}; cfg.notify.enabled = t.checked; }, 'change');

    $('add-frame').addEventListener('click', () => {
      setFrames(clone(frames()).concat([{ details: '', state: '' }]));
      renderFrames();
      changed();
      const rows = $('frames').querySelectorAll('.frame-row');
      if (rows.length) rows[rows.length - 1].querySelector('input').focus();
    });
    $('add-button').addEventListener('click', () => {
      if (buttons().length >= 2) return;
      setButtons(clone(buttons()).concat([{ label: '', url: '' }]));
      renderButtons();
      changed();
      const rows = $('buttons').querySelectorAll('.button-row');
      rows[rows.length - 1].querySelector('input').focus();
    });

    // "Insert value" — drops {name} at the cursor of the last template line
    // the user was in.
    const noteTemplateInput = (e) => {
      if (e.target.matches && e.target.matches('#f-details, #f-state, #f-hover, [data-template]')) lastTemplateInput = e.target;
    };
    document.addEventListener('focusin', noteTemplateInput);
    document.addEventListener('input', noteTemplateInput);
    $('var-pick').addEventListener('change', (e) => {
      const name = e.target.value;
      e.target.value = '';
      const input = lastTemplateInput && document.contains(lastTemplateInput) ? lastTemplateInput : $('f-details');
      if (!name) return;
      const at = input.selectionStart == null ? input.value.length : input.selectionStart;
      const end = input.selectionEnd == null ? at : input.selectionEnd;
      input.value = input.value.slice(0, at) + '{' + name + '}' + input.value.slice(end);
      input.focus();
      input.setSelectionRange(at + name.length + 2, at + name.length + 2);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    $('save').addEventListener('click', save);
    $('revert').addEventListener('click', () => { cfg = clone(base); renderForm(); changed(); });
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (dirty()) save(); }
    });
    window.addEventListener('beforeunload', (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });

    $('daemon-start').addEventListener('click', () => daemon('start'));
    $('daemon-stop').addEventListener('click', () => daemon('stop'));
    $('daemon-restart').addEventListener('click', () => daemon('restart'));
    $('log-details').addEventListener('toggle', () => { if ($('log-details').open) refreshLog(); });
  }

  // ── save bar ───────────────────────────────────────────────────────────
  const dirty = () => !!base && JSON.stringify(base) !== JSON.stringify(cfg);
  let noticeTimer = null;

  function bar(kind, msg) {
    const b = $('savebar');
    b.className = 'savebar' + (kind ? ' ' + kind : '');
    $('save-msg').textContent = msg;
    const editing = kind === '' || kind === 'err';
    $('save').hidden = !editing || !dirty();
    $('revert').hidden = !editing || !dirty();
    b.hidden = false;
  }
  function changed() {
    clearTimeout(noticeTimer);
    if (dirty()) bar('', 'Unsaved changes');
    else $('savebar').hidden = true;
  }

  // Rows the user added and left blank aren't settings — drop them rather
  // than write empty frames/buttons into the file.
  function pruneBlanks() {
    for (const [name, block] of Object.entries((cfg.presence || {}).byStatus || {})) {
      if (!Array.isArray(block.rotation)) continue;
      storeFrames(block, name, block.rotation.filter((f) => f && (f.details || f.state)));
    }
    if (Array.isArray((cfg.presence || {}).buttons)) {
      cfg.presence.buttons = cfg.presence.buttons.filter((b) => b && (b.label || b.url));
    }
  }

  async function save() {
    pruneBlanks();
    $('save').disabled = true;
    const r = await api('/api/settings', { base, edited: cfg });
    $('save').disabled = false;
    if (r.error) { bar('err', r.error); return; }
    base = r.config;
    cfg = clone(base);
    renderForm();
    bar('ok', 'Saved. The card updates within a few seconds.');
    noticeTimer = setTimeout(() => { if (!dirty()) $('savebar').hidden = true; }, 3500);
  }

  // ── daemon ─────────────────────────────────────────────────────────────
  function renderDaemon(d, note) {
    const dot = $('daemon-dot');
    let title, sub, cls;
    if (!d.running) {
      cls = 'down'; title = 'Stopped'; sub = 'Your Discord card is not being updated.';
    } else if (d.ipc === 'up') {
      cls = 'up'; title = 'Running · connected to Discord';
      sub = d.client === 'arrpc' ? 'Through a bridge client (Vesktop, arRPC).' : 'pid ' + d.pid;
    } else {
      cls = 'wait'; title = 'Running · waiting for Discord';
      sub = 'Open the Discord desktop app. It connects within about 15 seconds.';
    }
    dot.className = 'dot ' + cls;
    $('daemon-title').textContent = title;
    $('daemon-sub').textContent = note || sub;
    $('daemon-start').disabled = d.running;
    $('daemon-stop').disabled = !d.running;
    $('daemon-restart').disabled = !d.running;
  }

  async function daemon(action) {
    for (const id of ['daemon-start', 'daemon-stop', 'daemon-restart']) $(id).disabled = true;
    $('daemon-title').textContent = action === 'stop' ? 'Stopping…' : action === 'start' ? 'Starting…' : 'Restarting…';
    $('daemon-sub').textContent = '';
    $('daemon-dot').className = 'dot wait';
    const r = await api('/api/daemon', { action });
    renderDaemon(r.daemon || { running: false }, r.error || '');
    if (r.error) $('log-details').open = true;
    if ($('log-details').open) refreshLog();
  }

  async function refreshLog() {
    const r = await api('/api/log');
    const pre = $('log');
    pre.textContent = r.error ? r.error : (r.content || 'The log is empty.');
    pre.scrollTop = pre.scrollHeight;
  }

  async function pollDaemon() {
    if (document.hidden) return;
    const r = await api('/api/settings');
    if (r.error || !r.daemon) return;
    renderDaemon(r.daemon);
    live = r.live || live;
    if (cfg) renderPreview();
  }

  // ── privacy ────────────────────────────────────────────────────────────
  const LEVELS = [['public', 'Public'], ['name-only', 'Name only'], ['hidden', 'Hidden']];

  async function loadWorkspaces() {
    const root = $('workspaces');
    const r = await api('/api/workspaces');
    root.textContent = '';
    if (r.error) { root.appendChild(el('div', { class: 'empty', text: r.error })); return; }
    if (!r.workspaces.length) {
      root.appendChild(el('div', { class: 'empty', text: 'No projects yet. Use Claude Code in a project and it will appear here.' }));
      return;
    }
    for (const ws of r.workspaces) {
      const current = r.visibility[ws.cwd] || 'public';
      const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Visibility of ' + ws.name });
      for (const [level, label] of LEVELS) {
        seg.appendChild(el('button', {
          text: label, 'aria-pressed': String(level === current),
          onclick: async (e) => {
            const res = await api('/api/workspaces', { cwd: ws.cwd, level });
            if (res.error) { bar('err', res.error); return; }
            for (const b of seg.children) b.setAttribute('aria-pressed', String(b === e.target));
          },
        }));
      }
      root.appendChild(el('div', { class: 'ws-row' }, [
        el('div', { class: 'ws-meta' }, [
          el('div', { class: 'ws-name', text: ws.name }),
          el('div', { class: 'ws-path', text: ws.cwd, title: ws.cwd }),
        ]),
        seg,
      ]));
    }
  }

  // ── boot ───────────────────────────────────────────────────────────────
  async function boot() {
    const r = await api('/api/settings');
    if (r.error) {
      $('load-error').textContent = r.error;
      $('load-error').hidden = false;
      return;
    }
    base = r.config;
    cfg = clone(base);
    live = r.live || {};
    statuses = r.statuses || ['working', 'idle'];
    status = statuses[0];
    const pick = $('var-pick');
    for (const v of r.vars || []) pick.appendChild(el('option', { value: v, text: v }));
    $('config-path').textContent = r.configPath;
    $('version').textContent = 'v' + r.version;
    wire();
    renderForm();
    renderDaemon(r.daemon);
    loadWorkspaces();
    setInterval(pollDaemon, 5000);
  }

  boot();
})();
