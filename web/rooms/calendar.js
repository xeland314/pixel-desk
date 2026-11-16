// Cuarto 4: calendario pixel-art (vista de mes + agenda del día).
// Eventos locales en /api/calendar (calendar.go); suscripciones ICS de solo
// lectura en /api/calendar/feeds. Las repeticiones se expanden al mostrar.

const SAVE_MS = 400;
const FEEDS_TTL = 15 * 60 * 1000;
const DOW = ['LUN', 'MAR', 'MIE', 'JUE', 'VIE', 'SAB', 'DOM'];
const DOW_FULL = ['LUNES', 'MARTES', 'MIÉRCOLES', 'JUEVES', 'VIERNES', 'SÁBADO', 'DOMINGO'];
const MONTHS = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];
const COLORS = ['orange', 'cyan', 'green', 'magic', 'red', 'sage'];
const REPEATS = [['none', 'NO'], ['weekly', 'SEMANA'], ['monthly', 'MES'], ['yearly', 'AÑO']];
const MAX_CHIPS = 3;

// Enlaza la hoja de estilos una sola vez.
if (!document.querySelector('link[data-calendar-css]')) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./calendar.css', import.meta.url).href;
  link.dataset.calendarCss = '1';
  document.head.appendChild(link);
}

// ── Fechas (siempre como 'YYYY-MM-DD' en hora local) ─────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();
const dow = (d) => (d.getDay() + 6) % 7;   // 0 = lunes
const DAY_MS = 864e5;

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseDate(s);
  return fmt(d) === s;
}
const validTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y0 = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t - y0) / DAY_MS + 1) / 7);
}

// ¿El evento (con su repetición) cae en el día ds?
function occursOn(ev, ds, d) {
  if (ds < ev.date) return false;
  if (ev.until && ds > ev.until) return false;
  if (ev.skip && ev.skip.includes(ds)) return false;
  if (ds === ev.date) return true;
  const s = parseDate(ev.date);
  const every = Math.max(1, ev.every || 1);
  switch (ev.repeat) {
    case 'weekly':
      return Math.round((d - s) / DAY_MS) % (7 * every) === 0;
    case 'monthly': {
      const months = (d.getFullYear() - s.getFullYear()) * 12 + d.getMonth() - s.getMonth();
      return months % every === 0 && d.getDate() === Math.min(s.getDate(), daysIn(d.getFullYear(), d.getMonth()));
    }
    case 'yearly': {
      const years = d.getFullYear() - s.getFullYear();
      return years % every === 0 && d.getMonth() === s.getMonth() && d.getDate() === Math.min(s.getDate(), daysIn(d.getFullYear(), d.getMonth()));
    }
    default:
      return false;
  }
}
const byTime = (a, b) => (a.time || '').localeCompare(b.time || '') || (a.title || '').localeCompare(b.title || '');

// ── Fase lunar (aproximación: mes sinódico desde la luna nueva del 6-ene-2000) ──
const SYNODIC = 29.530588853;
function moonPhase(d) {
  const noon = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 12);
  const days = (noon - Date.UTC(2000, 0, 6, 18, 14)) / DAY_MS;
  const p = ((days % SYNODIC) + SYNODIC) % SYNODIC / SYNODIC;   // 0 nueva, .5 llena
  const names = ['LUNA NUEVA', 'LUNA CRECIENTE', 'CUARTO CRECIENTE', 'GIBOSA CRECIENTE', 'LUNA LLENA', 'GIBOSA MENGUANTE', 'CUARTO MENGUANTE', 'LUNA MENGUANTE'];
  return { p, name: names[Math.floor(p * 8 + 0.5) % 8], lit: Math.round((1 - Math.cos(2 * Math.PI * p)) / 2 * 100) };
}

// ── Sprites ──────────────────────────────────────────────────────────────────
const CAT = [
  'bb........bb',
  'bsb......bsb',
  'bsobbbbbbosb',
  'boooooooooob',
  'boeooooooeob',
  'boeooooooeob',
  'bocccnnccoob',
  'boccccccccob',
  'bboooooooobb',
  '.bbbbbbbbbb.',
];
const CAT_BLINK = 4;   // filas con ojos

function cssVar(name, fb) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
}

function drawCat(cv, blink) {
  const px = 6;
  const pal = {
    b: cssVar('--cat-brown', '#483025'), o: cssVar('--cat-orange', '#f1a449'), s: cssVar('--cat-sand', '#edc699'),
    c: cssVar('--cat-cream', '#f9e6c6'), n: cssVar('--cat-rust', '#c66624'), e: cssVar('--cat-charcoal', '#49433e'),
  };
  cv.width = CAT[0].length * px;
  cv.height = CAT.length * px;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  CAT.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === '.') return;
    let c = pal[ch];
    if (ch === 'e' && blink) c = y === CAT_BLINK + 1 ? pal.b : pal.o;
    g.fillStyle = c;
    g.fillRect(x * px, y * px, px, px);
  }));
}

function drawMoon(cv, p) {
  const N = 13, px = 4;
  cv.width = cv.height = N * px;
  const g = cv.getContext('2d');
  const lit = cssVar('--cat-cream', '#f9e6c6');
  const dark = cssVar('--cat-charcoal', '#49433e');
  const edge = cssVar('--cat-brown', '#483025');
  const k = Math.cos(2 * Math.PI * p);
  const r = N / 2;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const nx = (x + 0.5 - r) / r, ny = (y + 0.5 - r) / r;
      const d2 = nx * nx + ny * ny;
      if (d2 > 1) continue;
      const w = Math.sqrt(1 - ny * ny);
      const on = p < 0.5 ? nx > k * w : nx < -k * w;
      g.fillStyle = d2 > 0.78 ? edge : (on ? lit : dark);
      g.fillRect(x * px, y * px, px, px);
    }
  }
}

const uid = () => `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export default {
  id: 'calendar',
  label: 'CALENDARIO',
  hints: [['←↑↓→', 'DÍA'], ['[ ]', 'MES'], ['N', 'NUEVO'], ['ENTER', 'EDITAR'], ['SUPR', 'BORRAR']],   // además: H/Inicio = hoy, , . = elegir evento

  mount(root, ctx) {
    root.innerHTML = `
      <div class="cal">
        <div class="cal-main">
          <div class="cal-bar">
            <button type="button" class="cal-btn" data-act="prev" title="Mes anterior">&lt;</button>
            <h2 class="cal-title"></h2>
            <button type="button" class="cal-btn" data-act="next" title="Mes siguiente">&gt;</button>
            <button type="button" class="cal-btn wide" data-act="today">HOY</button>
            <span class="cal-spacer"></span>
            <span class="cal-feeds" hidden></span>
            <span class="cal-status">CARGANDO…</span>
            <canvas class="cal-cat" title="Miau"></canvas>
          </div>
          <div class="cal-grid"></div>
        </div>
        <aside class="cal-side px-panel">
          <div class="side-head">
            <canvas class="side-moon"></canvas>
            <div class="side-date">
              <div class="side-dow"></div>
              <div class="side-day"></div>
              <div class="side-moon-name"></div>
            </div>
          </div>
          <button type="button" class="cal-btn add" data-act="new">+ NUEVO EVENTO</button>
          <div class="side-list"></div>
          <h3 class="side-sub">PRÓXIMOS</h3>
          <div class="side-next"></div>
        </aside>
      </div>`;
    const $ = (s) => root.querySelector(s);
    const gridEl = $('.cal-grid');
    const titleEl = $('.cal-title');
    const statusEl = $('.cal-status');
    const feedsEl = $('.cal-feeds');
    const catEl = $('.cal-cat');
    const moonEl = $('.side-moon');
    const listEl = $('.side-list');
    const nextEl = $('.side-next');

    const todayStr = () => fmt(new Date());
    let today = todayStr();
    let sel = today;                // día seleccionado 'YYYY-MM-DD'
    let data = { version: 1, events: [] };
    let feedEvents = [];
    let feedInfo = [];
    let feedsAt = 0;
    let loaded = false;
    let form = null;                // { ev, isNew } mientras hay formulario abierto
    let pick = 0;                   // índice del evento "activo" del día (Enter / Supr)
    let armed = null;               // id del evento pendiente de confirmar el borrado
    let armTimer = 0;

    // ── Guardado con debounce ────────────────────────────────────────────
    let saveTimer = 0;
    let chain = Promise.resolve();
    let version = 0;
    function setStatus(kind) {
      statusEl.className = `cal-status ${kind}`;
      statusEl.textContent = { ok: 'GUARDADO', saving: 'GUARDANDO…', error: 'ERROR AL GUARDAR' }[kind];
    }
    function putNow(keepalive) {
      const mine = version;
      const body = JSON.stringify(data);
      chain = chain
        .then(() => ctx.api('/api/calendar', { method: 'PUT', body, keepalive: !!keepalive && body.length < 60000, headers: { 'Content-Type': 'application/json' } }))
        .then((r) => { if (!r.ok) throw new Error(r.status); if (mine === version) setStatus('ok'); })
        .catch((e) => { console.error('calendar save', e); setStatus('error'); });
    }
    function changed() {
      if (!loaded) return;
      version++;
      setStatus('saving');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { saveTimer = 0; putNow(false); }, SAVE_MS);
    }
    addEventListener('pagehide', () => {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; putNow(true); }
    });

    // ── Eventos del día ──────────────────────────────────────────────────
    const allEvents = () => (feedEvents.length ? data.events.concat(feedEvents) : data.events);
    function eventsOn(ds, d = parseDate(ds)) {
      return allEvents().filter((e) => occursOn(e, ds, d)).sort(byTime);
    }
    const editable = (ds) => eventsOn(ds).filter((e) => !e.feed);

    // ── Cuadrícula del mes ───────────────────────────────────────────────
    function chipEl(ev) {
      const c = el('div', `chip c-${COLORS.includes(ev.color) ? ev.color : 'orange'}${ev.feed ? ' ro' : ''}`);
      c.textContent = (ev.time ? `${ev.time} ` : '') + (ev.title || '(sin título)');
      c.title = ev.title || '';
      return c;
    }

    function renderGrid() {
      const s = parseDate(sel);
      const y = s.getFullYear(), m = s.getMonth();
      titleEl.textContent = `${MONTHS[m]} ${y}`;
      const first = new Date(y, m, 1);
      const start = addDays(first, -dow(first));
      const cells = [];
      const corner = el('div', 'cell head wk', 'SEM');
      cells.push(corner);
      DOW.forEach((n, i) => cells.push(el('div', `cell head${i >= 5 ? ' we' : ''}`, n)));
      // los eventos se expanden una sola vez por día visible
      const evs = allEvents();
      for (let w = 0; w < 6; w++) {
        const wd = addDays(start, w * 7);
        cells.push(el('div', 'cell wk', pad(isoWeek(addDays(wd, 3)))));
        for (let i = 0; i < 7; i++) {
          const d = addDays(wd, i);
          const ds = fmt(d);
          const cell = el('div', 'cell day');
          cell.dataset.date = ds;
          if (i >= 5) cell.classList.add('we');
          if (d.getMonth() !== m) cell.classList.add('out');
          if (ds === today) cell.classList.add('today');
          if (ds === sel) cell.classList.add('sel');
          const num = el('div', 'num', d.getDate());
          const top = el('div', 'cell-top');
          top.appendChild(num);
          if (ds === today) top.appendChild(el('i', 'blink'));
          cell.appendChild(top);
          const list = evs.filter((e) => occursOn(e, ds, d)).sort(byTime);
          const chips = el('div', 'chips');
          list.slice(0, MAX_CHIPS).forEach((ev) => {
            const c = chipEl(ev);
            c.addEventListener('click', (e) => {
              e.stopPropagation();
              select(ds);
              if (!ev.feed) openForm(ev);
            });
            c.addEventListener('dblclick', (e) => e.stopPropagation());
            chips.appendChild(c);
          });
          if (list.length > MAX_CHIPS) chips.appendChild(el('div', 'more', `+${list.length - MAX_CHIPS}`));
          cell.appendChild(chips);
          cell.addEventListener('click', () => select(ds));
          cell.addEventListener('dblclick', () => { select(ds); openForm(null); });
          cells.push(cell);
        }
      }
      gridEl.replaceChildren(...cells);
    }

    // ── Panel lateral ────────────────────────────────────────────────────
    function disarm() { armed = null; clearTimeout(armTimer); }
    function arm(id) {
      armed = id;
      clearTimeout(armTimer);
      armTimer = setTimeout(() => { armed = null; if (!form) renderList(); }, 3000);
    }

    function renderHead() {
      const d = parseDate(sel);
      $('.side-dow').textContent = DOW_FULL[dow(d)] + (sel === today ? ' · HOY' : '');
      $('.side-day').textContent = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
      const mp = moonPhase(d);
      $('.side-moon-name').textContent = `${mp.name} ${mp.lit}%`;
      drawMoon(moonEl, mp.p);
    }

    function agendaItem(ev, idx) {
      const it = el('div', `ag c-${COLORS.includes(ev.color) ? ev.color : 'orange'}${ev.feed ? ' ro' : ''}`);
      if (!ev.feed && idx === pick) it.classList.add('pick');
      if (armed === ev.id) it.classList.add('armed');
      const time = el('div', 'ag-time', ev.time ? (ev.end ? `${ev.time}-${ev.end}` : ev.time) : 'TODO EL DÍA');
      const body = el('div', 'ag-body');
      body.appendChild(el('div', 'ag-title', ev.title || '(sin título)'));
      if (ev.note) body.appendChild(el('div', 'ag-note', ev.note));
      const tags = [];
      const every = ev.every > 1 ? `CADA ${ev.every} ` : 'CADA ';
      if (ev.repeat === 'weekly') tags.push(`${every}${ev.every > 1 ? 'SEMANAS' : 'SEMANA'}`);
      else if (ev.repeat === 'monthly') tags.push(`${every}${ev.every > 1 ? 'MESES' : 'MES'}`);
      else if (ev.repeat === 'yearly') tags.push(`${every}${ev.every > 1 ? 'AÑOS' : 'AÑO'}`);
      if (ev.feed) tags.push(`ICS · ${(feedInfo.find((f) => f.id === ev.feed)?.title || ev.feed).toUpperCase()}`);
      if (tags.length) body.appendChild(el('div', 'ag-tags', tags.join(' · ')));
      it.append(time, body);
      if (!ev.feed) {
        const warn = el('div', 'ag-warn', '¿BORRAR? PULSA OTRA VEZ');
        const del = el('button', 'ag-del', '✕');
        del.type = 'button';
        del.title = 'Borrar';
        del.addEventListener('click', (e) => { e.stopPropagation(); pick = idx; requestDelete(ev); });
        body.appendChild(warn);
        it.appendChild(del);
        it.addEventListener('click', () => { pick = idx; openForm(ev); });
      }
      return it;
    }

    function renderList() {
      const list = eventsOn(sel);
      const local = list.filter((e) => !e.feed);
      pick = Math.max(0, Math.min(pick, local.length - 1));
      const kids = [];
      if (form && form.isNew) kids.push(formEl());
      let li = 0;
      list.forEach((ev) => {
        if (form && !form.isNew && form.src === ev) { kids.push(formEl()); li++; return; }
        kids.push(agendaItem(ev, ev.feed ? -1 : li));
        if (!ev.feed) li++;
      });
      if (!list.length && !form) kids.push(el('div', 'side-empty', '- sin eventos -'));
      listEl.replaceChildren(...kids);
      if (form) queueMicrotask(() => { const t = listEl.querySelector('.f-title'); if (t && document.activeElement !== t) t.focus(); });
    }

    function renderNext() {
      const s = parseDate(sel);
      const rows = [];
      for (let i = 1; i <= 7; i++) {
        const d = addDays(s, i);
        const ds = fmt(d);
        eventsOn(ds, d).forEach((ev) => {
          const r = el('div', `nx c-${COLORS.includes(ev.color) ? ev.color : 'orange'}`);
          r.append(
            el('span', 'nx-day', `${DOW[dow(d)]} ${pad(d.getDate())}`),
            el('i', 'nx-dot'),
            el('span', 'nx-time', ev.time || '--:--'),
            el('span', 'nx-title', ev.title || '(sin título)'),
          );
          r.addEventListener('click', () => select(ds));
          rows.push(r);
        });
      }
      if (!rows.length) rows.push(el('div', 'side-empty', '- nada en 7 días -'));
      nextEl.replaceChildren(...rows);
    }

    function renderSide() { renderHead(); renderList(); renderNext(); }
    function renderAll() { renderGrid(); renderSide(); }

    // ── Formulario en línea ──────────────────────────────────────────────
    function field(label, input, cls) {
      const w = el('label', `f-field ${cls || ''}`);
      w.append(el('span', 'f-label', label), input);
      return w;
    }
    function textInput(cls, value, ph, max) {
      const i = el('input', cls);
      i.type = 'text';
      i.value = value || '';
      i.placeholder = ph || '';
      i.maxLength = max;
      i.spellcheck = false;
      i.autocomplete = 'off';
      return i;
    }

    function formEl() {
      const ev = form.ev;
      const f = el('form', 'ag-form');
      f.noValidate = true;
      const title = textInput('f-title', ev.title, 'TÍTULO', 200);
      const date = textInput('f-date', ev.date, 'AAAA-MM-DD', 10);
      const time = textInput('f-time', ev.time, 'HH:MM', 5);
      const end = textInput('f-end', ev.end, 'HH:MM', 5);
      const note = el('textarea', 'f-note');
      note.value = ev.note || '';
      note.rows = 2;
      note.placeholder = 'NOTA (OPCIONAL)';
      note.maxLength = 2000;
      note.spellcheck = false;

      const sw = el('div', 'f-swatches');
      COLORS.forEach((c) => {
        const b = el('button', `f-sw c-${c}${ev.color === c ? ' on' : ''}`);
        b.type = 'button';
        b.title = c;
        b.addEventListener('click', () => { ev.color = c; sw.querySelectorAll('.f-sw').forEach((x) => x.classList.toggle('on', x === b)); });
        sw.appendChild(b);
      });
      const rep = el('div', 'f-repeat');
      REPEATS.forEach(([v, name]) => {
        const b = el('button', `f-rp${(ev.repeat || 'none') === v ? ' on' : ''}`, name);
        b.type = 'button';
        b.addEventListener('click', () => { ev.repeat = v; rep.querySelectorAll('.f-rp').forEach((x) => x.classList.toggle('on', x === b)); });
        rep.appendChild(b);
      });

      const err = el('div', 'f-err');
      const actions = el('div', 'f-actions');
      const ok = el('button', 'cal-btn ok', 'GUARDAR');
      ok.type = 'submit';
      const cancel = el('button', 'cal-btn', 'CANCELAR');
      cancel.type = 'button';
      cancel.addEventListener('click', closeForm);
      actions.append(ok, cancel);
      if (!form.isNew) {
        const del = el('button', 'cal-btn del', 'BORRAR');
        del.type = 'button';
        del.addEventListener('click', () => {
          if (armed === ev.id) { removeEvent(form.src); return; }
          arm(ev.id);
          del.textContent = '¿SEGURO?';
          del.classList.add('armed');
          setTimeout(() => { if (del.isConnected && armed !== ev.id) { del.textContent = 'BORRAR'; del.classList.remove('armed'); } }, 3100);
        });
        actions.appendChild(del);
      }

      f.append(
        title,
        el('div', 'f-row', ''),
        sw, rep, note, err, actions,
      );
      const row = f.querySelector('.f-row');
      row.append(field('FECHA', date, 'wide'), field('HORA', time), field('FIN', end));
      f.insertBefore(el('div', 'f-label hdr', form.isNew ? 'NUEVO EVENTO' : 'EDITAR EVENTO'), title);

      const fail = (msg, input) => { err.textContent = msg; input.focus(); input.select?.(); };
      f.addEventListener('submit', (e) => {
        e.preventDefault();
        const t = title.value.trim();
        if (!t) return fail('FALTA EL TÍTULO', title);
        if (!validDate(date.value.trim())) return fail('FECHA: AAAA-MM-DD', date);
        const tm = time.value.trim(), en = end.value.trim();
        if (tm && !validTime(tm)) return fail('HORA: HH:MM (24 H)', time);
        if (en && !tm) return fail('EL FIN NECESITA HORA DE INICIO', time);
        if (en && !validTime(en)) return fail('FIN: HH:MM (24 H)', end);
        ev.title = t;
        ev.date = date.value.trim();
        ev.time = tm;
        ev.end = en;
        ev.note = note.value.trim();
        commitForm();
      });
      f.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target === note && e.shiftKey) return;     // salto de línea en la nota
        if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); f.requestSubmit(); }
      });
      f.addEventListener('mousedown', (e) => { if (e.target.tagName === 'BUTTON') e.preventDefault(); });
      return f;
    }

    function openForm(src) {
      if (!loaded) return;
      disarm();
      if (src) {
        form = { ev: { repeat: 'none', ...src }, isNew: false, src };
        pick = Math.max(0, editable(sel).indexOf(src));
      } else {
        form = { ev: { id: uid(), date: sel, time: '', end: '', title: '', note: '', color: COLORS[Math.floor(Math.random() * COLORS.length)], repeat: 'none' }, isNew: true, src: null };
      }
      renderList();
    }
    function closeForm() {
      if (!form) return;
      form = null;
      if (document.activeElement && document.activeElement.blur && root.contains(document.activeElement)) document.activeElement.blur();
      renderList();
    }
    function commitForm() {
      const { ev, isNew, src } = form;
      const clean = { ...ev };
      if (!clean.repeat || clean.repeat === 'none') { delete clean.repeat; delete clean.every; delete clean.until; delete clean.skip; }
      if (!clean.time) { clean.time = ''; clean.end = ''; }
      if (isNew) data.events.push(clean);
      else data.events[data.events.indexOf(src)] = clean;
      form = null;
      sel = clean.date;
      pick = Math.max(0, editable(sel).indexOf(clean));
      if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur();
      renderAll();
      changed();
    }
    function removeEvent(ev) {
      const i = data.events.indexOf(ev);
      if (i < 0) return;
      data.events.splice(i, 1);
      disarm();
      form = null;
      if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur();
      renderAll();
      changed();
    }
    function requestDelete(ev) {
      if (!ev || ev.feed) return;
      if (armed === ev.id) { removeEvent(ev); return; }
      arm(ev.id);
      renderList();
    }

    // ── Selección y navegación ───────────────────────────────────────────
    function select(ds) {
      if (ds === sel) return;
      disarm(); pick = 0; form = null;
      const monthChanged = ds.slice(0, 7) !== sel.slice(0, 7);
      const prev = sel;
      sel = ds;
      if (monthChanged) { renderAll(); return; }
      if (prev !== ds) {
        gridEl.querySelectorAll('.day.sel').forEach((c) => c.classList.remove('sel'));
        const c = gridEl.querySelector(`.day[data-date="${ds}"]`);
        if (c) c.classList.add('sel');
      }
      renderSide();
    }
    function shiftMonth(n) {
      const s = parseDate(sel);
      const total = s.getFullYear() * 12 + s.getMonth() + n;
      const y = Math.floor(total / 12), m = total - y * 12;
      select(fmt(new Date(y, m, Math.min(s.getDate(), daysIn(y, m)))));
    }

    // ── Carga ────────────────────────────────────────────────────────────
    ctx.api('/api/calendar')
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then((d) => {
        data = { version: 1, events: Array.isArray(d.events) ? d.events : [] };
        loaded = true;
        setStatus('ok');
        renderAll();
      })
      .catch((e) => { console.error('calendar load', e); setStatus('error'); });

    function loadFeeds() {
      feedsAt = Date.now();
      ctx.api('/api/calendar/feeds')
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then((d) => {
          feedEvents = Array.isArray(d.events) ? d.events : [];
          feedInfo = Array.isArray(d.feeds) ? d.feeds : [];
          const bad = feedInfo.filter((f) => !f.ok).length;
          feedsEl.hidden = !feedInfo.length;
          feedsEl.className = `cal-feeds${bad ? ' bad' : ''}`;
          feedsEl.textContent = bad ? `ICS: ${bad} CON ERROR` : `ICS: ${feedInfo.length} CAL`;
          if (!form) renderAll(); else renderGrid();
        })
        .catch((e) => console.error('calendar feeds', e));
    }
    loadFeeds();

    // Acciones de los botones
    root.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-act]');
      if (!b) return;
      switch (b.dataset.act) {
        case 'prev': shiftMonth(-1); break;
        case 'next': shiftMonth(1); break;
        case 'today': today = todayStr(); select(today); break;
        case 'new': openForm(null); break;
        default:
      }
    });
    root.addEventListener('mousedown', (ev) => { if (ev.target.closest('button')) ev.preventDefault(); });

    // ── Animación y fecha ────────────────────────────────────────────────
    let blink = false;
    drawCat(catEl, false);
    function step(n) {
      const b = n % 40 > 37;                      // parpadeo corto cada 5 s
      if (b !== blink) { blink = b; drawCat(catEl, b); }
      if (n % 240 === 0) {                         // cambio de día a medianoche
        const t = todayStr();
        if (t !== today) { today = t; renderAll(); }
      }
    }

    // ── Teclado ──────────────────────────────────────────────────────────
    function key(ev) {
      if (form) {
        if (ev.key === 'Escape') { closeForm(); return true; }
        return false;
      }
      if (ev.ctrlKey || ev.altKey || ev.metaKey || !loaded) return false;
      const k = ev.key;
      const lower = k.length === 1 ? k.toLowerCase() : k;
      if (lower !== 'Delete' && armed) { disarm(); renderList(); }
      const d = parseDate(sel);
      const local = editable(sel);
      switch (lower) {
        case 'ArrowLeft': select(fmt(addDays(d, -1))); break;
        case 'ArrowRight': select(fmt(addDays(d, 1))); break;
        case 'ArrowUp': select(fmt(addDays(d, -7))); break;
        case 'ArrowDown': select(fmt(addDays(d, 7))); break;
        case 'PageUp': case '[': shiftMonth(-1); break;
        case 'PageDown': case ']': shiftMonth(1); break;
        case 'Home': case 'h': today = todayStr(); select(today); break;
        case 'n': openForm(null); break;
        case 'Enter': case 'e': openForm(local[pick] || null); break;
        case ',': case '.':
          if (local.length) { pick = (pick + (lower === '.' ? 1 : -1) + local.length) % local.length; renderList(); }
          break;
        case 'Delete': if (local[pick]) requestDelete(local[pick]); break;
        default: return false;
      }
      ev.preventDefault();
      return true;
    }

    return {
      enter() {
        today = todayStr();
        if (Date.now() - feedsAt > FEEDS_TTL) loadFeeds();
        if (loaded) renderAll();
      },
      leave() { if (form) closeForm(); disarm(); },
      key,
      step,
    };
  },
};
