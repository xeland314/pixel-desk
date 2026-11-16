// Panel: bitácora rápida. Anotar en segundos qué se revisó o resolvió, con hora
// automática. Backend append-only en bitacora.go (/api/log…). Todo el texto
// del usuario entra con textContent.

if (!document.querySelector('link[data-log-css]')) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./log.css', import.meta.url).href;
  link.dataset.logCss = '1';
  document.head.appendChild(link);
}

const TYPES = ['incidencia', 'cambio', 'consulta', 'nota'];   // Alt+1..4
const FIX_MS = 15 * 60 * 1000;                                // igual que el servidor
const DIAS = ['DOM', 'LUN', 'MAR', 'MIE', 'JUE', 'VIE', 'SAB'];

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function chipClass(tag) {
  if (TYPES.includes(tag)) return `t-${tag}`;
  let h = 0;
  for (const c of tag) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `c${h % 6}`;
}

/** "#red texto" -> { tag: 'red', text: 'texto' }; sin texto detrás no es etiqueta. */
function parseLine(raw) {
  const m = /^#([A-Za-z0-9_-]{1,24})(?:\s+([\s\S]*))?$/.exec(raw.trim());
  if (m && m[2] && m[2].trim()) return { tag: m[1].toLowerCase(), text: m[2].trim() };
  return { tag: '', text: raw.trim() };
}

export default {
  id: 'log',
  title: 'BITACORA RAPIDA',
  hints: [['ENTER', 'ANOTAR'], ['#TAG', 'ETIQUETA'], ['ALT+1-4', 'TIPO'], ['↑', 'CORREGIR'], ['CTRL+E', 'EXPORTAR']],

  mount(root, ctx) {
    root.replaceChildren();
    const wrap = el('div', 'lg');

    // Tipos rápidos
    const typesRow = el('div', 'lg-types');
    typesRow.append(el('span', null, 'TIPO'));
    const typeChips = TYPES.map((t, i) => {
      const c = el('button', `lg-chip t-${t}`, `${i + 1} ${t}`);
      c.type = 'button';
      c.tabIndex = -1;
      c.addEventListener('click', () => { setType(pendingType === t ? '' : t); input.focus(); });
      typesRow.append(c);
      return c;
    });

    const input = el('textarea', 'lg-input');
    input.rows = 1;
    input.placeholder = 'qué hiciste…  (#etiqueta al inicio, ↑ corrige la última)';
    input.maxLength = 4000;
    input.spellcheck = false;

    const actions = el('div', 'lg-actions');
    const saveBtn = el('button', 'lg-btn main', 'ANOTAR');
    const multiBtn = el('button', 'lg-btn', 'VARIAS LINEAS');
    for (const b of [saveBtn, multiBtn]) { b.type = 'button'; b.tabIndex = -1; actions.append(b); }

    const fix = el('div', 'lg-fix');
    fix.hidden = true;

    // Cifras + exportación
    const stats = el('div', 'lg-stats');
    const count = el('span', 'lg-count');
    const exportBtn = el('button', 'lg-btn', 'EXPORTAR');
    const weekBtn = el('button', 'lg-btn', 'SEMANA ACTUAL');
    for (const b of [exportBtn, weekBtn]) { b.type = 'button'; b.tabIndex = -1; }
    const exportBox = el('span', 'lg-actions');
    exportBox.append(weekBtn, exportBtn);
    stats.append(count, exportBox);
    const status = el('div', 'lg-status');

    const list = el('div', 'lg-list');
    wrap.append(typesRow, input, actions, fix, stats, status, list);
    root.append(wrap);

    let entries = [];
    let pendingType = '';
    let multi = false;
    let editing = null;       // entrada que se está corrigiendo
    let busy = false;
    let prevWeek = false;
    let seq = 0;

    function say(msg, kind) {
      status.textContent = msg;
      status.className = `lg-status ${kind || ''}`;
    }

    function setType(t) {
      pendingType = t;
      typeChips.forEach((c, i) => c.classList.toggle('sel', TYPES[i] === t));
      typeChips.forEach((c, i) => { c.style.opacity = !t || TYPES[i] === t ? '1' : '0.45'; });
    }

    function setMulti(on) {
      multi = on;
      multiBtn.classList.toggle('on', on);
      multiBtn.textContent = on ? 'VARIAS LINEAS: CTRL+ENTER GUARDA' : 'VARIAS LINEAS';
      autosize();
    }

    function autosize() {
      const lines = input.value.split('\n').length;
      input.rows = multi ? Math.max(4, Math.min(8, lines)) : Math.min(6, lines);
    }

    function render() {
      const now = new Date();
      const today = startOfDay(now);
      const weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
      const rows = entries
        .map((e) => ({ e, d: new Date(e.ts) }))
        .filter((x) => !isNaN(x.d))
        .sort((a, b) => b.d - a.d);

      const nToday = rows.filter((x) => x.d >= today).length;
      const nWeek = rows.filter((x) => x.d >= weekStart).length;
      count.replaceChildren('HOY', el('b', null, String(nToday)), 'SEMANA', el('b', null, String(nWeek)));

      list.replaceChildren();
      if (!rows.length) {
        list.append(el('div', 'lg-empty', 'Sin entradas todavía. Escribe arriba y pulsa Enter.'));
        return;
      }
      const groups = new Map();
      for (const x of rows) {
        const k = dayKey(x.d);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(x);
      }
      const lastId = rows[0].e.id;
      for (const [k, xs] of groups) {
        const d = startOfDay(xs[0].d);
        const diff = Math.round((today - d) / 86400000);
        const label = diff === 0 ? 'HOY' : diff === 1 ? 'AYER' : `${DIAS[d.getDay()]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
        const head = el('div', 'lg-day', label);
        head.append(el('i', null, String(xs.length)));
        list.append(head);
        for (const { e, d: t } of xs) {
          const row = el('div', e.id === lastId ? 'lg-row last' : 'lg-row');
          row.append(el('span', 'lg-time', hhmm(t)));
          if (e.tag) row.append(el('span', `lg-chip ${chipClass(e.tag)}`, e.tag));
          row.append(el('span', 'lg-text', e.text));
          list.append(row);
        }
      }
    }

    async function load() {
      const mine = ++seq;
      try {
        const r = await ctx.api('/api/log?days=14');
        if (!r.ok) throw new Error(r.status);
        const j = await r.json();
        if (mine !== seq) return;
        entries = j.entries || [];
        render();
      } catch (err) {
        if (mine !== seq) return;
        console.error('log load', err);
        say('NO SE PUDO LEER LA BITACORA', 'bad');
      }
    }

    function post(path, body) {
      return ctx.api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }

    function lastEntry() {
      let best = null;
      for (const e of entries) if (!best || new Date(e.ts) > new Date(best.ts)) best = e;
      return best;
    }

    function stopEditing() {
      editing = null;
      wrap.classList.remove('editing');
      fix.hidden = true;
    }

    function startEditing() {
      const e = lastEntry();
      if (!e) return say('NADA QUE CORREGIR', 'bad');
      if (Date.now() - new Date(e.ts) > FIX_MS) return say('LA ULTIMA ENTRADA TIENE MAS DE 15 MIN: YA NO SE CORRIGE', 'bad');
      editing = e;
      wrap.classList.add('editing');
      input.value = (e.tag ? `#${e.tag} ` : '') + e.text;
      if (e.text.includes('\n')) setMulti(true);
      autosize();
      fix.replaceChildren(el('span', null, 'CORRIGIENDO LA ULTIMA:'), el('span', null, 'ENTER '), el('b', null, 'GUARDA'), el('span', null, '· CTRL+D '), el('b', null, 'BORRA'), el('span', null, '· ESC '), el('b', null, 'CANCELA'));
      fix.hidden = false;
      say('');
      input.setSelectionRange(input.value.length, input.value.length);
    }

    async function submit() {
      if (busy) return;
      const raw = input.value;
      if (!raw.trim()) return;
      let { tag, text } = parseLine(raw);
      if (!tag && pendingType && !editing) tag = pendingType;
      if (!text) return;
      busy = true;
      try {
        if (editing) {
          const r = await post('/api/log/fix', { op: 'edit', ref: editing.id, text, tag });
          if (!r.ok) throw new Error((await r.text()).trim() || r.status);
          stopEditing();
          say('CORREGIDO', 'ok');
        } else {
          const r = await post('/api/log', { text, tag });
          if (!r.ok) throw new Error((await r.text()).trim() || r.status);
          say('ANOTADO ' + hhmm(new Date()), 'ok');
        }
        input.value = '';
        setType('');
        setMulti(false);
        await load();
      } catch (err) {
        console.error('log save', err);
        say(`NO SE GUARDO: ${err.message}`, 'bad');
      } finally {
        busy = false;
        input.focus();
      }
    }

    async function remove() {
      if (!editing || busy) return;
      busy = true;
      try {
        const r = await post('/api/log/fix', { op: 'del', ref: editing.id });
        if (!r.ok) throw new Error((await r.text()).trim() || r.status);
        stopEditing();
        input.value = '';
        setMulti(false);
        say('BORRADA', 'ok');
        await load();
      } catch (err) {
        console.error('log del', err);
        say(`NO SE BORRO: ${err.message}`, 'bad');
      } finally {
        busy = false;
        input.focus();
      }
    }

    async function doExport(previous) {
      if (busy) return;
      busy = true;
      say('EXPORTANDO…');
      try {
        const r = await post(`/api/log/export?week=${previous ? 'previous' : 'current'}`, {});
        if (!r.ok) throw new Error((await r.text()).trim() || r.status);
        const j = await r.json();
        say(`GUARDADO Y COPIADO: ${j.path}`, 'ok');
      } catch (err) {
        console.error('log export', err);
        say(`NO SE EXPORTO: ${err.message}`, 'bad');
      } finally {
        busy = false;
        input.focus();
      }
    }

    input.addEventListener('input', autosize);
    saveBtn.addEventListener('click', submit);
    multiBtn.addEventListener('click', () => { setMulti(!multi); input.focus(); });
    exportBtn.addEventListener('click', () => doExport(prevWeek));
    weekBtn.addEventListener('click', () => {
      prevWeek = !prevWeek;
      weekBtn.textContent = prevWeek ? 'SEMANA ANTERIOR' : 'SEMANA ACTUAL';
      input.focus();
    });

    return {
      open() {
        entries = [];
        stopEditing();
        setType('');
        setMulti(false);
        input.value = '';
        autosize();
        say('');
        render();
        load();
        input.focus();
        // El panel se abre en pointerdown y el navegador mueve el foco al
        // terminar ese mismo clic: se reclama una vez más, sin timers vivos.
        requestAnimationFrame(() => { if (!wrap.closest('[hidden]')) input.focus(); });
        setTimeout(() => { if (!wrap.closest('[hidden]')) input.focus(); }, 80);
      },
      close() {
        seq++;          // descarta respuestas pendientes
        stopEditing();
      },
      key(ev) {
        const code = ev.code;
        if (ev.altKey && !ev.ctrlKey && /^Digit[1-4]$/.test(code)) {
          const t = TYPES[+code.slice(5) - 1];
          setType(pendingType === t ? '' : t);
          return true;
        }
        if (ev.ctrlKey && !ev.altKey && code === 'KeyE') { doExport(ev.shiftKey ? true : prevWeek); return true; }
        if (ev.ctrlKey && !ev.altKey && code === 'KeyD' && editing) { remove(); return true; }
        if (ev.key === 'Enter' && !ev.isComposing) {
          if (ev.ctrlKey) { submit(); return true; }
          if (ev.shiftKey || multi) return false;       // salto de línea normal
          submit();
          return true;
        }
        if (ev.key === 'ArrowUp' && !editing && !input.value && !ev.shiftKey) { startEditing(); return true; }
        if (ev.key === 'Escape' && editing) { stopEditing(); input.value = ''; setMulti(false); return true; }
        return false;
      },
    };
  },
};
