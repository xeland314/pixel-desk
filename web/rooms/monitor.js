// Cuarto 3: monitor del sistema (pared de pantallas CRT pixel-art).
//
// Backend: /api/monitor/config, /api/sys (cada 1 s, solo con el cuarto
// activo) y /api/monitor/http?id=… (el navegador nunca envía URLs).
// Un panel con "server" lee /api/sys?server=<id>: otra máquina vía Netdata.
// Todo se dibuja a saltos: barras de celdas y sparklines en <canvas> pequeños
// escalados con image-rendering: pixelated.

const U = 3;            // píxel de escena (igual que --u de desk.css)
const BAR_PITCH = 4;    // celda de barra: 3 + 1 de hueco, en unidades --u
const SPARK_PITCH = 2;  // columna de sparkline: 1 + 1 de hueco, en unidades --u

{
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./monitor.css', import.meta.url).href;
  document.head.appendChild(link);
}

// ── Formato ────────────────────────────────────────────────────────────────
const fmtBytes = (n) => {
  const u = ['B', 'K', 'M', 'G', 'T'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n.toFixed(0) : n.toFixed(n < 10 ? 2 : 1)) + u[i];
};
const fmtRate = (n) => fmtBytes(n) + '/s';
const fmtUp = (s) => {
  s = Math.floor(s);
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
};
const pad = (v, n) => String(v).padStart(n);
const level = (pct) => (pct < 60 ? 'c-ok' : pct < 85 ? 'c-acc' : 'c-bad');

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ── Dibujo pixel ───────────────────────────────────────────────────────────
let COL = {};
function readColors(root) {
  const cs = getComputedStyle(root);
  const g = (n, d) => cs.getPropertyValue(n).trim() || d;
  COL = { ok: g('--sem-ok', '#7cfb4c'), alt: g('--sem-alt', '#3fd0e0'), acc: g('--accent', '#f1a449'), bad: g('--sem-bad', '#ff5f57') };
}
const levelColor = (frac) => (frac < 0.6 ? COL.ok : frac < 0.85 ? COL.acc : COL.bad);
const EMPTY = 'rgba(124, 251, 76, 0.10)';

/** Barra de bloques: una fila de celdas discretas que llena el ancho. */
function makeBar(parent, mono) {
  const wrap = el('div');
  wrap.style.cssText = `width:100%;height:${3 * U}px;min-width:0;flex:none;overflow:hidden`;
  const cv = el('canvas', 'mon-bar');
  wrap.appendChild(cv);
  parent.appendChild(wrap);
  const bar = { wrap, cells: 0, frac: 0 };
  bar.draw = () => {
    if (!bar.cells) return;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    const on = Math.round(bar.frac * bar.cells);
    for (let i = 0; i < bar.cells; i++) {
      ctx.fillStyle = i < on ? (mono ? COL[mono] : levelColor(i / bar.cells)) : EMPTY;
      ctx.fillRect(i * BAR_PITCH, 0, BAR_PITCH - 1, 3);
    }
  };
  const size = (w) => {
    const cells = Math.max(4, Math.floor(w / (BAR_PITCH * U)));
    if (cells === bar.cells) return;
    bar.cells = cells;
    cv.width = cells * BAR_PITCH;
    cv.height = 3;
    cv.style.width = `${cells * BAR_PITCH * U}px`;
    cv.style.height = `${3 * U}px`;
    bar.draw();
  };
  new ResizeObserver((es) => size(es[0].contentRect.width)).observe(wrap);
  bar.set = (frac) => { bar.frac = Math.max(0, Math.min(1, frac || 0)); bar.draw(); };
  return bar;
}

/** Historial: barras verticales; la muestra más nueva queda a la derecha. */
function makeSpark(parent, opts = {}) {
  const wrap = el('div', 'mon-spark-wrap');
  if (opts.height) { wrap.style.flex = 'none'; wrap.style.height = `${opts.height * U}px`; }
  const cv = el('canvas', 'mon-spark');
  wrap.appendChild(cv);
  parent.appendChild(wrap);
  const sp = { cols: 0, rows: 0, vals: [], max: 100 };
  sp.draw = () => {
    if (!sp.cols) return;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    // base tenue para ver la rejilla aunque no haya datos
    ctx.fillStyle = EMPTY;
    for (let c = 0; c < sp.cols; c++) ctx.fillRect(c * SPARK_PITCH, sp.rows - 1, 1, 1);
    const vs = sp.vals.slice(-sp.cols);
    const off = sp.cols - vs.length;
    vs.forEach((v, i) => {
      const fail = v < 0;
      const frac = fail ? 1 : Math.min(1, v / (sp.max || 1));
      const h = fail || v > 0 ? Math.max(1, Math.round(frac * sp.rows)) : 0;
      ctx.fillStyle = fail ? COL.bad : opts.mono ? COL[opts.mono] : levelColor(frac);
      ctx.fillRect((off + i) * SPARK_PITCH, sp.rows - h, 1, h);
    });
  };
  const size = (w, h) => {
    const cols = Math.max(2, Math.floor(w / (SPARK_PITCH * U)));
    const rows = Math.max(2, Math.floor(h / U));
    if (cols === sp.cols && rows === sp.rows) return;
    sp.cols = cols; sp.rows = rows;
    cv.width = cols * SPARK_PITCH;
    cv.height = rows;
    cv.style.width = `${cols * SPARK_PITCH * U}px`;
    cv.style.height = `${rows * U}px`;
    sp.draw();
  };
  new ResizeObserver((es) => size(es[0].contentRect.width, es[0].contentRect.height)).observe(wrap);
  sp.set = (vals, max) => { sp.vals = vals || []; if (max != null) sp.max = max; sp.draw(); };
  return sp;
}

// ── Paneles ────────────────────────────────────────────────────────────────
// Cada tipo recibe (screen, cfg, env) y devuelve { update(snap) } y/o
// { updateHttp(res) }. Puede fijar led/meta con env.led(state) / env.meta(text).

const TYPES = {
  cpu(s, cfg, env) {
    const top = el('div', 'mon-row');
    const big = el('span', 'mon-big');
    const info = el('span', 'mon-sm c-dim');
    top.append(big, info);
    s.appendChild(top);
    const bar = makeBar(s);
    const spark = makeSpark(s);
    const cores = el('div', 'mon-cores');
    s.appendChild(cores);
    const rows = [];
    return {
      update(d) {
        big.textContent = `${d.cpu.toFixed(0)}%`;
        big.className = `mon-big ${level(d.cpu)}`;
        info.textContent = `${d.cores} NUCLEOS  LOAD ${d.load[0].toFixed(2)}`;
        bar.set(d.cpu / 100);
        spark.set(d.hist.cpu, 100);
        while (rows.length < d.cpu_cores.length) {
          const r = el('div', 'mon-core');
          const lab = el('span', 'c-alt', `C${rows.length}`);
          const holder = el('div');
          holder.style.minWidth = '0';
          const b = makeBar(holder);
          const pct = el('span', 'pct');
          r.append(lab, holder, pct);
          cores.appendChild(r);
          rows.push({ b, pct });
        }
        d.cpu_cores.forEach((v, i) => {
          rows[i].b.set(v / 100);
          rows[i].pct.textContent = `${v.toFixed(0)}%`;
          rows[i].pct.className = `pct ${level(v)}`;
        });
        env.led(d.cpu >= 95 ? 'bad' : d.cpu >= 80 ? 'warn' : 'ok');
        env.meta(d.temp != null ? `${d.temp.toFixed(0)}C` : '');
      },
    };
  },

  mem(s, cfg, env) {
    const mk = (label) => {
      const row = el('div', 'mon-row');
      const l = el('span', 'c-alt', label);
      const v = el('span');
      row.append(l, v);
      s.appendChild(row);
      const b = makeBar(s);
      return { v, b };
    };
    const ram = mk('RAM');
    const swap = mk('SWAP');
    const cache = el('div', 'mon-sm c-dim');
    s.appendChild(cache);
    const spark = makeSpark(s);
    return {
      update(d) {
        const p = d.mem_total ? d.mem_used / d.mem_total * 100 : 0;
        ram.v.textContent = `${fmtBytes(d.mem_used)} / ${fmtBytes(d.mem_total)}  ${p.toFixed(0)}%`;
        ram.v.className = level(p);
        ram.b.set(p / 100);
        const sp = d.swap_total ? d.swap_used / d.swap_total * 100 : 0;
        swap.v.textContent = d.swap_total ? `${fmtBytes(d.swap_used)} / ${fmtBytes(d.swap_total)}  ${sp.toFixed(0)}%` : 'SIN SWAP';
        swap.v.className = d.swap_total ? level(sp) : 'c-dim';
        swap.b.set(sp / 100);
        cache.textContent = `CACHE ${fmtBytes(d.mem_cache)}`;
        spark.set(d.hist.mem, 100);
        env.led(p >= 95 ? 'bad' : p >= 85 ? 'warn' : 'ok');
      },
    };
  },

  procs(s, cfg, env) {
    const n = cfg.n || 25;   // máximo; se ocultan las que no caben
    const holder = el('div');
    holder.style.cssText = 'flex:1;min-height:0;overflow:hidden';
    const table = el('div', 'mon-table');
    holder.appendChild(table);
    const th = el('div', 'mon-tr mon-th');
    const ths = ['PID', 'NOMBRE', 'CPU%', 'MEM%'].map((t) => el('span', '', t));
    th.append(...ths);
    table.appendChild(th);
    const rows = [];
    for (let i = 0; i < n; i++) {
      const r = el('div', 'mon-tr');
      const cells = [el('span', 'c-dim'), el('span'), el('span'), el('span')];
      r.append(...cells);
      table.appendChild(r);
      rows.push(cells);
    }
    s.appendChild(holder);
    let fit = n;
    new ResizeObserver((es) => {
      const rh = rows[0] && rows[0][0].parentNode.offsetHeight;
      if (!rh) return;
      const f = Math.max(1, Math.min(n, Math.floor((es[0].contentRect.height - th.offsetHeight - U) / rh)));
      if (f !== fit) { fit = f; rows.forEach((c, i) => { c[0].parentNode.style.display = i < fit ? '' : 'none'; }); }
    }).observe(holder);
    const foot = el('div', 'mon-sm c-dim');
    s.appendChild(foot);
    let last = null;
    const api = {
      update(d) {
        last = d;
        const byMem = env.state.sort === 'mem';
        ths[2].className = byMem ? '' : 'sorted';
        ths[3].className = byMem ? 'sorted' : '';
        const list = byMem ? d.procs_mem : d.procs_cpu;
        rows.forEach((c, i) => {
          const p = list[i];
          if (!p) { c.forEach((x) => { x.textContent = ''; }); return; }
          c[0].textContent = p.pid || '';
          c[1].textContent = p.name;
          c[2].textContent = p.cpu.toFixed(1);
          c[3].textContent = p.mem.toFixed(1);
          c[2].className = p.cpu >= 80 ? 'c-bad' : p.cpu >= 30 ? 'c-acc' : '';
          c[3].className = p.mem >= 20 ? 'c-bad' : p.mem >= 8 ? 'c-acc' : '';
        });
        ths[0].textContent = d.procs_kind ? '' : 'PID';
        foot.textContent = d.procs_kind
          ? `${list.length} ${d.procs_kind}  ORDEN ${byMem ? 'MEM' : 'CPU'} (S)  100% = 1 NUCLEO`
          : `${d.nprocs} PROCESOS  ORDEN ${byMem ? 'MEM' : 'CPU'} (S)  100% = 1 NUCLEO`;
        env.led('ok');
      },
      redraw() { if (last) api.update(last); },
    };
    return api;
  },

  net(s, cfg, env) {
    const cols = el('div');
    cols.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:' + (6 * U) + 'px;flex:1;min-height:0';
    s.appendChild(cols);
    const mk = (label, mono) => {
      const c = el('div');
      c.style.cssText = `display:flex;flex-direction:column;gap:${2 * U}px;min-width:0;min-height:0`;
      const row = el('div', 'mon-row');
      const l = el('span', `c-${mono === 'alt' ? 'alt' : 'acc'}`, label);
      const tot = el('span', 'mon-sm c-dim');
      row.append(l, tot);
      const big = el('div', `mon-big c-${mono === 'alt' ? 'alt' : 'acc'}`);
      c.append(row, big);
      const sp = makeSpark(c, { mono });
      cols.appendChild(c);
      return { big, tot, sp };
    };
    const rx = mk('RX BAJADA', 'alt');
    const tx = mk('TX SUBIDA', 'acc');
    return {
      update(d) {
        const name = cfg.iface || d.net_main;
        const it = d.net.find((x) => x.name === name);
        env.meta(name || '');
        if (!it) { rx.big.textContent = tx.big.textContent = 'N/D'; env.led('bad'); return; }
        const h = (d.hist.net && d.hist.net[name]) || { rx: [], tx: [] };
        const max = Math.max(1024, ...h.rx, ...h.tx);
        rx.big.textContent = fmtRate(it.rx);
        tx.big.textContent = fmtRate(it.tx);
        rx.tot.textContent = it.rx_total ? `TOTAL ${fmtBytes(it.rx_total)}` : '';
        tx.tot.textContent = it.tx_total ? `TOTAL ${fmtBytes(it.tx_total)}` : '';
        rx.sp.set(h.rx, max);
        tx.sp.set(h.tx, max);
        env.led('ok');
      },
    };
  },

  disk(s, cfg, env) {
    const mounts = cfg.mounts && cfg.mounts.length ? cfg.mounts : ['/'];
    const items = mounts.map((m) => {
      const row = el('div', 'mon-row');
      const l = el('span', 'c-alt', m);
      const v = el('span');
      row.append(l, v);
      s.appendChild(row);
      return { m, v, b: makeBar(s) };
    });
    return {
      update(d) {
        let worst = 0;
        let bad = false;
        for (const it of items) {
          const x = d.disks.find((k) => k.mount === it.m);
          if (!x || x.error || !x.total) { it.v.textContent = 'N/D'; it.v.className = 'c-bad'; it.b.set(0); bad = true; continue; }
          const p = x.used / x.total * 100;
          worst = Math.max(worst, p);
          it.v.textContent = `${fmtBytes(x.used)} / ${fmtBytes(x.total)}  ${p.toFixed(0)}%`;
          it.v.className = level(p);
          it.b.set(p / 100);
        }
        env.led(bad || worst >= 95 ? 'bad' : worst >= 85 ? 'warn' : 'ok');
      },
    };
  },

  sys(s, cfg, env) {
    const kv = el('div', 'mon-kv');
    s.appendChild(kv);
    const keys = ['HOST', 'KERNEL', 'CPU', 'UPTIME', 'LOAD', 'TEMP', 'BAT', 'PROCS'];
    const vals = {};
    for (const k of keys) {
      kv.appendChild(el('span', '', k));
      vals[k] = el('span');
      kv.appendChild(vals[k]);
    }
    return {
      update(d) {
        vals.HOST.textContent = d.host;
        vals.KERNEL.textContent = d.kernel;
        vals.CPU.textContent = (d.model || '').replace(/\(R\)|\(TM\)|CPU /g, '').replace(/\s+/g, ' ');
        vals.UPTIME.textContent = fmtUp(d.uptime);
        vals.LOAD.textContent = d.load.map((x) => x.toFixed(2)).join(' ');
        vals.LOAD.className = d.cores && d.load[0] > d.cores ? 'c-bad' : '';
        vals.TEMP.textContent = d.temp != null ? `${d.temp.toFixed(0)} C` : 'N/D';
        vals.TEMP.className = d.temp == null ? 'c-dim' : d.temp >= 85 ? 'c-bad' : d.temp >= 70 ? 'c-acc' : '';
        if (d.battery) {
          vals.BAT.textContent = `${d.battery.pct}% ${d.battery.status.toUpperCase()}`;
          vals.BAT.className = d.battery.pct <= 15 && d.battery.status !== 'Charging' ? 'c-bad' : d.battery.pct <= 30 ? 'c-acc' : '';
        } else {
          vals.BAT.textContent = 'N/D';
          vals.BAT.className = 'c-dim';
        }
        vals.PROCS.textContent = d.nprocs;
        env.led('ok');
      },
    };
  },

  http(s, cfg, env) {
    const top = el('div', 'mon-row');
    const big = el('span', 'mon-big c-dim', '...');
    const lat = el('span', 'mon-sm c-dim');
    top.append(big, lat);
    const val = el('div', 'c-alt');
    val.style.cssText = 'overflow:hidden;line-height:1.05;max-height:3.3em;word-break:break-word;flex:none';
    const host = el('div', 'mon-sm c-dim', cfg.host || '');
    s.append(top, val, host);
    const spark = makeSpark(s, { mono: 'alt' });
    env.led('off');
    return {
      updateHttp(r) {
        big.textContent = r.ok ? 'OK' : 'FAIL';
        big.className = `mon-big ${r.ok ? 'c-ok' : 'c-bad'}`;
        lat.textContent = r.status ? `${r.status}  ${r.latency_ms}ms` : (r.error || 'SIN RESPUESTA').toUpperCase().slice(0, 28);
        val.textContent = r.ok ? r.value : (r.error || '');
        val.className = r.ok ? 'c-alt' : 'c-bad';
        const hist = r.hist || [];
        spark.set(hist, Math.max(100, ...hist));
        env.led(r.ok ? 'ok' : 'bad');
        env.meta(`${Math.round(cfg.interval_s)}s`);
      },
    };
  },
};

// ── Cuarto ─────────────────────────────────────────────────────────────────
export default {
  id: 'monitor',
  label: 'MONITOR',
  hints: [['FLECHAS', 'PANEL'], ['S', 'ORDEN'], ['P', 'PAUSA'], ['R', 'REFRESCAR']],

  mount(root, ctx) {
    const wall = el('div', 'mon-wall');
    root.appendChild(wall);
    readColors(root);

    const state = { sort: 'cpu' };
    const panels = [];     // { cfg, box, led, meta, impl, ledState, flash }
    let selected = 0;
    let active = false;
    let paused = false;
    let inflight = false;
    let timer = null;
    const snaps = new Map();   // server ('' = esta máquina) → última muestra
    const fails = new Map();   // server → fallos seguidos
    const httpTimers = new Map();
    const msg = el('div', 'mon-msg');
    msg.hidden = true;

    function build(cfgAll) {
      wall.style.gridTemplateColumns = `repeat(${cfgAll.columns}, minmax(0, 1fr))`;
      wall.style.gridTemplateRows = `repeat(${cfgAll.rows}, minmax(0, 1fr))`;
      wall.style.gridAutoFlow = 'row dense';
      for (const cfg of cfgAll.panels) {
        const box = el('div', 'mon-panel');
        box.style.gridColumn = `span ${cfg.span[0]}`;
        box.style.gridRow = `span ${cfg.span[1]}`;
        const head = el('div', 'mon-head');
        const led = el('i', 'mon-led off');
        const title = el('span', 'mon-title', cfg.title);
        const meta = el('span', 'mon-meta');
        head.append(led, title, meta);
        const screen = el('div', 'mon-screen');
        box.append(head, screen);
        const p = { cfg, box, led, meta, ledState: 'off', flash: 0, metaText: '' };
        const env = {
          state,
          led: (st) => { p.ledState = st; led.className = `mon-led ${st}`; },
          meta: (t) => { p.metaText = t; meta.textContent = paused ? 'PAUSA' : t; },
        };
        const make = TYPES[cfg.type];
        if (make) {
          p.impl = make(screen, cfg, env);
        } else {
          screen.appendChild(el('div', 'c-bad', `TIPO DESCONOCIDO: ${cfg.type}`));
          p.impl = {};
        }
        p.env = env;
        wall.appendChild(box);
        panels.push(p);
      }
      if (panels.length) {
        selected = Math.max(0, panels.findIndex((p) => p.cfg.type === 'procs'));
        panels[selected].box.classList.add('sel');
      }
      const wrap = panels[0] && panels[0].box.querySelector('.mon-screen');
      if (wrap) wrap.appendChild(msg);
      if (active) start();
    }

    // ── sondeo ───────────────────────────────────────────────────────────
    function render() {
      readColors(root);
      for (const p of panels) {
        if (!p.impl.update) continue;
        const srv = p.cfg.server || '';
        const d = snaps.get(srv);
        if ((fails.get(srv) || 0) >= 2) {
          p.env.led('bad');
          if (srv) p.metaText = 'SIN SEÑAL';
        } else if (d) {
          if (p.metaText === 'SIN SEÑAL') p.metaText = '';
          p.impl.update(d);
          p.flash = 1;
        }
      }
      for (const p of panels) p.meta.textContent = paused ? 'PAUSA' : p.metaText;
    }

    function showMsg(text) {
      // aviso sobre toda la pared, en la primera pantalla
      msg.hidden = !text;
      msg.textContent = text || '';
    }

    async function fetchSys(srv) {
      try {
        const r = await ctx.api(srv ? `/api/sys?server=${encodeURIComponent(srv)}` : '/api/sys');
        if (!r.ok) throw new Error(r.status);
        snaps.set(srv, await r.json());
        fails.set(srv, 0);
      } catch (e) {
        fails.set(srv, (fails.get(srv) || 0) + 1);
        if (fails.get(srv) >= 2) snaps.delete(srv);
      }
    }
    async function poll() {
      clearTimeout(timer);
      if (!active || paused || inflight) { schedule(); return; }
      inflight = true;
      try {
        const servers = new Set(panels.filter((p) => p.impl.update).map((p) => p.cfg.server || ''));
        await Promise.all([...servers].map(fetchSys));
        // El aviso grande solo cuando falla esta máquina (el backend local).
        showMsg(servers.has('') && (fails.get('') || 0) >= 2 ? 'SIN SENAL' : '');
        render();
      } finally {
        inflight = false;
      }
      schedule();
    }
    function schedule() {
      clearTimeout(timer);
      if (active && !paused) timer = setTimeout(poll, 1000);
    }

    async function pollHttp(p, refresh) {
      clearTimeout(httpTimers.get(p.cfg.id));
      if (!active || paused) return;
      try {
        const r = await ctx.api(`/api/monitor/http?id=${encodeURIComponent(p.cfg.id)}${refresh ? '&refresh=1' : ''}`);
        if (!r.ok) throw new Error(r.status);
        p.impl.updateHttp(await r.json());
      } catch (e) {
        p.impl.updateHttp({ ok: false, status: 0, latency_ms: 0, error: 'backend', hist: [] });
      }
      if (active && !paused) {
        httpTimers.set(p.cfg.id, setTimeout(() => pollHttp(p, false), (p.cfg.interval_s || 30) * 1000));
      }
    }

    function start() {
      poll();
      for (const p of panels) if (p.cfg.type === 'http') pollHttp(p, false);
    }
    function stop() {
      clearTimeout(timer);
      for (const t of httpTimers.values()) clearTimeout(t);
      httpTimers.clear();
    }

    // ── selección por flechas ────────────────────────────────────────────
    function select(i) {
      panels[selected].box.classList.remove('sel');
      selected = i;
      panels[selected].box.classList.add('sel');
    }
    function move(dx, dy) {
      const cur = panels[selected].box.getBoundingClientRect();
      const cx = cur.left + cur.width / 2, cy = cur.top + cur.height / 2;
      let best = -1, bestScore = Infinity;
      panels.forEach((p, i) => {
        if (i === selected) return;
        const r = p.box.getBoundingClientRect();
        const px = r.left + r.width / 2 - cx, py = r.top + r.height / 2 - cy;
        const main = dx ? px * dx : py * dy;
        const side = dx ? Math.abs(py) : Math.abs(px);
        if (main <= 1) return;
        const score = main + side * 2;
        if (score < bestScore) { bestScore = score; best = i; }
      });
      if (best >= 0) select(best);
    }

    ctx.api('/api/monitor/config')
      .then((r) => r.json())
      .then(build)
      .catch((e) => { console.error('monitor: config', e); wall.textContent = 'ERROR DE CONFIG'; });

    return {
      enter() { active = true; readColors(root); if (panels.length) start(); },
      leave() { active = false; stop(); },
      key(ev) {
        if (ev.ctrlKey || ev.altKey || ev.metaKey || !panels.length) return false;
        const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
        switch (k) {
          case 'ArrowLeft': move(-1, 0); break;
          case 'ArrowRight': move(1, 0); break;
          case 'ArrowUp': move(0, -1); break;
          case 'ArrowDown': move(0, 1); break;
          case 's':
            state.sort = state.sort === 'cpu' ? 'mem' : 'cpu';
            for (const p of panels) if (p.impl.redraw) p.impl.redraw();
            break;
          case 'p':
            paused = !paused;
            if (paused) stop(); else start();
            for (const p of panels) p.meta.textContent = paused ? 'PAUSA' : p.metaText;
            break;
          case 'r':
            if (paused) break;
            stop();
            poll();
            for (const p of panels) if (p.cfg.type === 'http') pollHttp(p, true);
            break;
          default: return false;
        }
        ev.preventDefault();
        return true;
      },
      // LED: se apaga un paso tras cada dato nuevo; los rojos parpadean.
      step(n) {
        if (!active) return;
        for (const p of panels) {
          const off = p.ledState === 'off' ||
            (p.ledState === 'bad' && (n >> 2) % 2 === 1) ||
            (paused && (n >> 2) % 2 === 1) ||
            p.flash > 0;
          p.led.classList.toggle('off', off);
          if (p.flash > 0) p.flash--;
        }
      },
    };
  },
};
