(() => {
  'use strict';
  const app = document.getElementById('app');

  // ── format helpers ───────────────────────────────────────────
  const fmtNum = (n) => {
    n = +n || 0;
    if (n < 1000) return String(Math.round(n));
    if (n < 1e6) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    if (n < 1e9) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
    return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  };
  const fmtHours = (ms) => { const h = (ms || 0) / 3.6e6; return h < 1 ? Math.round(h * 60) + 'm' : h < 10 ? h.toFixed(1) + 'h' : Math.round(h) + 'h'; };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const GIF = 'https://cdn.qualit.ly/';

  // anim-stagger style helper
  let _i = 0; const A = () => `style="--i:${_i++}"`;

  // Landing-page CTA used by the finale share. The dashboard is served on
  // localhost, so sharing `location.href` hands the recipient a dead link —
  // the finale shares this public URL + a stats summary instead.
  const LANDING = 'https://claude-rpc.com/?ref=wrapped';
  let _shareText = '';   // built in the finale slide, consumed by wireFinale

  // ── build the story slides from the wrapped payload ──────────
  function buildSlides(d) {
    const out = [];
    const hours = (d.activeMs || 0) / 3.6e6;
    const perDay = d.prompts / Math.max(1, d.daysSinceFirst);
    const pad2 = (h) => String(h).padStart(2, '0');

    const year = new Date(d.generatedAt).getFullYear();
    const S = (cls, body, dur, wm) => { _i = 0; out.push({ cls, html: (wm != null && wm !== '' ? `<div class="wm">${esc(wm)}</div>` : '') + body, dur: dur || 5200 }); };

    // 1. intro
    S('ink', `
      <img class="gif anim" ${A()} src="${GIF}clawd-working-building.gif" alt="" />
      <div class="kicker anim" ${A()}>claude-rpc presents</div>
      <div class="big anim" ${A()}>Your Year<br/>on Claude Code</div>
      <div class="sub anim" ${A()}>${esc(d.daysSinceFirst)} days in the making · tap →</div>`, 4200, year);

    // 2. hours
    S('rust', `
      <div class="kicker anim" ${A()}>you spent</div>
      <div class="huge anim" ${A()}><span data-count="${hours}" data-fmt="1dp">0</span></div>
      <div class="unit anim" ${A()}>hours with Claude</div>
      <div class="sub anim" ${A()}>across ${fmtNum(d.sessions)} sessions${d.bestDay ? ` · your biggest day was ${fmtHours(d.bestDay.hours * 3.6e6)}` : ''}</div>`);

    // 3. sessions + streak
    S('gold', `
      <div class="kicker anim" ${A()}>you opened</div>
      <div class="huge anim" ${A()}><span data-count="${d.sessions}" data-fmt="num">0</span></div>
      <div class="unit anim" ${A()}>sessions</div>
      <div class="sub anim" ${A()}>longest streak: <b>${d.longestStreak} days</b> in a row${d.streak ? ` · ${d.streak} going now` : ''}</div>`);

    // 4. prompts
    S('grass', `
      <div class="kicker anim" ${A()}>you asked</div>
      <div class="huge anim" ${A()}><span data-count="${d.prompts}" data-fmt="num">0</span></div>
      <div class="unit anim" ${A()}>prompts</div>
      <div class="sub anim" ${A()}>that's about <b>${perDay < 10 ? perDay.toFixed(1) : Math.round(perDay)}</b> a day, every day</div>`);

    // 5. tokens
    S('blurple', `
      <div class="kicker anim" ${A()}>you moved</div>
      <div class="huge anim" ${A()}><span data-count="${d.tokens}" data-fmt="num">0</span></div>
      <div class="unit anim" ${A()}>tokens</div>
      <div class="sub anim" ${A()}>${d.cachePct}% reused from cache — Claude has a good memory</div>`);

    // 6. top language
    if (d.topLanguage) S('plum', `
      <div class="kicker anim" ${A()}>you mostly spoke</div>
      <div class="anim" ${A()}><span class="tapebadge pop">${esc(d.topLanguage.name)}</span></div>
      <div class="sub anim" ${A()}>${fmtNum(d.topLanguage.edits)} edits — your number-one language</div>`);

    // 7. hotspot file
    if (d.hotspot) {
      const age = d.hotspot.daysSinceLastEdit == null ? '' : d.hotspot.daysSinceLastEdit === 0 ? ' · still warm today' : ` · last touched ${d.hotspot.daysSinceLastEdit}d ago`;
      S('ink', `
        <div class="kicker anim" ${A()}>you kept coming back to</div>
        <div class="big anim" ${A()} style="font-family:'JetBrains Mono',monospace;font-size:clamp(30px,9vw,68px);--i:1">${esc(d.hotspot.name)}</div>
        <div class="sub anim" ${A()}>${fmtNum(d.hotspot.count)} edits${age}</div>`);
    }

    // 8. peak time
    if (d.peakWeekday && d.peakHour != null) S('rust', `
      <div class="kicker anim" ${A()}>you were in the zone on</div>
      <div class="big anim" ${A()}>${esc(d.peakWeekday.name)}s</div>
      <div class="unit anim" ${A()}>around ${pad2(d.peakHour)}:00</div>
      <div class="sub anim" ${A()}>your most productive window</div>`);

    // 9. model split
    if (d.modelSplit && d.modelSplit.length) {
      const rows = d.modelSplit.filter((m) => m.costPct > 0).map((m) => {
        const pct = Math.round(m.costPct * 100);
        return `<div class="msrow anim" ${A()}><span class="lbl">${esc(m.model)}</span><span class="mstrack"><span class="msfill" style="--w:${pct}%"></span></span><span class="pct">${pct}%</span></div>`;
      }).join('');
      S('paper', `
        <div class="kicker anim" ${A()} style="--i:0">your models, by spend</div>
        <div class="msplit">${rows}</div>
        <div class="sub anim" ${A()} style="opacity:.7">${esc((d.modelSplit[0] || {}).model || '')} did most of the heavy lifting</div>`);
    }

    // 10. lines
    if (d.linesAdded) S('grass', `
      <div class="kicker anim" ${A()}>together you wrote</div>
      <div class="huge anim" ${A()}><span data-count="${d.linesAdded}" data-fmt="num">0</span></div>
      <div class="unit anim" ${A()}>lines of code</div>
      <div class="sub anim" ${A()}>${d.linesNet >= 0 ? '+' : '−'}${fmtNum(Math.abs(d.linesNet))} net after the dust settled</div>`);

    // 11. finale summary
    const cell = (k, v, cls) => `<div><div class="cellk">${k}</div><div class="cellv ${cls || ''}">${v}</div></div>`;
    // Summary that travels with the share — stats + the public install link,
    // so anyone who receives it knows what it is and where to get it.
    _shareText = `My year on Claude Code: ${fmtHours(d.activeMs)} across ${fmtNum(d.sessions)} sessions · `
      + `${fmtNum(d.prompts)} prompts · ${fmtNum(d.tokens)} tokens · ${(d.longestStreak || 0)}d best streak.\n\n`
      + `Made with claude-rpc → ${LANDING}`;
    S('ink', `
      <div class="summary">
        <div class="card pop" style="--i:0">
          <h2>Your Year on Claude Code</h2>
          <div class="meta">day ${d.daysSinceFirst} · ${new Date(d.generatedAt).toISOString().slice(0, 10)}</div>
          <div class="grid">
            ${cell('Time', fmtHours(d.activeMs), 'rust')}
            ${cell('Sessions', fmtNum(d.sessions))}
            ${cell('Prompts', fmtNum(d.prompts))}
            ${cell('Tokens', fmtNum(d.tokens))}
            ${cell('Streak', (d.longestStreak || 0) + 'd')}
            ${cell('Top lang', d.topLanguage ? esc(d.topLanguage.name) : '—')}
            ${cell('Lines', (d.linesNet >= 0 ? '+' : '−') + fmtNum(Math.abs(d.linesNet)), 'grass')}
            ${cell('Hotspot', d.hotspot ? esc(d.hotspot.name) : '—')}
          </div>
          <div class="foot">made with claude-rpc · claude-rpc.com</div>
        </div>
        <div class="actions">
          <button class="btn primary" id="w-replay">↺ replay</button>
          <a class="btn" id="w-poster" href="/api/card.svg?range=all" target="_blank">poster ↗</a>
          <button class="btn" id="w-share">share ↗</button>
        </div>
      </div>
      <div class="hint">screenshot the card, or tap share to spread your wrapped</div>`, 9_000_000); // last slide: effectively no auto-advance

    return out;
  }

  // ── story engine ─────────────────────────────────────────────
  function mount(slides) {
    _i = 0;
    const bars = slides.map(() => `<div class="bar"><i></i></div>`).join('');
    const slideEls = slides.map((s) => `<section class="slide ${s.cls}">${s.html}</section>`).join('');
    app.innerHTML = `<div class="story" id="story">
      <div class="bars">${bars}</div>
      <div class="brandtag">claude wrapped</div>
      ${slideEls}
      <div class="tap left" id="tapL"></div>
      <div class="tap right" id="tapR"></div>
      <div class="hint" id="navhint">← →  ·  space to pause</div>
    </div>`;

    const story = document.getElementById('story');
    const barEls = [...story.querySelectorAll('.bar')];
    const els = [...story.querySelectorAll('.slide')];
    let idx = -1, timer = null, paused = false;

    // Giant faded background number/word per slide — derived from its headline
    // stat. Slides that already carry a .wm (e.g. the intro's year) are skipped.
    els.forEach((s) => {
      if (s.querySelector('.wm')) return;
      const cnt = s.querySelector('[data-count]');
      const big = s.querySelector('.big, .tapebadge');
      let wm = '';
      if (cnt) {
        const t = parseFloat(cnt.dataset.count) || 0;
        wm = (cnt.dataset.fmt === 'num') ? fmtNum(t) : String(Math.round(t));
      } else if (big) {
        wm = (big.textContent || '').trim().split('\n')[0].split(/\s+/)[0];
      }
      if (wm) { const w = document.createElement('div'); w.className = 'wm'; w.textContent = wm; s.prepend(w); }
    });

    function runCountups(slide) {
      slide.querySelectorAll('[data-count]').forEach((node) => {
        const target = parseFloat(node.dataset.count) || 0, fmt = node.dataset.fmt || 'int';
        const dur = 1300, t0 = performance.now();
        const val = (v) => fmt === 'num' ? fmtNum(v) : fmt === '1dp' ? (v < 10 ? v.toFixed(1) : String(Math.round(v))) : String(Math.round(v));
        function tick(t) {
          const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
          node.textContent = val(target * e);
          if (p < 1) requestAnimationFrame(tick); else node.textContent = val(target);
        }
        requestAnimationFrame(tick);
      });
    }

    function go(i) {
      if (i < 0 || i >= slides.length) return;
      idx = i; paused = false; story.classList.remove('paused');
      els.forEach((s, k) => s.classList.toggle('active', k === i));
      barEls.forEach((b, k) => { b.classList.remove('active', 'done'); if (k < i) b.classList.add('done'); });
      const ab = barEls[i];
      ab.style.setProperty('--dur', (slides[i].dur || 5200) + 'ms');
      void ab.offsetWidth; // reflow → restart fill animation
      ab.classList.add('active');
      // The finale carries its own "screenshot to share" hint — hide the
      // nav hint there so the two don't stack at the bottom edge.
      const nh = document.getElementById('navhint');
      if (nh) nh.style.visibility = (i === slides.length - 1) ? 'hidden' : 'visible';
      setTimeout(() => { if (idx === i) runCountups(els[i]); }, 220);
      clearTimeout(timer);
      if (i < slides.length - 1) timer = setTimeout(() => { if (!paused) go(idx + 1); }, slides[i].dur || 5200);
      if (i === slides.length - 1) wireFinale();
    }
    const next = () => go(Math.min(idx + 1, slides.length - 1));
    const prev = () => go(Math.max(idx - 1, 0));
    function pauseToggle() {
      paused = !paused; story.classList.toggle('paused', paused);
      if (paused) clearTimeout(timer);
      else if (idx < slides.length - 1) timer = setTimeout(() => go(idx + 1), slides[idx].dur || 5200);
    }

    document.getElementById('tapL').onclick = prev;
    document.getElementById('tapR').onclick = next;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === ' ') { e.preventDefault(); pauseToggle(); }
    });

    let wired = false;
    function wireFinale() {
      if (wired) return; wired = true;
      const r = document.getElementById('w-replay');
      const c = document.getElementById('w-share');
      if (r) r.onclick = (e) => { e.stopPropagation(); go(0); };
      if (c) c.onclick = (e) => {
        e.stopPropagation();
        const flash = (msg) => { c.textContent = msg; setTimeout(() => c.textContent = 'share ↗', 1600); };
        // Native share sheet where available (mobile / modern browsers);
        // fall back to copying the summary + install link to the clipboard.
        if (navigator.share) {
          navigator.share({ title: 'My Year on Claude Code', text: _shareText, url: LANDING })
            .catch(() => {});
        } else {
          navigator.clipboard?.writeText(_shareText)
            .then(() => flash('copied ✓'))
            .catch(() => flash('copy failed'));
        }
      };
    }

    go(0);
  }

  // ── boot ─────────────────────────────────────────────────────
  fetch('/api/wrapped').then((r) => r.json()).then((d) => {
    if (!d || !d.sessions) {
      app.innerHTML = `<div class="boot">no data yet — run <code style="opacity:.9">claude-rpc scan</code> first, then refresh.</div>`;
      return;
    }
    mount(buildSlides(d));
  }).catch(() => {
    app.innerHTML = `<div class="boot">couldn't load your year. is the daemon's <code>serve</code> running?</div>`;
  });
})();
