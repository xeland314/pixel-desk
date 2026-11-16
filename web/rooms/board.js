// Cuarto 2: tablero de corcho kanban (POR HACER / EN PROGRESO / HECHO + notas fijas).
// Persistencia en /api/board (board.go). Arrastre con pointer events.
// Varios espacios (TRABAJO, PERSONAL…), cada uno con su propio tablero:
// W / SHIFT+W o 1-9 cambian de espacio, M lleva la nota al siguiente,
// SHIFT+N crea un espacio, F2 (o doble clic en la pestaña) lo renombra y
// SHIFT+SUPR borra el espacio actual si está vacío.

const COLS = [
  { id: 'todo', name: 'POR HACER' },
  { id: 'doing', name: 'EN PROGRESO' },
  { id: 'done', name: 'HECHO' },
  { id: 'pinned', name: 'INFO FIJA' },
];
const COLORS = ['cream', 'sand', 'orange', 'sage', 'cyan'];
const SAVE_MS = 400;
const MAX_SPACES = 9;

// Enlaza la hoja de estilos una sola vez.
if (!document.querySelector('link[data-board-css]')) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./board.css', import.meta.url).href;
  link.dataset.boardCss = '1';
  document.head.appendChild(link);
}

// ── Textura de corcho: 32x32 con motas de 3 tonos derivados de los tokens ──
function hexToRgb(h) {
  h = h.trim().replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const mix = (a, b, t) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;

function corkTexture(theme) {
  const cs = getComputedStyle(document.documentElement);
  const tok = (n, fb) => hexToRgb(cs.getPropertyValue(n) || fb);
  const sand = tok('--cat-sand', '#edc699');
  const rust = tok('--cat-rust', '#c66624');
  const brown = tok('--cat-brown', '#483025');
  const cream = tok('--cat-cream', '#f9e6c6');
  const dark = theme !== 'light';
  const k = dark ? 0.38 : 0.08;   // en oscuro el corcho se hunde hacia el marrón
  const tone = (c) => mix(c, dark ? brown : cream, k);
  const midRgb = sand.map((v, i) => v + (rust[i] - v) * 0.5);
  const lightRgb = sand.map((v, i) => v + (rust[i] - v) * 0.22);
  const darkRgb = rust.map((v, i) => v + (brown[i] - v) * 0.45);
  const T = [tone(midRgb), tone(lightRgb), tone(darkRgb), tone(brown.map((v, i) => v + (rust[i] - v) * 0.2))];

  const cv = document.createElement('canvas');
  cv.width = cv.height = 32;
  const g = cv.getContext('2d');
  g.fillStyle = T[0];
  g.fillRect(0, 0, 32, 32);
  let s = 0x9e3779b1;                         // PRNG determinista: la textura no cambia entre arranques
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 10000) / 10000; };
  const blob = (tone, n, wMax, hMax) => {
    g.fillStyle = tone;
    for (let i = 0; i < n; i++) {
      const w = 1 + Math.floor(rnd() * wMax);
      const h = 1 + Math.floor(rnd() * hMax);
      const x = Math.floor(rnd() * 32), y = Math.floor(rnd() * 32);
      // envuelve en los bordes para que la textura sea repetible
      for (const dx of [0, -32]) for (const dy of [0, -32]) g.fillRect(x + dx, y + dy, w, h);
    }
  };
  blob(T[1], 30, 3, 2);
  blob(T[2], 20, 2, 2);
  blob(T[3], 5, 2, 2);
  return cv.toDataURL('image/png');
}

const uid = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export default {
  id: 'board',
  label: 'TABLERO',
  hints: [['N', 'NUEVA'], ['ENTER', 'EDITAR'], ['C', 'COLOR'], ['SHIFT+←→', 'MOVER'], ['W M', 'ESPACIOS'], ['SUPR', 'BORRAR']],

  mount(root, ctx) {
    root.style.setProperty('--cork', `url(${corkTexture(ctx.theme)})`);
    root.innerHTML = `
      <div class="board">
        <div class="board-bar">
          <h2 class="px-title">TABLERO DE CORCHO</h2>
          <nav class="board-spaces"></nav>
          <span class="board-status" id="board-status">CARGANDO…</span>
        </div>
        <div class="board-cork"></div>
      </div>`;
    const cork = root.querySelector('.board-cork');
    const statusEl = root.querySelector('.board-status');
    const spacesEl = root.querySelector('.board-spaces');

    const emptySpace = (id, name) => ({ id, name, columns: { todo: [], doing: [], done: [] }, pinned: [] });
    let data = { version: 2, current: 'trabajo', spaces: [emptySpace('trabajo', 'TRABAJO')] };
    let loaded = false;
    let sel = { c: 0, i: -1 };
    let editing = null;      // { card, isNew }
    let armed = null;        // id de la tarjeta pendiente de confirmar borrado
    let armTimer = 0;
    let naming = null;       // { id } (null = espacio nuevo) mientras se escribe un nombre
    let armedSpace = null;   // id del espacio pendiente de confirmar borrado

    const spaceIdx = () => Math.max(0, data.spaces.findIndex((s) => s.id === data.current));
    const space = () => data.spaces[spaceIdx()];
    const list = (c, sp = space()) => (COLS[c].id === 'pinned' ? sp.pinned : sp.columns[COLS[c].id]);
    const curCard = () => list(sel.c)[sel.i] || null;

    // ── Guardado con debounce ────────────────────────────────────────────
    let saveTimer = 0;
    let chain = Promise.resolve();
    let version = 0;          // sube con cada cambio; sirve para saber si hay algo más nuevo
    function setStatus(kind, text) {
      statusEl.className = `board-status ${kind}`;
      statusEl.textContent = text || { ok: 'GUARDADO', saving: 'GUARDANDO…', error: 'ERROR AL GUARDAR' }[kind];
    }
    function putNow(keepalive) {
      const mine = version;
      const body = JSON.stringify(data);
      chain = chain
        .then(() => ctx.api('/api/board', { method: 'PUT', body, keepalive: !!keepalive && body.length < 60000, headers: { 'Content-Type': 'application/json' } }))
        .then((r) => { if (!r.ok) throw new Error(r.status); if (mine === version) setStatus('ok'); })
        .catch((e) => { console.error('board save', e); setStatus('error'); });
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

    // ── Selección ────────────────────────────────────────────────────────
    function clampSel() {
      sel.c = Math.max(0, Math.min(COLS.length - 1, sel.c));
      sel.i = Math.max(-1, Math.min(list(sel.c).length - 1, sel.i));
      if (sel.i < 0 && list(sel.c).length) sel.i = 0;
    }
    function disarm() {
      armed = null;
      clearTimeout(armTimer);
    }
    function paintSel() {
      cork.querySelectorAll('.col').forEach((el, c) => el.classList.toggle('sel', c === sel.c && sel.i < 0));
      cork.querySelectorAll('.card').forEach((el) => {
        const on = +el.dataset.c === sel.c && +el.dataset.i === sel.i;
        el.classList.toggle('sel', on);
        el.classList.toggle('armed', el.dataset.id === armed);
        if (on) el.scrollIntoView({ block: 'nearest' });
      });
    }
    function select(c, i) {
      if (sel.c !== c || sel.i !== i) disarm();
      sel = { c, i };
      clampSel();
      paintSel();
    }

    // ── Render ───────────────────────────────────────────────────────────
    function cardEl(card, c, i) {
      const el = document.createElement('div');
      el.className = `card c-${COLORS.includes(card.color) ? card.color : 'cream'}`;
      el.dataset.id = card.id;
      el.dataset.c = c;
      el.dataset.i = i;
      if (editing && editing.card === card) {
        el.classList.add('editing');
        const ta = document.createElement('textarea');
        ta.value = card.text;
        ta.rows = 2;
        ta.spellcheck = false;
        const fit = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
        ta.addEventListener('input', fit);
        ta.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); ev.stopPropagation(); finishEdit(true); }
        });
        ta.addEventListener('blur', () => { if (editing && editing.card === card) finishEdit(true); });
        el.appendChild(ta);
        queueMicrotask(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); fit(); });
        return el;
      }
      const text = document.createElement('div');
      text.className = 'card-text';
      text.textContent = card.text;
      const warn = document.createElement('div');
      warn.className = 'warn';
      warn.textContent = '¿BORRAR? PULSA OTRA VEZ';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.tabIndex = -1;
      del.title = 'Borrar';
      del.textContent = '✕';
      del.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      del.addEventListener('click', (ev) => {
        ev.stopPropagation();
        select(c, i);
        requestDelete();
      });
      el.append(text, warn, del);
      el.addEventListener('dblclick', () => { select(c, i); startEdit(); });
      el.addEventListener('pointerdown', (ev) => cardPointerDown(ev, el, c, i));
      return el;
    }

    function renderSpaces() {
      const cur = spaceIdx();
      const tabs = data.spaces.map((sp, i) => {
        if (naming && naming.id === sp.id) return nameInput(sp.name);
        const b = document.createElement('button');
        b.type = 'button';
        b.tabIndex = -1;
        b.className = `board-space${i === cur ? ' on' : ''}${armedSpace === sp.id ? ' armed' : ''}`;
        const n = document.createElement('b');
        n.textContent = i + 1;
        b.append(n, ` ${armedSpace === sp.id ? '¿BORRAR? SHIFT+SUPR' : sp.name}`);
        b.addEventListener('click', () => switchSpace(i));
        b.addEventListener('dblclick', () => { switchSpace(i); startNaming(sp.id); });
        return b;
      });
      if (naming && naming.id === null) tabs.push(nameInput(''));
      else if (data.spaces.length < MAX_SPACES) {
        const add = document.createElement('button');
        add.type = 'button';
        add.tabIndex = -1;
        add.className = 'board-space add';
        add.title = 'Nuevo espacio (Shift+N)';
        add.textContent = '+';
        add.addEventListener('click', () => startNaming(null));
        tabs.push(add);
      }
      spacesEl.replaceChildren(...tabs);
    }
    function nameInput(value) {
      const inp = document.createElement('input');
      inp.className = 'board-space-name';
      inp.value = value;
      inp.maxLength = 24;
      inp.spellcheck = false;
      inp.placeholder = 'NOMBRE';
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); finishNaming(true); }
      });
      inp.addEventListener('blur', () => { if (naming) finishNaming(true); });
      queueMicrotask(() => { inp.focus(); inp.select(); });
      return inp;
    }

    function render() {
      clampSel();
      renderSpaces();
      cork.replaceChildren(...COLS.map((col, c) => {
        const el = document.createElement('section');
        el.className = `col${col.id === 'pinned' ? ' pinned' : ''}`;
        el.dataset.c = c;
        const head = document.createElement('div');
        head.className = 'col-head';
        const name = document.createElement('span');
        name.className = 'col-name';
        name.textContent = col.name;
        const count = document.createElement('span');
        count.className = 'col-count';
        count.textContent = list(c).length;
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'col-add';
        add.tabIndex = -1;
        add.title = 'Nueva nota';
        add.textContent = '+';
        add.addEventListener('click', () => newCard(c));
        head.addEventListener('click', () => select(c, -1));
        head.append(name, count, add);
        const lane = document.createElement('div');
        lane.className = 'lane';
        const cards = list(c);
        if (!cards.length) {
          const empty = document.createElement('div');
          empty.className = 'board-empty';
          empty.textContent = col.id === 'pinned' ? '- sin notas fijas -' : '- vacío -';
          lane.appendChild(empty);
        }
        cards.forEach((card, i) => lane.appendChild(cardEl(card, c, i)));
        el.append(head, lane);
        return el;
      }));
      paintSel();
    }

    // ── Operaciones ──────────────────────────────────────────────────────
    function newCard(c) {
      if (!loaded) return;
      if (editing) finishEdit(true);
      const now = Date.now();
      const card = { id: uid(), text: '', color: c === 3 ? 'cream' : COLORS[Math.floor(Math.random() * 4)], created: now, updated: now };
      list(c).push(card);
      sel = { c, i: list(c).length - 1 };
      disarm();
      editing = { card, isNew: true, c };
      render();
    }
    function startEdit() {
      const card = curCard();
      if (!card || editing) return;
      disarm();
      editing = { card, isNew: false, c: sel.c, prev: card.text };
      render();
    }
    function finishEdit(commit) {
      if (!editing) return;
      const { card, isNew, c } = editing;
      const ta = cork.querySelector('textarea');
      const val = ta ? ta.value.replace(/\s+$/, '') : card.text;
      editing = null;
      if (commit && val.trim()) {
        if (val !== card.text || isNew) { card.text = val; card.updated = Date.now(); changed(); }
      } else if (isNew) {
        const arr = list(c);
        arr.splice(arr.indexOf(card), 1);   // nota nueva vacía o cancelada: no existe
      }
      render();
    }
    function removeSelected() {
      const card = curCard();
      if (!card) return;
      list(sel.c).splice(sel.i, 1);
      disarm();
      clampSel();
      render();
      changed();
    }
    function requestDelete() {
      const card = curCard();
      if (!card) return;
      if (armed === card.id) { removeSelected(); return; }
      armed = card.id;
      clearTimeout(armTimer);
      armTimer = setTimeout(() => { armed = null; paintSel(); }, 3000);
      paintSel();
    }
    function moveCard(fromC, fromI, toC, toI) {
      const [card] = list(fromC).splice(fromI, 1);
      const dst = list(toC);
      toI = Math.max(0, Math.min(dst.length, toI));
      dst.splice(toI, 0, card);
      card.updated = Date.now();
      sel = { c: toC, i: toI };
      disarm();
      render();
      changed();
    }

    // ── Espacios ─────────────────────────────────────────────────────────
    function disarmSpace() {
      if (!armedSpace) return false;
      armedSpace = null;
      return true;
    }
    function switchSpace(i) {
      if (!loaded || naming) return;
      if (editing) finishEdit(true);
      i = (i + data.spaces.length) % data.spaces.length;
      disarm();
      disarmSpace();
      if (data.spaces[i].id === data.current) { render(); return; }
      data.current = data.spaces[i].id;
      sel = { c: 0, i: -1 };
      render();
      changed();
    }
    function moveToSpace(dir) {
      const card = curCard();
      if (!card || data.spaces.length < 2) return;
      const to = data.spaces[(spaceIdx() + dir + data.spaces.length) % data.spaces.length];
      list(sel.c).splice(sel.i, 1);
      list(sel.c, to).push(card);
      card.updated = Date.now();
      disarm();
      clampSel();
      render();
      changed();
      setStatus('saving', `→ ${to.name}`);
    }
    function startNaming(id) {
      if (!loaded || naming) return;
      if (id === null && data.spaces.length >= MAX_SPACES) return;
      if (editing) finishEdit(true);
      disarm();
      disarmSpace();
      naming = { id };
      render();
    }
    function finishNaming(commit) {
      if (!naming) return;
      const { id } = naming;
      const inp = spacesEl.querySelector('input');
      const name = (inp ? inp.value : '').trim().toUpperCase().slice(0, 24);
      naming = null;
      if (commit && name) {
        if (id === null) {
          let base = name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'espacio';
          let nid = base, n = 2;
          while (data.spaces.some((s) => s.id === nid)) nid = `${base}-${n++}`;
          data.spaces.push(emptySpace(nid, name));
          data.current = nid;
          sel = { c: 0, i: -1 };
          changed();
        } else {
          const sp = data.spaces.find((s) => s.id === id);
          if (sp && sp.name !== name) { sp.name = name; changed(); }
        }
      }
      render();
    }
    function deleteSpace() {
      const sp = space();
      const notice = (t) => {
        setStatus('error', t);
        setTimeout(() => { if (statusEl.textContent === t) setStatus('ok'); }, 2500);
      };
      if (data.spaces.length < 2) { notice('ES EL ÚNICO ESPACIO'); return; }
      const n = COLS.reduce((a, _, c) => a + list(c).length, 0);
      if (n) { notice(`VACÍALO ANTES (${n} ${n === 1 ? 'NOTA' : 'NOTAS'})`); return; }
      if (armedSpace !== sp.id) {
        armedSpace = sp.id;
        clearTimeout(armTimer);
        armTimer = setTimeout(() => { armedSpace = null; renderSpaces(); }, 3000);
        renderSpaces();
        return;
      }
      armedSpace = null;
      const i = spaceIdx();
      data.spaces.splice(i, 1);
      data.current = data.spaces[Math.min(i, data.spaces.length - 1)].id;
      sel = { c: 0, i: -1 };
      render();
      changed();
    }

    // ── Arrastrar y soltar (pointer events) ──────────────────────────────
    let drag = null;
    function cardPointerDown(ev, el, c, i) {
      if (ev.button !== 0 || editing) return;
      select(c, i);
      drag = { el, c, i, x0: ev.clientX, y0: ev.clientY, on: false, ghost: null, mark: null, target: null, idx: 0 };
    }
    function dropTarget(x, y) {
      const cols = [...cork.querySelectorAll('.col')];
      let hit = null;
      for (const col of cols) {
        const r = col.getBoundingClientRect();
        if (x >= r.left - 12 && x <= r.right + 12 && y >= r.top - 12 && y <= r.bottom + 12) hit = col;
      }
      return hit;
    }
    addEventListener('pointermove', (ev) => {
      if (!drag) return;
      if (!drag.on) {
        if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) < 6) return;
        drag.on = true;
        const r = drag.el.getBoundingClientRect();
        drag.dx = drag.x0 - r.left;
        drag.dy = drag.y0 - r.top;
        const g = drag.el.cloneNode(true);
        g.classList.add('dragging-ghost');
        g.classList.remove('sel', 'armed');
        g.style.width = `${r.width}px`;
        document.body.appendChild(g);
        drag.ghost = g;
        drag.el.classList.add('lifted');
        drag.mark = document.createElement('div');
        drag.mark.className = 'drop-mark';
      }
      // el fantasma sigue al puntero a saltos de 3 px (rejilla del HUD)
      const snap = (v) => Math.round(v / 3) * 3;
      drag.ghost.style.left = `${snap(ev.clientX - drag.dx)}px`;
      drag.ghost.style.top = `${snap(ev.clientY - drag.dy)}px`;
      const col = dropTarget(ev.clientX, ev.clientY);
      cork.querySelectorAll('.col.over').forEach((e) => e.classList.remove('over'));
      if (!col) { drag.mark.remove(); drag.target = null; return; }
      col.classList.add('over');
      const lane = col.querySelector('.lane');
      const others = [...lane.querySelectorAll('.card')].filter((e) => e !== drag.el);
      let idx = 0;
      for (const e of others) {
        const r = e.getBoundingClientRect();
        if (ev.clientY > r.top + r.height / 2) idx++;
      }
      drag.target = +col.dataset.c;
      drag.idx = idx;
      const ref = others[idx] || null;
      if (ref) lane.insertBefore(drag.mark, ref); else lane.appendChild(drag.mark);
    });
    function endDrag(commit) {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (!d.on) return;
      d.ghost.remove();
      d.mark.remove();
      d.el.classList.remove('lifted');
      cork.querySelectorAll('.col.over').forEach((e) => e.classList.remove('over'));
      if (commit && d.target !== null) {
        // idx cuenta las demás tarjetas del destino: ya excluye a la arrastrada
        moveCard(d.c, d.i, d.target, d.idx);
      }
    }
    addEventListener('pointerup', () => endDrag(true));
    addEventListener('pointercancel', () => endDrag(false));
    addEventListener('blur', () => endDrag(false));

    // ── Carga inicial ────────────────────────────────────────────────────
    ctx.api('/api/board')
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then((b) => {
        const spaces = (b.spaces || []).map((s) => ({
          id: s.id,
          name: s.name,
          columns: { todo: s.columns?.todo || [], doing: s.columns?.doing || [], done: s.columns?.done || [] },
          pinned: s.pinned || [],
        }));
        if (!spaces.length) spaces.push(emptySpace('trabajo', 'TRABAJO'));
        data = { version: 2, current: b.current, spaces };
        if (!spaces.some((s) => s.id === data.current)) data.current = spaces[0].id;
        loaded = true;
        setStatus('ok');
        render();
      })
      .catch((e) => { console.error('board load', e); setStatus('error'); });
    render();

    // ── Teclado ──────────────────────────────────────────────────────────
    function key(ev) {
      if (naming) {
        if (ev.key === 'Escape') { finishNaming(false); return true; }
        return false;
      }
      if (editing) {
        if (ev.key === 'Escape') { finishEdit(false); return true; }
        return false;
      }
      if (drag && drag.on && ev.key === 'Escape') { endDrag(false); return true; }
      if (ev.ctrlKey || ev.altKey || ev.metaKey || !loaded) return false;
      const k = ev.key;
      if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta') return false;   // sueltas no desarman nada
      const lower = k.length === 1 ? k.toLowerCase() : k;
      if (k !== 'Delete') { if (armed) { disarm(); paintSel(); } }
      if (!(k === 'Delete' && ev.shiftKey) && disarmSpace()) renderSpaces();
      if (/^[1-9]$/.test(k)) {
        if (+k <= data.spaces.length) switchSpace(+k - 1);
        ev.preventDefault();
        return true;
      }
      switch (lower) {
        case 'ArrowUp': select(sel.c, Math.max(sel.i - 1, list(sel.c).length ? 0 : -1)); break;
        case 'ArrowDown': select(sel.c, Math.min(sel.i + 1, list(sel.c).length - 1)); break;
        case 'ArrowLeft':
        case 'ArrowRight': {
          const to = sel.c + (lower === 'ArrowRight' ? 1 : -1);
          if (to < 0 || to >= COLS.length) break;
          if (ev.shiftKey) {
            if (sel.i >= 0) moveCard(sel.c, sel.i, to, sel.i);
          } else {
            select(to, Math.min(sel.i, list(to).length - 1));
          }
          break;
        }
        case 'n': if (ev.shiftKey) startNaming(null); else newCard(sel.c); break;
        case 'w': switchSpace(spaceIdx() + (ev.shiftKey ? -1 : 1)); break;
        case 'm': moveToSpace(ev.shiftKey ? -1 : 1); break;
        case 'F2': startNaming(data.current); break;
        case 'e':
        case 'Enter': startEdit(); break;
        case 'c': {
          const card = curCard();
          if (card) {
            card.color = COLORS[(COLORS.indexOf(card.color) + 1) % COLORS.length];
            card.updated = Date.now();
            render();
            changed();
          }
          break;
        }
        case 'Delete': if (ev.shiftKey) deleteSpace(); else requestDelete(); break;
        default: return false;
      }
      ev.preventDefault();
      return true;
    }

    return {
      enter() { if (!sel.c && sel.i < 0) { clampSel(); paintSel(); } },
      leave() { endDrag(false); if (editing) finishEdit(true); if (naming) finishNaming(true); disarm(); disarmSpace(); render(); },
      key,
    };
  },
};
