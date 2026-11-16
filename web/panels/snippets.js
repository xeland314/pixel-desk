// Panel: bóveda de comandos. Busca, elige y COPIA comandos frecuentes; nunca
// ejecuta nada. Datos y copia al portapapeles en snippets.go (/api/snippets).
// El navegador solo envía el id y los valores de {{variables}}.

if (!document.querySelector('link[data-snippets-css]')) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./snippets.css', import.meta.url).href;
  link.dataset.snippetsCss = '1';
  document.head.appendChild(link);
}

const VAR_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

// Normaliza carácter a carácter (sin tildes, minúsculas) conservando el mapa
// hacia el texto original para poder resaltar sobre él.
function norm(text) {
  let s = '';
  const map = [];
  [...text].forEach((ch, i) => {
    const n = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (const c of n) { s += c; map.push(i); }
  });
  return { s, map, chars: [...text] };
}
const plain = (t) => norm(t).s;

function varsOf(cmd) {
  const out = [];
  for (const m of cmd.matchAll(VAR_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Título con la coincidencia resaltada, construido con nodos (nunca innerHTML).
function highlight(target, title, terms) {
  const { s, map, chars } = norm(title);
  const on = new Array(chars.length).fill(false);
  for (const t of terms) {
    for (let from = 0; ; ) {
      const at = s.indexOf(t, from);
      if (at < 0) break;
      for (let k = at; k < at + t.length; k++) on[map[k]] = true;
      from = at + t.length;
    }
  }
  let buf = '', cur = false;
  const flush = () => {
    if (!buf) return;
    target.append(cur ? el('mark', null, buf) : document.createTextNode(buf));
    buf = '';
  };
  chars.forEach((ch, i) => {
    if (on[i] !== cur) { flush(); cur = on[i]; }
    buf += ch;
  });
  flush();
}

export default {
  id: 'snippets',
  title: 'BOVEDA DE COMANDOS',
  hints: [['↑↓', 'ELEGIR'], ['ENTER', 'COPIAR'], ['ESC', 'LIMPIAR']],
  mount(root, ctx) {
    const wrap = el('div', 'sn');
    const search = el('div', 'sn-search');
    const input = el('input', 'sn-input');
    input.type = 'text';
    input.placeholder = 'BUSCAR COMANDO…';
    input.spellcheck = false;
    input.autocomplete = 'off';
    const count = el('span', 'sn-count');
    const flash = el('div', 'sn-flash');
    flash.hidden = true;
    search.append(el('span', 'sn-prompt', '>'), input, count, flash);
    const list = el('div', 'sn-list');
    const detail = el('div', 'sn-detail');
    const full = el('pre', 'sn-full');
    const desc = el('div', 'sn-desc');
    const form = el('div', 'sn-form');
    form.hidden = true;
    detail.append(full, desc, form);
    wrap.append(search, list, detail);
    root.append(wrap);

    let all = [];        // [{ sn, hay }]
    let shown = [];      // filtrados: [{ sn, row }]
    let sel = 0;
    let loadErr = '';
    let formFor = null;  // snippet cuya forma de variables está abierta
    let busy = false;
    let timer = 0;
    let focusTimer = 0;
    let gen = 0;         // descarta respuestas de aperturas anteriores

    function terms() { return plain(input.value).split(/\s+/).filter(Boolean); }

    function render() {
      const ts = terms();
      const scored = [];
      for (const it of all) {
        if (!ts.every((t) => it.hay.includes(t))) continue;
        const inTitle = ts.filter((t) => it.title.includes(t)).length;
        scored.push({ it, inTitle });
      }
      scored.sort((a, b) => b.inTitle - a.inTitle);   // sort estable: conserva el orden del archivo
      list.replaceChildren();
      shown = [];
      for (const { it } of scored) {
        const { sn } = it;
        const row = el('div', 'sn-row');
        const head = el('div', 'sn-head');
        const title = el('span', 'sn-title');
        highlight(title, sn.title, ts);
        const tags = el('span', 'sn-tags');
        for (const t of sn.tags) tags.append(el('span', 'sn-chip', t));
        head.append(title, tags);
        row.append(head, el('div', 'sn-cmd', sn.cmd));
        const idx = shown.length;
        row.addEventListener('click', () => { if (!busy) { closeForm(); select(idx); } });
        row.addEventListener('dblclick', () => { if (!busy) { select(idx); activate(); } });
        list.append(row);
        shown.push({ sn, row });
      }
      if (!shown.length) {
        list.append(el('div', 'sn-empty', loadErr || (all.length ? 'SIN COINCIDENCIAS' : 'SIN COMANDOS')));
      }
      count.textContent = all.length ? `${shown.length}/${all.length}` : '';
      sel = 0;
      select(0);
    }

    function select(i) {
      if (!shown.length) { detail.hidden = true; return; }
      sel = (i + shown.length) % shown.length;
      shown.forEach((s, k) => s.row.classList.toggle('sel', k === sel));
      shown[sel].row.scrollIntoView({ block: 'nearest' });
      const { sn } = shown[sel];
      detail.hidden = false;
      full.textContent = sn.cmd;
      desc.textContent = sn.desc || '';
      desc.hidden = !sn.desc;
    }

    function showFlash(text, err) {
      flash.textContent = text;
      flash.classList.toggle('err', !!err);
      flash.hidden = false;
    }

    function openForm(sn, names) {
      formFor = sn;
      desc.hidden = true;
      form.replaceChildren();
      for (const n of names) {
        const lab = el('label', null, n.toUpperCase());
        const inp = el('input');
        inp.type = 'text';
        inp.dataset.name = n;
        inp.spellcheck = false;
        inp.autocomplete = 'off';
        inp.maxLength = 512;
        lab.append(inp);
        form.append(lab);
      }
      form.append(el('div', 'sn-form-hint', 'ENTER SIGUIENTE/COPIAR · ESC VOLVER'));
      form.hidden = false;
      form.querySelector('input').focus();
    }

    function closeForm() {
      if (!formFor) return;
      formFor = null;
      form.hidden = true;
      form.replaceChildren();
      if (shown.length) select(sel);
      input.focus();
    }

    // Enter sobre la selección: con variables abre la forma; sin ellas copia.
    function activate() {
      if (busy || !shown.length) return;
      const { sn } = shown[sel];
      const names = varsOf(sn.cmd);
      if (names.length) openForm(sn, names);
      else copy(sn, {});
    }

    async function copy(sn, vars) {
      busy = true;
      try {
        const r = await ctx.api(`/api/snippets/copy?id=${encodeURIComponent(sn.id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vars }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        showFlash('COPIADO', false);
        timer = setTimeout(() => { timer = 0; ctx.close(); }, 450);
      } catch (err) {
        console.error('snippets copy', err);
        showFlash('ERROR AL COPIAR', true);
        timer = setTimeout(() => { timer = 0; flash.hidden = true; busy = false; }, 1200);
      }
    }

    function formKey(ev) {
      if (ev.key === 'Escape') { closeForm(); return true; }
      if (ev.key === 'Enter') {
        const inputs = [...form.querySelectorAll('input')];
        const at = inputs.indexOf(document.activeElement);
        if (at >= 0 && at < inputs.length - 1) { inputs[at + 1].focus(); return true; }
        const vars = {};
        for (const i of inputs) if (i.value !== '') vars[i.dataset.name] = i.value;
        copy(formFor, vars);
        return true;
      }
      return false;   // el resto es texto para el campo
    }

    async function load() {
      const mine = ++gen;
      loadErr = '';
      try {
        const r = await ctx.api('/api/snippets');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (mine !== gen) return;
        all = (data.snippets || []).map((sn) => ({
          sn: { ...sn, tags: sn.tags || [] },
          title: plain(sn.title || ''),
          hay: plain(`${sn.title} ${sn.cmd} ${(sn.tags || []).join(' ')}`),
        }));
      } catch (err) {
        if (mine !== gen) return;
        console.error('snippets load', err);
        all = [];
        loadErr = 'NO SE PUDO CARGAR';
      }
      render();
    }

    input.addEventListener('input', render);

    return {
      open() {
        busy = false;
        formFor = null;
        form.hidden = true;
        flash.hidden = true;
        input.value = '';
        all = [];
        render();
        input.focus();
        // El panel se abre en pointerdown y la acción por defecto del clic
        // quita el foco justo después: se reclama en cuanto termina el evento.
        focusTimer = setTimeout(() => { focusTimer = 0; if (!formFor) input.focus(); }, 60);
        load();
      },
      close() {
        gen++;               // invalida peticiones en vuelo
        clearTimeout(timer);
        clearTimeout(focusTimer);
        timer = focusTimer = 0;
        busy = false;
        formFor = null;
      },
      key(ev) {
        if (busy) return ev.key !== 'Escape';   // mientras copia, solo ESC cierra
        if (formFor) return formKey(ev);
        const k = ev.key;
        if (k === 'ArrowDown' || (ev.ctrlKey && (k === 'n' || k === 'N'))) { select(sel + 1); return true; }
        if (k === 'ArrowUp' || (ev.ctrlKey && (k === 'p' || k === 'P'))) { select(sel - 1); return true; }
        if (k === 'Enter') { activate(); return true; }
        if (k === 'Escape' && input.value) { input.value = ''; render(); return true; }
        return false;
      },
    };
  },
};
