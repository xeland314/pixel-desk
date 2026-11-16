// Gestor de cuartos de pixel-desk.
//
// El cuarto 1 es el escritorio 3D (desk.js). Los demás son módulos en
// web/rooms/<id>.js con este contrato:
//
//   export default {
//     id: 'board',                      // nombre corto, sin espacios
//     label: 'TABLERO',                 // texto de la pestaña del HUD
//     hints: [['N', 'NUEVA'], ...],     // atajos que se muestran abajo
//     mount(root, ctx) {                // se llama una vez, al arrancar
//       // root: <div class="room-body"> vacío, ya colocado entre los HUD
//       return {
//         enter() {},                   // el cuarto pasa a verse
//         leave() {},                   // el cuarto deja de verse
//         key(ev) { return false },     // true = tecla consumida
//         step(n, now) {},              // cada paso de animación (8 por s)
//       };                              // (todas opcionales)
//     },
//   };
//
//   ctx = {
//     C,            // colores resueltos de los tokens (C.accent, C.panel, C.ok…)
//     theme,        // 'dark' | 'light'
//     api(path, init) → Promise<Response>   // fetch con el token puesto
//     isActive()    // true si este cuarto es el visible
//   }
//
// Estilos: usar var(--panel), var(--ink), var(--accent)… (cambian solos con
// el tema) y las clases .px-panel / .px-title de desk.css.

const STEP_MS = 60;     // la transición va a saltos, como el resto
const SLIDE = [0.25, 0.5, 0.75, 1];

export function createRooms({ desk, modules, ctxBase, onChange }) {
  const rooms = [desk, ...modules];
  const nav = document.getElementById('rooms-nav');
  const footer = document.getElementById('hints');
  let index = 0;
  let busy = false;
  let pending = null;   // cambio pedido durante una transición

  // Contenedores de los módulos
  rooms.forEach((room, i) => {
    if (i === 0) {
      room.section = document.getElementById('room-desk');
      room.api = { enter() {}, leave() {}, key: () => false, step() {} };
      return;
    }
    const section = document.createElement('section');
    section.className = 'room';
    section.id = `room-${room.id}`;
    section.hidden = true;
    const body = document.createElement('div');
    body.className = 'room-body';
    section.appendChild(body);
    document.body.insertBefore(section, document.querySelector('.hud-top'));
    room.section = section;
    const ctx = { ...ctxBase, isActive: () => rooms[index] === room };
    try {
      room.api = { enter() {}, leave() {}, key: () => false, step() {}, ...(room.mount(body, ctx) || {}) };
    } catch (err) {
      console.error('cuarto', room.id, err);
      body.textContent = `error al cargar ${room.id}`;
      room.api = { enter() {}, leave() {}, key: () => false, step() {} };
    }
  });

  function renderNav() {
    nav.replaceChildren(...rooms.map((room, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.tabIndex = -1;    // Tab es nuestro: el foco no debe saltar a los botones
      b.textContent = `${i + 1} ${room.label}`;
      b.className = i === index ? 'on' : '';
      b.addEventListener('click', () => go(i));
      return b;
    }));
  }

  function renderHints() {
    const all = [...rooms[index].hints, ['TAB', 'CUARTO'], ['T', 'TEMA'], ['CTRL+Q', 'SALIR']];
    footer.replaceChildren(...all.map(([k, text, id]) => {
      const span = document.createElement('span');
      const b = document.createElement('b');
      b.textContent = k;
      if (id) b.id = id;
      span.append(b, ` ${text}`);
      return span;
    }));
  }

  function go(next) {
    next = (next + rooms.length) % rooms.length;
    if (busy) { pending = next; return; }
    if (next === index) return;
    busy = true;
    const from = rooms[index];
    const to = rooms[next];
    const dir = next > index ? 1 : -1;
    from.api.leave();
    to.section.hidden = false;
    let i = 0;
    const tick = () => {
      const t = SLIDE[i];
      from.section.style.transform = `translateX(${-dir * t * 100}%)`;
      to.section.style.transform = `translateX(${dir * (1 - t) * 100}%)`;
      if (++i < SLIDE.length) { setTimeout(tick, STEP_MS); return; }
      from.section.hidden = true;
      from.section.style.transform = '';
      to.section.style.transform = '';
      index = next;
      busy = false;
      renderNav();
      renderHints();
      to.api.enter();
      onChange(index);
      if (pending !== null) { const p = pending; pending = null; go(p); }
    };
    to.section.style.transform = `translateX(${dir * 100}%)`;
    setTimeout(tick, STEP_MS);
  }

  const editing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  renderNav();
  renderHints();

  return {
    get index() { return index; },
    onDesk: () => index === 0 && !busy,
    deskVisible: () => index === 0 || busy,
    go,
    /** true = la tecla ya se procesó y desk.js no debe tocarla. */
    handleKey(ev) {
      if (editing(ev.target)) {
        if (ev.key === 'Escape') rooms[index].api.key(ev);   // el cuarto decide cómo cancelar
        return true;
      }
      // WebKitGTK puede reportar Shift+Tab como ISO_Left_Tab: se mira también ev.code.
      if ((ev.key === 'Tab' || ev.code === 'Tab' || ev.key === 'ISO_Left_Tab') && !ev.ctrlKey && !ev.altKey) {
        ev.preventDefault();
        const base = pending !== null ? pending : index;
        go(base + (ev.shiftKey ? -1 : 1));
        return true;
      }
      if (index !== 0 && rooms[index].api.key(ev)) return true;
      return false;
    },
    step(n, now) { for (const r of rooms) if (r !== rooms[0]) r.api.step(n, now); },
    start(initial) {
      if (initial > 0 && initial < rooms.length) {
        rooms[0].section.hidden = true;
        rooms[initial].section.hidden = false;
        index = initial;
        renderNav();
        renderHints();
        rooms[initial].api.enter();
        onChange(index);
      }
    },
  };
}
