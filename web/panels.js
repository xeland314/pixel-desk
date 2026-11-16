// Paneles modales del cuarto 1: un objeto de la escena puede abrir una
// herramienta en vez de lanzar un programa. En config/apps.json:
//
//   { "id": "settings", "label": "COMANDOS", "hint": "…", "panel": "snippets" }
//
// Cada panel es un módulo en web/panels/<id>.js con este contrato:
//
//   export default {
//     id: 'snippets',                   // coincide con "panel" de apps.json
//     title: 'BOVEDA DE COMANDOS',      // barra de título del modal
//     hints: [['ENTER', 'COPIAR'], …],  // atajos que se muestran en el pie del modal
//     mount(root, ctx) {                // una vez, al arrancar; root es el cuerpo del modal
//       return {
//         open() {},                    // se abre: cargar datos, poner el foco
//         close() {},                   // se cierra: parar timers y peticiones
//         key(ev) { return false },     // true = tecla consumida
//       };
//     },
//   };
//
//   ctx = { C, theme, api(path, init), close() }   // close() cierra el modal
//
// Reglas: nada de innerHTML con datos (usar textContent); nada corriendo
// mientras el panel está cerrado. Escape y clic fuera cierran el modal si el
// panel no consume la tecla.

export function createPanels({ modules, ctxBase }) {
  const byId = new Map();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.hidden = true;
  const modal = document.createElement('div');
  modal.className = 'modal px-panel accent';
  const bar = document.createElement('div');
  bar.className = 'modal-bar';
  const title = document.createElement('span');
  title.className = 'px-title';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'modal-close';
  closeBtn.textContent = '✕';
  closeBtn.tabIndex = -1;
  bar.append(title, closeBtn);
  const foot = document.createElement('div');
  foot.className = 'modal-foot';
  modal.append(bar, foot);   // los cuerpos de los paneles se insertan entre ambos
  backdrop.append(modal);
  document.getElementById('room-desk').appendChild(backdrop);

  let current = null;

  for (const mod of modules) {
    const body = document.createElement('div');
    body.className = 'modal-body';
    body.hidden = true;
    modal.insertBefore(body, foot);
    const ctx = { ...ctxBase, close: () => close() };
    let api;
    try {
      api = { open() {}, close() {}, key: () => false, ...(mod.mount(body, ctx) || {}) };
    } catch (err) {
      console.error('panel', mod.id, err);
      body.textContent = `error al cargar ${mod.id}`;
      api = { open() {}, close() {}, key: () => false };
    }
    byId.set(mod.id, { mod, body, api });
  }
  function renderFoot(hints) {
    foot.replaceChildren(...[...hints, ['ESC', 'CERRAR']].map(([k, t]) => {
      const s = document.createElement('span');
      const b = document.createElement('b');
      b.textContent = k;
      s.append(b, ` ${t}`);
      return s;
    }));
  }

  function open(id) {
    const p = byId.get(id);
    if (!p) { console.warn('panel desconocido', id); return false; }
    if (current) close();
    current = p;
    title.textContent = p.mod.title;
    renderFoot(p.mod.hints || []);
    p.body.hidden = false;
    backdrop.hidden = false;
    p.api.open();
    return true;
  }

  function close() {
    if (!current) return;
    const p = current;
    current = null;
    p.api.close();
    p.body.hidden = true;
    backdrop.hidden = true;
    if (document.activeElement && modal.contains(document.activeElement)) document.activeElement.blur();
  }

  function key(ev) {
    if (!current) return false;
    if (current.api.key(ev)) { ev.preventDefault(); return true; }
    if (ev.key === 'Escape') { close(); ev.preventDefault(); return true; }
    if (ev.key === 'Tab') ev.preventDefault();       // no cambiar de cuarto con un modal abierto
    return true;                                     // el resto no llega a la escena
  }

  // Las teclas que nacen dentro del modal (inputs incluidos) se resuelven aquí
  // y no siguen hasta window, donde el gestor de cuartos las trataría como texto.
  modal.addEventListener('keydown', (ev) => { key(ev); ev.stopPropagation(); });
  backdrop.addEventListener('pointerdown', (ev) => { if (ev.target === backdrop) close(); });
  closeBtn.addEventListener('click', close);

  return {
    open,
    close,
    has: (id) => byId.has(id),
    isOpen: () => current !== null,
    /** Para teclas que llegan a window con el modal abierto (foco fuera de él). */
    key,
  };
}
