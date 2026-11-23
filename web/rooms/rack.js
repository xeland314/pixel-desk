// Cuarto 5: rack de servidores (monitor de disponibilidad pixel-art).
//
// Backend (rack.go): /api/rack/config, /api/rack/status (cada 2 s, solo con el
// cuarto activo), POST /api/rack/check?node=… y POST /api/rack/ssh?node=….
// El navegador nunca envía hosts ni URLs, solo ids de nodo. Todo el texto se
// pone con textContent; los colores salen de var(--…) en rack.css.

{
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./rack.css', import.meta.url).href;
  document.head.appendChild(link);
}

const POLL_MS = 2000;
const HIST_UNIT = 24;     // barritas en cada unidad de rack
const HIST_CHECK = 30;    // barritas por comprobación en el detalle
const MIN_SLOTS = 14;     // unidades totales mínimas por rack (el resto, huecos)

const LV_TEXT = { ok: 'OK', warn: 'AVISO', bad: 'CAÍDO', none: 'SIN COMPROBAR' };
const RANK = { none: 0, ok: 1, warn: 2, bad: 3 };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const fmtMs = (ms) => (ms == null ? '--' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtAgo = (at, now) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `hace ${s}s` : `hace ${Math.floor(s / 60)}m`;
};
const lv = (l) => (RANK[l] === undefined ? 'none' : l);

/** Relleno de barritas: la altura sube con la latencia; caído = barra entera. */
function paintBars(box, hist, n) {
  const kids = box.children;
  const tail = hist.slice(-n);
  const pad = n - tail.length;
  let max = 1;
  for (const h of tail) max = Math.max(max, h.ms || 0);
  for (let i = 0; i < n; i++) {
    const b = kids[i];
    const h = i < pad ? null : tail[i - pad];
    let cls = 'hb lv-none';
    let height = 2;
    if (h) {
      cls = `hb lv-${lv(h.l)}`;
      height = h.l === 'bad' ? 10 : 2 + Math.round(((h.ms || 0) / max) * 7);
    }
    if (b.className !== cls) b.className = cls;
    const hs = `calc(var(--u) * ${height})`;
    if (b.style.height !== hs) b.style.height = hs;
  }
}

function makeBars(n) {
  const box = el('div', 'rk-hist');
  for (let i = 0; i < n; i++) box.appendChild(el('span', 'hb lv-none'));
  return box;
}

/** Une los historiales de las comprobaciones de un nodo (peor nivel por posición). */
function nodeHist(checks, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    let worst = null;
    for (const c of checks) {
      const h = c.hist[c.hist.length - 1 - i];
      if (!h) continue;
      if (!worst) worst = { l: h.l, ms: h.ms };
      else {
        if (RANK[h.l] > RANK[worst.l]) worst.l = h.l;
        worst.ms = Math.max(worst.ms, h.ms);
      }
    }
    if (!worst) break;
    out.unshift(worst);
  }
  return out;
}

export default {
  id: 'rack',
  label: 'RACK',
  hints: [['FLECHAS', 'NODO'], ['ENTER', 'COPIAR SSH'], ['R', 'COMPROBAR'], ['F', 'SOLO PROBLEMAS']],

  mount(root, ctx) {
    let cfg = null;          // { ver, racks: [...] }
    let status = null;       // { ver, now, nodes: {id: {level, checks}} }
    let active = false;
    let timer = 0;
    let toastTimer = 0;
    let offline = false;
    let filter = false;
    let rackIdx = 0;
    let selId = null;
    let units = new Map();   // id → { el, leds, name, group, lat, bars, ear }
    let cabs = [];           // [{ el, body, rack, ids: [] , empty }]

    // ── Esqueleto fijo ──
    const wrap = el('div', 'rk-wrap');
    const top = el('div', 'rk-top px-panel');
    const title = el('span', 'px-title', 'RACK');
    const sums = {};
    const sumBox = el('div', 'rk-sums');
    for (const [k, t] of [['ok', 'OK'], ['warn', 'AVISO'], ['bad', 'CAÍDOS']]) {
      const s = el('span', 'rk-sum');
      const led = el('i', `rk-led lv-${k}`);
      led.appendChild(el('b'));
      const n = el('em', null, '0');
      s.append(led, el('span', 'rk-sum-t', t), n);
      sums[k] = n;
      sumBox.appendChild(s);
    }
    const filt = el('span', 'rk-filter', '');
    const toast = el('span', 'rk-toast', '');
    top.append(title, sumBox, filt, toast);

    const main = el('div', 'rk-main');
    const racksEl = el('div', 'rk-racks');
    const detail = el('div', 'rk-detail px-panel');
    main.append(racksEl, detail);
    wrap.append(top, main);
    root.appendChild(wrap);

    // ── Construcción de racks y unidades ──
    function build() {
      units = new Map();
      cabs = [];
      racksEl.replaceChildren();
      if (!cfg || !cfg.racks.length) {
        racksEl.appendChild(el('div', 'rk-empty', 'SIN RACKS EN LA CONFIGURACIÓN'));
        return;
      }
      for (const rack of cfg.racks) {
        const cab = el('div', 'rk-cab');
        const head = el('div', 'rk-cab-head');
        head.append(el('span', 'rk-cab-title', rack.title), el('span', 'rk-cab-count', `${rack.nodes.length}U`));
        const body = el('div', 'rk-cab-body');
        const ids = [];
        for (const node of rack.nodes) {
          const u2 = node.checks.length > 4;
          const u = el('div', `rk-unit${u2 ? ' u2' : ''} lv-none`);
          const ear = el('span', 'rk-ear');
          const leds = el('div', 'rk-leds');
          const ledEls = node.checks.map((c) => {
            const l = el('i', 'rk-led lv-none');
            l.appendChild(el('b'));
            l.title = '';
            leds.appendChild(l);
            return l;
          });
          const info = el('div', 'rk-info');
          const name = el('span', 'rk-name', node.name);
          const group = el('span', 'rk-group', node.group || '');
          info.append(name, group);
          const disp = el('div', 'rk-disp');
          const lat = el('span', 'rk-lat', '--');
          const bars = makeBars(HIST_UNIT);
          disp.append(lat, bars);
          const vents = el('span', 'rk-vents');
          u.append(ear, leds, info, disp, vents);
          body.appendChild(u);
          units.set(node.id, { el: u, leds: ledEls, lat, bars, node });
          ids.push(node.id);
        }
        const empty = el('div', 'rk-allok', 'TODO EN ORDEN');
        empty.hidden = true;
        body.appendChild(empty);
        const slots = Math.max(0, MIN_SLOTS - rack.nodes.reduce((a, n) => a + (n.checks.length > 4 ? 2 : 1), 0));
        const blanks = [];
        for (let i = 0; i < slots; i++) { const b = el('div', 'rk-blank'); blanks.push(b); body.appendChild(b); }
        const moreUp = el('div', 'rk-more up');
        const moreDown = el('div', 'rk-more down');
        moreUp.hidden = moreDown.hidden = true;
        cab.append(head, body, moreUp, moreDown);
        racksEl.appendChild(cab);
        const c = { el: cab, body, rack, ids, empty, blanks, moreUp, moreDown };
        body.addEventListener('scroll', () => paintMore(c), { passive: true });
        cabs.push(c);
      }
      rackIdx = Math.min(rackIdx, cabs.length - 1);
      applyFilter();
    }

    /** Cuenta los nodos (visibles) que quedan por encima o por debajo del hueco del armario. */
    function paintMore(cab) {
      const top = cab.body.scrollTop;
      const bottom = top + cab.body.clientHeight;
      let up = 0;
      let down = 0;
      for (const id of cab.ids) {
        const e = units.get(id).el;
        if (e.hidden) continue;
        if (e.offsetTop < top - 1) up++;
        else if (e.offsetTop + e.offsetHeight > bottom + 1) down++;
      }
      cab.moreUp.hidden = up === 0;
      cab.moreDown.hidden = down === 0;
      if (up) cab.moreUp.textContent = `▲ ${up} MÁS`;
      if (down) cab.moreDown.textContent = `▼ ${down} MÁS`;
    }
    const paintAllMore = () => cabs.forEach(paintMore);
    new ResizeObserver(paintAllMore).observe(racksEl);

    const levelOf = (id) => (status && status.nodes[id] ? lv(status.nodes[id].level) : 'none');
    const isProblem = (id) => RANK[levelOf(id)] >= RANK.warn;
    const visibleIds = (ci) => cabs[ci].ids.filter((id) => !filter || isProblem(id));

    function applyFilter() {
      cabs.forEach((cab, ci) => {
        const vis = new Set(visibleIds(ci));
        for (const id of cab.ids) units.get(id).el.hidden = !vis.has(id);
        cab.empty.hidden = !(filter && vis.size === 0);
        cab.blanks.forEach((b) => { b.hidden = filter; });
      });
      paintAllMore();
      if (cabs.length) {
        const vis = visibleIds(rackIdx);
        if (!vis.includes(selId)) selId = vis[0] || null;
      }
      filt.textContent = filter ? 'FILTRO: SOLO PROBLEMAS' : '';
      paintSel();
    }

    function paintSel() {
      cabs.forEach((cab, ci) => cab.el.classList.toggle('sel', ci === rackIdx));
      for (const [id, u] of units) u.el.classList.toggle('sel', id === selId);
      const u = units.get(selId);
      if (u) u.el.scrollIntoView({ block: 'nearest' });
      paintAllMore();
      renderDetail();
    }

    // ── Pintado del estado ──
    function paintStatus() {
      const counts = { ok: 0, warn: 0, bad: 0 };
      for (const [id, u] of units) {
        const st = status && status.nodes[id];
        const level = st ? lv(st.level) : 'none';
        if (counts[level] !== undefined) counts[level]++;
        u.el.className = u.el.className.replace(/ lv-\w+/g, '') + ` lv-${level}`;
        const checks = st ? st.checks : [];
        u.leds.forEach((led, i) => {
          const c = checks[i];
          const cls = `rk-led lv-${c ? lv(c.level) : 'none'}${c && c.running ? ' act' : ''}`;
          if (led.className !== cls) led.className = cls;
        });
        let ms = null;
        for (const c of checks) if (c.ms != null && c.level !== 'none') ms = Math.max(ms || 0, c.ms);
        u.lat.textContent = fmtMs(ms);
        u.lat.className = `rk-lat lv-${level}`;
        paintBars(u.bars, nodeHist(checks, HIST_UNIT), HIST_UNIT);
      }
      for (const k of Object.keys(sums)) sums[k].textContent = String(counts[k]);
      if (filter) applyFilter(); else renderDetail();
    }

    let detailId = null;
    function renderDetail() {
      // Se repinta cada 2 s: conservar el desplazamiento si sigue el mismo nodo.
      const keep = detailId === selId ? detail.scrollTop : 0;
      detailId = selId;
      detail.replaceChildren();
      const u = units.get(selId);
      if (!u) {
        detail.appendChild(el('div', 'px-title', 'DETALLE'));
        detail.appendChild(el('div', 'rk-muted', filter ? 'SIN PROBLEMAS' : 'SIN NODO'));
        return;
      }
      const node = u.node;
      const st = status && status.nodes[node.id];
      const now = status ? status.now : Date.now();
      const level = st ? lv(st.level) : 'none';
      const head = el('div', 'rk-d-head');
      const led = el('i', `rk-led lv-${level}`);
      led.appendChild(el('b'));
      head.append(led, el('span', 'px-title', node.name));
      detail.appendChild(head);
      const meta = [node.group, `CADA ${node.interval_s}s`, node.ssh ? 'SSH' : 'SIN SSH', LV_TEXT[level]].filter(Boolean).join(' · ');
      detail.appendChild(el('div', 'rk-d-meta', meta));
      node.checks.forEach((cc, i) => {
        const c = st && st.checks[i];
        const l = c ? lv(c.level) : 'none';
        const card = el('div', `rk-check lv-${l}`);
        const row = el('div', 'rk-c-row');
        const cl = el('i', `rk-led lv-${l}${c && c.running ? ' act' : ''}`);
        cl.appendChild(el('b'));
        row.append(cl, el('span', 'rk-c-type', cc.type.toUpperCase()), el('span', 'rk-c-target', cc.target),
          el('span', 'rk-c-ms', c && c.level !== 'none' ? fmtMs(c.ms) : '--'));
        card.appendChild(row);
        let line = LV_TEXT[l];
        if (c && c.at) line += ` · ${fmtAgo(c.at, now)}`;
        card.appendChild(el('div', 'rk-c-line', line));
        if (c && c.days != null) {
          const txt = c.days < 0 ? `CERTIFICADO CADUCADO HACE ${-c.days} DÍAS` : `CERTIFICADO: ${c.days} DÍAS RESTANTES`;
          const tl = c.days < 7 ? 'bad' : c.days < 21 ? 'warn' : 'ok';
          card.appendChild(el('div', `rk-c-days lv-${tl}`, txt));
        }
        if (c && c.err) card.appendChild(el('div', 'rk-c-err', `ERROR: ${c.err}`));
        const bars = makeBars(HIST_CHECK);
        paintBars(bars, c ? c.hist : [], HIST_CHECK);
        card.appendChild(bars);
        detail.appendChild(card);
      });
      detail.scrollTop = keep;
    }

    function say(text, kind) {
      toast.textContent = text;
      toast.className = `rk-toast ${kind || ''}`;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.textContent = ''; }, 2200);
    }

    // ── Red ──
    async function loadConfig() {
      try {
        const r = await ctx.api('/api/rack/config');
        if (!r.ok) throw new Error('config');
        cfg = await r.json();
        build();
      } catch (err) {
        offline = true;
      }
    }

    async function poll() {
      if (!active) return;
      try {
        const r = await ctx.api('/api/rack/status');
        if (!r.ok) throw new Error('status');
        const s = await r.json();
        if (!active) return;
        offline = false;
        status = s;
        if (!cfg || cfg.ver !== s.ver) await loadConfig();
        paintStatus();
        top.classList.toggle('offline', false);
      } catch (err) {
        offline = true;
        top.classList.add('offline');
        say('SIN CONEXIÓN', 'bad');
      }
      if (active) timer = setTimeout(poll, POLL_MS);
    }

    async function post(path, id) {
      try {
        return (await ctx.api(`${path}?node=${encodeURIComponent(id)}`, { method: 'POST' })).status;
      } catch (err) {
        return 0;
      }
    }

    loadConfig();

    return {
      enter() { active = true; clearTimeout(timer); poll(); },
      leave() { active = false; clearTimeout(timer); },
      key(ev) {
        if (ev.ctrlKey || ev.altKey || ev.metaKey || !cabs.length) return false;
        const k = ev.key;
        if (k === 'ArrowUp' || k === 'ArrowDown') {
          const vis = visibleIds(rackIdx);
          if (!vis.length) return true;
          let i = vis.indexOf(selId);
          i = i < 0 ? 0 : Math.max(0, Math.min(vis.length - 1, i + (k === 'ArrowDown' ? 1 : -1)));
          selId = vis[i];
          paintSel();
          return true;
        }
        if (k === 'ArrowLeft' || k === 'ArrowRight') {
          if (cabs.length > 1) {
            const old = units.get(selId);
            const row = old ? visibleIds(rackIdx).indexOf(selId) : 0;
            rackIdx = (rackIdx + (k === 'ArrowRight' ? 1 : cabs.length - 1)) % cabs.length;
            const vis = visibleIds(rackIdx);
            selId = vis[Math.min(Math.max(row, 0), vis.length - 1)] || null;
            paintSel();
          }
          return true;
        }
        if (k === 'Enter') {
          if (!selId) return true;
          post('/api/rack/ssh', selId).then((s) => {
            if (s === 204) say('SSH COPIADO', 'ok');
            else if (s === 404) say('SIN SSH', 'warn');
            else say('ERROR AL COPIAR', 'bad');
          });
          return true;
        }
        if (k === 'r' || k === 'R') {
          if (!selId) return true;
          post('/api/rack/check', selId).then((s) => {
            if (s === 202) { say('COMPROBANDO…', 'ok'); setTimeout(() => { if (active) { clearTimeout(timer); poll(); } }, 400); }
            else if (s === 429) say('ESPERA 5 s', 'warn');
            else say('ERROR', 'bad');
          });
          return true;
        }
        if (k === 'f' || k === 'F') {
          filter = !filter;
          applyFilter();
          return true;
        }
        return false;
      },
    };
  },
};
