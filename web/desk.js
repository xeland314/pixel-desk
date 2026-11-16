// pixel-desk — escena 2.5D en pixel-art.
//
// Idea: geometría 3D real (cajas) en proyección oblicua, renderizada a baja
// resolución (1 px de escena = 6 px de pantalla) y sin suavizado. Las caras
// frontales quedan 1:1 con la rejilla de píxeles; solo la profundidad se
// inclina. El movimiento va cuantizado a 8 fps, como `steps()` en los videos.
import * as THREE from './vendor/three.module.js';
import { createRooms } from './rooms.js';
import board from './rooms/board.js';
import monitor from './rooms/monitor.js';
import calendar from './rooms/calendar.js';
import rack from './rooms/rack.js';
import { createPanels } from './panels.js';
import snippetsPanel from './panels/snippets.js';
import logPanel from './panels/log.js';

const FPS = 8;         // pasos de animación por segundo
const VIEW_W = 320;    // la escena está compuesta para 320×200 (1920×1200 / 6)
const VIEW_H = 200;

const params = new URLSearchParams(location.search);
const TOKEN = params.get('t') || '';
// Tamaño en pantalla de un píxel de escena. 6 = pixel-art grueso (320×200 en
// 1920×1200); 3 = el doble de fino. La composición no cambia, solo el grano.
const PX = Math.min(12, Math.max(1, parseInt(params.get('px'), 10) || 3));
// Tema: ?theme=light|dark (por defecto oscuro). Se fija antes de leer tokens.
const THEME = params.get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.dataset.theme = THEME;
if (params.get('desktop')) document.body.classList.add('desktop');

// ── Tokens de marca (única fuente: assets/styles/tokens.css) ────────────────
const css = getComputedStyle(document.documentElement);
const tok = (name) => css.getPropertyValue(name).trim();
const C = {
  cream: '--cat-cream', sand: '--cat-sand', orange: '--cat-orange', rust: '--cat-rust',
  brown: '--cat-brown', charcoal: '--cat-charcoal', gray: '--cat-gray', sage: '--cat-sage',
  ground: '--ground', panel: '--panel', panel2: '--panel-2', line: '--line',
  screen: '--screen', screen2: '--screen-2',
  ok: '--sem-ok', alt: '--sem-alt', magic: '--sem-magic', bad: '--sem-bad',
  kw: '--tok-kw', str: '--tok-str', fn: '--tok-fn', num: '--tok-num',
};
for (const k in C) C[k] = tok(C[k]);

// ── Render ──────────────────────────────────────────────────────────────────
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
renderer.setPixelRatio(1);

const scene = new THREE.Scene();
scene.background = new THREE.Color(C.ground);

// Cámara de frente, sin inclinación: el volumen lo pone el cizallado de
// `world` (cada unidad de fondo desplaza KX px a la derecha y KY px arriba).
const camera = new THREE.OrthographicCamera(-160, 160, 100, -100, 1, 2000);
camera.position.set(0, 12, 600);
camera.lookAt(0, 12, 0);
camera.updateMatrixWorld();

const world = new THREE.Group();
world.matrixAutoUpdate = false;
scene.add(world);
const BASE_KX = 0.3;
const KY = 0.4;
let kx = BASE_KX;

function setShear() {
  world.matrix.set(
    1, 0, -kx, 0,
    0, 1, -KY, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  );
  world.matrixWorldNeedsUpdate = true;
  scene.updateMatrixWorld(true);
}

// Luz fija: cada cara de una caja queda de un solo tono (arriba claro,
// frente medio, lado oscuro), que es lo que da el aspecto de sprite.
const ambient = new THREE.AmbientLight(0xffffff, Math.PI * 0.5);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xffffff, Math.PI * 0.75);
sun.position.set(-0.3, 0.85, 0.45);
scene.add(sun);

// ── Utilidades de construcción ──────────────────────────────────────────────
/** Caja apoyada en y (no centrada): x,z son el centro, y es la base. */
function box(parent, w, h, d, color, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color }),
  );
  m.position.set(x, y + h / 2, z);
  parent.add(m);
  return m;
}

/** Textura dibujada a mano sobre un canvas diminuto, sin filtrado. */
function pixelTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  const redraw = () => { g.clearRect(0, 0, w, h); draw(g, w, h); t.needsUpdate = true; };
  redraw();
  return { t, redraw };
}

/** Plano con una textura pixel, sin iluminación (colores exactos del token). */
function screen(parent, w, h, tex, x, y, z) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

// Colores que cambian con el tema y no son tokens de marca: el cielo de la
// ventana y la luz ambiente (en claro la habitación está más iluminada).
const MOOD = THEME === 'light'
  ? { night: '#1d293d', ambient: 0.62, sun: 0.62 }
  : { night: '#10102a', ambient: 0.5, sun: 0.75 };

ambient.intensity = Math.PI * MOOD.ambient;
sun.intensity = Math.PI * MOOD.sun;

// Fuente 3×5 para lo que se escribe dentro de la escena.
const GLYPH = {
  0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111',
  4: '101101111001001', 5: '111100111001111', 6: '111100111101111', 7: '111001001001001',
  8: '111101111101111', 9: '111101111001111', ':': '000010000010000', '$': '011110010011110',
  '>': '100010001010100', '_': '000000000000111',
};
function text35(g, str, x, y, color) {
  g.fillStyle = color;
  for (const ch of str) {
    const bits = GLYPH[ch];
    if (bits) for (let i = 0; i < 15; i++) if (bits[i] === '1') g.fillRect(x + (i % 3), y + ((i / 3) | 0), 1, 1);
    x += 4;
  }
}
const pad = (n) => String(n).padStart(2, '0');

// ── Habitación ──────────────────────────────────────────────────────────────
function gridTexture(fill, line) {
  const { t } = pixelTexture(8, 8, (g) => {
    g.fillStyle = fill; g.fillRect(0, 0, 8, 8);
    g.fillStyle = line; g.fillRect(0, 0, 8, 1); g.fillRect(0, 0, 1, 8);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
{
  const wallTex = gridTexture(C.panel, C.panel2);
  wallTex.repeat.set(480 / 8, 240 / 8);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(480, 240), new THREE.MeshBasicMaterial({ map: wallTex }));
  wall.position.set(0, 58, -46);
  world.add(wall);

  const floorTex = gridTexture(C.panel2, C.line);
  floorTex.repeat.set(480 / 8, 240 / 8);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(480, 240), new THREE.MeshBasicMaterial({ map: floorTex }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -62, 74);
  world.add(floor);

  // Zócalo naranja: la línea de acento de la marca.
  box(world, 480, 3, 2, C.orange, 0, -62, -45);

  // Mesa
  box(world, 264, 6, 78, C.rust, 0, -6, 0);            // tablero
  box(world, 252, 12, 3, C.brown, 0, -18, 34);         // faldón frontal
  for (const [x, z] of [[-122, 30], [122, 30], [-122, -30], [122, -30]]) box(world, 8, 56, 8, C.brown, x, -62, z);
  box(world, 62, 34, 62, C.brown, 88, -40, 2);         // cajonera

  // Repisa de pared
  box(world, 100, 4, 22, C.brown, -84, 52, -34);
  box(world, 4, 10, 16, C.charcoal, -124, 42, -36);
  box(world, 4, 10, 16, C.charcoal, -44, 42, -36);
}

// ── Objetos lanzables ───────────────────────────────────────────────────────
const items = [];      // { id, group, baseY, baseZ, tick?, slide? }
const tickers = [];    // funciones (step, date) llamadas en cada paso

function item(id, x, y, z, build) {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.userData.id = id;
  const extra = build(group) || {};
  world.add(group);
  items.push({ id, group, baseY: y, baseZ: z, ...extra });
}

// Archivos: carpetas de pie en la repisa.
item('files', -84, 56, -34, (g) => {
  const cols = [C.sand, C.orange, C.sand, C.sage, C.rust, C.sand];
  cols.forEach((c, i) => {
    const f = box(g, 8, 24 + (i % 3) * 2, 16, c, -30 + i * 10, 0, 0);
    box(g, 4, 3, 1, C.cream, -30 + i * 10, 14, 8.5);   // etiqueta del lomo
    if (i === cols.length - 1) { f.rotation.z = -0.22; f.position.x += 4; }
  });
});

// Terminal: monitor CRT con reloj.
item('terminal', -92, 0, -4, (g) => {
  box(g, 24, 4, 22, C.gray, 0, 0, 0);
  box(g, 42, 32, 30, C.charcoal, 0, 4, 0);
  box(g, 36, 26, 1, C.brown, 0, 7, 15.2);            // marco
  const term = pixelTexture(30, 20, (c, w, h) => {
    const now = new Date();
    c.fillStyle = C.screen; c.fillRect(0, 0, w, h);
    text35(c, '$', 2, 2, C.ok);
    c.fillStyle = C.sage; c.fillRect(7, 3, 12, 1); c.fillRect(7, 5, 7, 1);
    text35(c, `${pad(now.getHours())}:${pad(now.getMinutes())}`, 6, 9, C.ok);
    if (now.getSeconds() % 2 === 0) text35(c, '_', 25, 13, C.orange);
    c.fillStyle = C.screen2; c.fillRect(0, 16, w, 1);
    text35(c, '>', 2, 16, C.alt);
  });
  screen(g, 30, 20, term.t, 0, 20, 15.9);
  box(g, 2, 2, 1, C.ok, 16, 6, 15.4);                 // led
  let lastSec = -1;
  tickers.push((step, now) => {
    if (now.getSeconds() !== lastSec) { lastSec = now.getSeconds(); term.redraw(); return true; }
    return false;
  });
});

// Código: pila de libros con los colores del resaltado de sintaxis.
item('code', -42, 0, 4, (g) => {
  const a = box(g, 36, 7, 26, C.kw, 0, 0, 0);
  box(g, 34, 5, 1, C.cream, 1, 1, 13.2);              // páginas
  const b = box(g, 32, 7, 24, C.fn, 1, 7, 0);
  b.rotation.y = 0.16;
  const c = box(g, 28, 6, 20, C.num, -1, 14, 0);
  c.rotation.y = -0.12;
  box(g, 6, 2, 12, C.str, -1, 20, 0);                 // marcapáginas
  a.rotation.y = -0.04;
});

// Lanzador: la mascota, hecha con cajas y la paleta del sprite original.
// Teclea en su portátil, mueve la cola y parpadea, todo a pasos.
item('launcher', 2, 0, 20, (g) => {
  const rug = new THREE.Mesh(new THREE.CylinderGeometry(17, 17, 0.6, 24), new THREE.MeshLambertMaterial({ color: C.sand }));
  rug.scale.x = 1.7;
  rug.position.set(0, 0.3, 0);
  g.add(rug);

  // Portátil, a la izquierda del gato
  box(g, 16, 2, 11, C.charcoal, -19, 0.6, 4);
  box(g, 14, 0.4, 6, C.gray, -19, 2.6, 5.5);          // teclado
  box(g, 16, 12, 1.5, C.charcoal, -19, 2.6, -1.5);    // tapa
  const lap = pixelTexture(14, 10, (c, w, h) => {
    c.fillStyle = C.screen; c.fillRect(0, 0, w, h);
    c.fillStyle = C.ok; c.fillRect(1, 1, 5, 1);
    c.fillStyle = C.sage; c.fillRect(1, 3, 10, 1); c.fillRect(1, 5, 7, 1);
    c.fillStyle = C.orange; c.fillRect(1, 7, 3, 1);
  });
  screen(g, 14, 10, lap.t, -19, 8.6, -0.6);

  // Cuerpo sentado
  box(g, 16, 10, 12, C.orange, 2, 0.6, -1);
  box(g, 8, 7, 1, C.cream, 2, 1.6, 5.1);              // pecho
  for (const z of [-4.5, -0.5]) box(g, 0.6, 7, 2, C.rust, 10.1, 2.6, z);  // rayas del costado

  // Cabeza grande, estilo mascota
  const head = new THREE.Group();
  head.position.set(2, 10.6, 0);
  box(head, 22, 16, 14, C.orange, 0, 0, 0);
  for (const x of [-8, 8]) {
    box(head, 6, 5, 4, C.orange, x, 16, 0);           // orejas
    box(head, 4, 3, 1, C.sand, x, 16, 2.1);
  }
  for (const x of [-4, 0, 4]) {
    box(head, 2, 3, 1, C.rust, x, 13, 7.1);           // rayas de la frente
    box(head, 2, 0.6, 9, C.rust, x, 16, 1);           // y su continuación arriba
  }
  for (const x of [-10.5, 10.5]) box(head, 1, 2, 1, C.rust, x, 5, 7.1);   // mejillas
  for (const z of [-3, 1]) box(head, 0.6, 3, 2, C.rust, 11.1, 9, z);
  box(head, 10, 6, 1, C.cream, 0, 0, 7.1);            // hocico
  box(head, 2, 2, 1, C.rust, 0, 4.4, 7.7);            // nariz
  const eyes = [-6, 6].map((x) => {
    const eye = new THREE.Group();
    eye.position.set(x, 8, 7.1);
    box(eye, 3, 4, 1, C.brown, 0, -2, 0);
    box(eye, 1, 1, 0.6, C.cream, -1, 1, 0.4);         // brillo
    head.add(eye);
    return eye;
  });
  g.add(head);

  // Patas: la izquierda va sobre el teclado
  const pawL = box(g, 6, 3, 6, C.orange, -9, 2.6, 6);
  const tipL = box(g, 6, 1, 1, C.cream, -9, 2.6, 9.4);
  box(g, 5, 3, 5, C.orange, 7, 0.6, 7);
  box(g, 5, 1, 1, C.cream, 7, 0.6, 9.9);

  // Cola: base tumbada y punta que se mueve
  box(g, 10, 4, 4, C.orange, 15, 0.6, -4);
  const tail = new THREE.Group();
  tail.position.set(20, 3, -4);
  box(tail, 4, 9, 4, C.orange, 0, 0, 0);
  box(tail, 4, 2, 4.4, C.rust, 0, 4, 0);
  box(tail, 4, 4, 4, C.rust, 0, 9, 0);
  g.add(tail);

  const WAG = [0, -0.16, -0.32, -0.16, 0, 0.12, 0.24, 0.12];
  return {
    tick: (step) => {
      tail.rotation.z = WAG[(step >> 1) % WAG.length];
      const up = step % 2;                            // teclea
      pawL.position.y = 4.1 + up;
      tipL.position.y = 3.1 + up;
      const blink = step % 40 === 39;
      for (const e of eyes) e.scale.y = blink ? 0.25 : 1;
    },
  };
});

// Música: tocadiscos; el disco gira a pasos.
item('music', 46, 0, 0, (g) => {
  box(g, 42, 8, 34, C.charcoal, 0, 0, 0);
  box(g, 42, 2, 34, C.gray, 0, 8, 0);
  const disc = new THREE.Group();
  disc.position.set(-4, 10, 0);
  const platter = new THREE.Mesh(new THREE.CylinderGeometry(13, 13, 2, 16), new THREE.MeshLambertMaterial({ color: C.screen2 }));
  platter.position.y = 1;
  disc.add(platter);
  const lab = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 2.6, 8), new THREE.MeshLambertMaterial({ color: C.orange }));
  lab.position.y = 1.3;
  disc.add(lab);
  box(disc, 2, 0.6, 7, C.cream, 0, 2.1, 8);           // brillo: deja ver el giro
  g.add(disc);
  const arm = box(g, 2, 2, 20, C.sage, 15, 11, -2);
  arm.rotation.y = 0.35;
  box(g, 4, 5, 4, C.sand, 16, 10, -12);
  box(g, 2, 2, 1, C.ok, -16, 3, 17.2);
  // El disco gira mientras suena (o si no se sabe: aún no se ha consultado).
  return { tick: (step) => { if (!music || music.status === 'Playing') disc.rotation.y = -(step % 16) * (Math.PI / 8); } };
});

// Slides: caballete con una diapositiva (lanza slides.c).
item('slides', 98, 0, -8, (g) => {
  const l1 = box(g, 2, 44, 2, C.brown, -14, 0, 2);
  const l2 = box(g, 2, 44, 2, C.brown, 14, 0, 2);
  const l3 = box(g, 2, 42, 2, C.brown, 0, 0, -10);
  l1.rotation.x = l2.rotation.x = -0.14;
  l3.rotation.x = 0.2;
  const board = new THREE.Group();
  board.position.set(0, 27, 4);
  box(board, 44, 30, 2, C.charcoal, 0, -15, 0);
  const slide = pixelTexture(40, 26, (c, w, h) => {
    c.fillStyle = C.cream; c.fillRect(0, 0, w, h);
    c.fillStyle = C.orange; c.fillRect(3, 3, 22, 4);
    c.fillStyle = C.charcoal;
    c.fillRect(3, 10, 3, 2); c.fillRect(8, 10, 24, 2);
    c.fillRect(3, 14, 3, 2); c.fillRect(8, 14, 18, 2);
    c.fillRect(3, 18, 3, 2); c.fillRect(8, 18, 21, 2);
    c.fillStyle = C.rust; c.fillRect(30, 20, 7, 3);
  });
  screen(board, 40, 26, slide.t, 0, 0, 1.2);
  g.add(board);
  box(g, 34, 2, 4, C.brown, 0, 9, 5);                 // repisa del caballete
});

// Cajones: al seleccionarlos se abren hacia el frente en vez de saltar.
function drawer(g, fill) {
  box(g, 54, 12, 2, C.rust, 0, 0, 0);                 // frente
  box(g, 8, 2, 2, C.orange, 0, 5, 2);                 // tirador
  box(g, 50, 9, 2, C.brown, 0, 1, -29);               // fondo
  for (const x of [-24, 24]) box(g, 2, 9, 28, C.brown, x, 1, -15);
  box(g, 46, 1, 28, C.panel2, 0, 1, -15);             // base interior
  fill(g);
}
item('settings', 88, -22, 34, (g) => {
  drawer(g, (d) => {                                  // herramientas
    box(d, 3, 2, 16, C.sage, -14, 2, -14);
    box(d, 3, 3, 5, C.orange, -14, 2, -5);
    box(d, 8, 2, 8, C.gray, 0, 2, -14);
    box(d, 4, 3, 4, C.panel, 0, 2, -14);
    box(d, 3, 2, 14, C.alt, 13, 2, -15);
  });
  return { slide: 14 };
});
item('leave', 88, -37, 34, (g) => {
  drawer(g, (d) => {                                  // la llave y el botón rojo
    box(d, 5, 2, 5, C.num, -12, 2, -17);
    box(d, 2, 2, 10, C.num, -12, 2, -9);
    box(d, 3, 2, 2, C.num, -10, 2, -6);
    box(d, 10, 3, 10, C.charcoal, 8, 2, -13);
    box(d, 6, 2, 6, C.bad, 8, 5, -13);
  });
  return { slide: 14 };
});

// Web: ventana de navegador colgada en la pared; el cielo sigue la hora.
item('browser', 30, 40, -44, (g) => {
  box(g, 58, 42, 3, C.gray, 0, 0, 0);
  const sky = pixelTexture(52, 36, (c, w, h) => {
    const hr = new Date().getHours();
    const night = hr < 6 || hr >= 19;
    const dusk = hr === 6 || hr === 18;
    c.fillStyle = night ? MOOD.night : dusk ? C.rust : C.alt;
    c.fillRect(0, 0, w, h);
    if (night) {
      c.fillStyle = C.cream;
      for (const [x, y] of [[6, 12], [15, 20], [24, 10], [44, 24], [31, 26], [10, 28], [47, 12]]) c.fillRect(x, y, 1, 1);
      c.fillRect(36, 12, 6, 6); c.fillStyle = MOOD.night; c.fillRect(39, 11, 5, 5);   // luna
    } else {
      c.fillStyle = dusk ? C.orange : C.num; c.fillRect(36, 12, 7, 7);                // sol
      c.fillStyle = C.cream; c.fillRect(6, 15, 12, 3); c.fillRect(9, 13, 6, 2);       // nube
    }
    c.fillStyle = C.str; c.fillRect(0, 30, w, 6);                                     // colinas
    c.fillRect(4, 28, 16, 2); c.fillRect(30, 27, 18, 3);
    c.fillStyle = C.panel2; c.fillRect(0, 0, w, 7);                                   // barra
    c.fillStyle = C.bad; c.fillRect(2, 2, 3, 3);
    c.fillStyle = C.num; c.fillRect(7, 2, 3, 3);
    c.fillStyle = C.ok; c.fillRect(12, 2, 3, 3);
    c.fillStyle = C.line; c.fillRect(18, 2, 30, 3);
  });
  screen(g, 52, 36, sky.t, 0, 21, 1.7);
  let lastHour = -1;
  tickers.push((step, now) => {
    if (now.getHours() !== lastHour) { lastHour = now.getHours(); sky.redraw(); return true; }
    return false;
  });
});

// ── Selección ───────────────────────────────────────────────────────────────
const labelEl = document.getElementById('label');
const titleEl = labelEl.querySelector('.label-title');
const hintEl = labelEl.querySelector('.label-hint');
const HOP = [0, 1, 2, 1];                     // saltito del objeto seleccionado
const glow = new THREE.Color(C.orange).multiplyScalar(0.16);
const black = new THREE.Color(0x000000);

let meta = {};          // id → { label, hint }
let order = [];         // items ordenados de izquierda a derecha en pantalla
let selected = null;
let busyUntil = 0;
let dirty = true;
let step = 0;
let selStep = 0;        // paso en que empezó la selección actual

function setSelected(it) {
  if (selected === it) return;
  for (const prev of items) {
    const on = prev === it;
    prev.group.position.y = prev.baseY;
    prev.group.position.z = prev.baseZ;
    prev.group.traverse((o) => { if (o.material && o.material.emissive) o.material.emissive.copy(on ? glow : black); });
  }
  selected = it;
  selStep = step;
  labelEl.className = '';
  dirty = true;
}

const wp = new THREE.Vector3();
const worldPos = (obj) => obj.getWorldPosition(wp);
function toScreen(v) {
  const p = v.clone().project(camera);
  return {
    x: (p.x * 0.5 + 0.5) * canvas.clientWidth,
    y: (-p.y * 0.5 + 0.5) * canvas.clientHeight,
  };
}

const bounds = new THREE.Box3();
const top = new THREE.Vector3();
function updateOverlay() {
  if (!selected) { labelEl.hidden = true; return; }
  bounds.setFromObject(selected.group);
  bounds.getCenter(top);
  top.y = bounds.max.y;
  const at = toScreen(top);
  const m = meta[selected.id] || { label: selected.id.toUpperCase(), hint: '' };
  titleEl.textContent = m.label;
  if (performance.now() > busyUntil) {
    labelEl.className = '';
    hintEl.textContent = selected.id === 'music' && music && music.title
      ? `${music.status === 'Playing' ? '>' : '||'} ${music.title}${music.artist ? ` · ${music.artist}` : ''}`
      : m.hint;
  }
  labelEl.style.left = `${Math.round(at.x / 3) * 3}px`;
  labelEl.style.top = `${Math.round(at.y / 3) * 3}px`;
  labelEl.hidden = false;
}

async function launch(it) {
  if (!it) return;
  setSelected(it);
  const panel = meta[it.id] && meta[it.id].panel;
  if (panel) { panels.open(panel); return; }
  busyUntil = performance.now() + 1400;
  labelEl.className = 'busy';
  hintEl.textContent = 'abriendo...';
  try {
    const r = await fetch(`/api/launch?id=${encodeURIComponent(it.id)}`, { method: 'POST', headers: { 'X-Desk-Token': TOKEN } });
    if (!r.ok) throw new Error(await r.text());
  } catch (err) {
    labelEl.className = 'fail';
    hintEl.textContent = 'no se pudo abrir';
    console.error('launch', it.id, err);
  }
  dirty = true;
}

// ── Entrada ─────────────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
function pick(ev) {
  const r = canvas.getBoundingClientRect();
  pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(items.map((i) => i.group), true)[0];
  if (!hit) return null;
  let o = hit.object;
  while (o && !o.userData.id) o = o.parent;
  return o ? items.find((i) => i.group === o) : null;
}

addEventListener('pointermove', (ev) => {
  if (!rooms.onDesk() || panels.isOpen()) return;
  const it = pick(ev);
  if (it) setSelected(it);
  document.body.style.cursor = it ? 'pointer' : 'default';
  // Paralaje a pasos: delata que hay volumen sin dejar de ser pixel-art.
  const next = BASE_KX + Math.round((ev.clientX / innerWidth - 0.5) * 6) * 0.03;
  if (next !== kx) { kx = next; setShear(); dirty = true; }
});
addEventListener('pointerdown', (ev) => { if (ev.button === 0 && rooms.onDesk() && !panels.isOpen() && ev.target === canvas) launch(pick(ev)); });
addEventListener('contextmenu', (ev) => ev.preventDefault());
// El lienzo nunca necesita foco: sin esto, el clic que abre un panel se lleva
// el foco justo después de que el panel lo pone en su campo de texto.
canvas.addEventListener('mousedown', (ev) => ev.preventDefault());

addEventListener('keydown', (ev) => {
  if (panels.isOpen()) { panels.key(ev); return; }   // un modal abierto se queda con el teclado
  if (rooms.handleKey(ev)) return;     // cambio de cuarto, texto en edición o tecla del cuarto
  if (ev.ctrlKey && ev.key.toLowerCase() === 'q') {
    fetch('/api/quit', { method: 'POST', headers: { 'X-Desk-Token': TOKEN } });
    return;
  }
  if (ev.key.toLowerCase() === 't' && !ev.ctrlKey) {
    const next = new URLSearchParams(location.search);
    next.set('theme', THEME === 'light' ? 'dark' : 'light');
    next.set('room', String(rooms.index + 1));
    location.search = next.toString();
    return;
  }
  if (!rooms.onDesk()) return;
  if (selected && selected.id === 'music' && [' ', ',', '.'].includes(ev.key)) {
    musicCmd({ ' ': 'playpause', ',': 'previous', '.': 'next' }[ev.key]);
    ev.preventDefault();
    return;
  }
  const i = order.indexOf(selected);
  if (ev.key === 'ArrowRight') setSelected(order[(i + 1) % order.length]);
  else if (ev.key === 'ArrowLeft') setSelected(order[(i - 1 + order.length) % order.length]);
  else if (ev.key === 'Enter' || ev.key === ' ') launch(selected);
  else if (/^[1-9]$/.test(ev.key) && order[ev.key - 1]) launch(order[ev.key - 1]);
  else return;
  ev.preventDefault();
});

// ── Tamaño ──────────────────────────────────────────────────────────────────
function resize() {
  const w = Math.max(1, Math.ceil(innerWidth / PX));
  const h = Math.max(1, Math.ceil(innerHeight / PX));
  renderer.setSize(w, h, false);
  canvas.style.width = `${w * PX}px`;
  canvas.style.height = `${h * PX}px`;
  camera.left = -w / 2; camera.right = w / 2; camera.top = h / 2; camera.bottom = -h / 2;
  camera.zoom = Math.min(w / VIEW_W, h / VIEW_H);   // la composición siempre cabe entera
  camera.updateProjectionMatrix();
  setShear();
  const sx = new Map(items.map((i) => [i, toScreen(worldPos(i.group)).x]));
  order = [...items].sort((a, b) => sx.get(a) - sx.get(b));
  const direct = document.getElementById('hint-direct');
  if (direct) direct.textContent = `1-${order.length}`;
  dirty = true;
}
addEventListener('resize', resize);

// ── Tocadiscos ↔ reproductor (MPRIS, ver mpris.go) ──────────────────────────
// Solo se consulta con el cuarto 1 visible, sin modal y con el tocadiscos
// seleccionado: cada 2 s (16 pasos).
let music = null;        // { player, status, title, artist }
let musicAt = -99;
let musicBusy = false;
async function pollMusic() {
  if (musicBusy) return;
  musicBusy = true;
  try {
    const r = await fetch('/api/music', { headers: { 'X-Desk-Token': TOKEN } });
    if (r.ok) { music = await r.json(); if (!music.player) music = null; dirty = true; }
  } catch (err) {
    console.warn('music', err);
  } finally {
    musicBusy = false;
  }
}
async function musicCmd(cmd) {
  try {
    await fetch(`/api/music?cmd=${cmd}`, { method: 'POST', headers: { 'X-Desk-Token': TOKEN } });
  } catch (err) {
    console.warn('music', cmd, err);
  }
  setTimeout(pollMusic, 300);
}
function musicStep(s) {
  if (rooms.onDesk() && !panels.isOpen() && selected && selected.id === 'music' && s - musicAt >= 16) {
    musicAt = s;
    pollMusic();
  }
}

// ── Cuartos ─────────────────────────────────────────────────────────────────
const rooms = createRooms({
  desk: {
    id: 'desk',
    label: 'ESCRITORIO',
    hints: [['← →', 'MOVER'], ['ENTER', 'ABRIR'], ['1-9', 'DIRECTO', 'hint-direct'], ['ESPACIO , .', 'MÚSICA']],
  },
  modules: [board, monitor, calendar, rack],
  ctxBase: {
    C,
    theme: THEME,
    api: (path, init = {}) => fetch(path, { ...init, headers: { ...(init.headers || {}), 'X-Desk-Token': TOKEN } }),
  },
  onChange: () => { dirty = true; document.body.style.cursor = 'default'; },
});

// ── Paneles de los objetos (cajón, caballete…) ──────────────────────────────
const panels = createPanels({
  modules: [snippetsPanel, logPanel],
  ctxBase: {
    C,
    theme: THEME,
    api: (path, init = {}) => fetch(path, { ...init, headers: { ...(init.headers || {}), 'X-Desk-Token': TOKEN } }),
  },
});

// ── HUD ─────────────────────────────────────────────────────────────────────
const dateEl = document.getElementById('date');
const DAYS = ['DOM', 'LUN', 'MAR', 'MIE', 'JUE', 'VIE', 'SAB'];
const MONTHS = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
function updateDate(now) {
  const s = `${DAYS[now.getDay()]} ${pad(now.getDate())} ${MONTHS[now.getMonth()]} · ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  if (dateEl.textContent !== s) dateEl.textContent = s;
}

// ── Bucle: solo se redibuja cuando cambia un paso o hay entrada ─────────────
function frame(ts) {
  const s = Math.floor((ts / 1000) * FPS);
  if (s !== step) {
    step = s;
    const now = new Date();
    for (const t of tickers) if (t(step, now)) dirty = true;
    for (const it of items) if (it.tick) { it.tick(step); dirty = true; }
    if (selected && selected.slide) {
      const z = selected.baseZ + Math.min(selected.slide, (step - selStep + 1) * 5);
      if (z !== selected.group.position.z) { selected.group.position.z = z; dirty = true; }
    } else if (selected) {
      selected.group.position.y = selected.baseY + HOP[step % HOP.length];
      dirty = true;
    }
    updateDate(now);
    rooms.step(step, now);
    musicStep(step);
  }
  if (dirty && rooms.deskVisible()) {
    dirty = false;
    renderer.render(scene, camera);
    updateOverlay();
  }
  requestAnimationFrame(frame);
}

async function start() {
  try {
    const r = await fetch('/api/apps', { headers: { 'X-Desk-Token': TOKEN } });
    if (r.ok) for (const a of await r.json()) meta[a.id] = a;
  } catch (err) {
    console.warn('sin backend: las etiquetas usan el id', err);
  }
  resize();
  setSelected(order.find((i) => i.id === 'terminal') || order[0]);
  rooms.start((parseInt(params.get('room'), 10) || 1) - 1);
  requestAnimationFrame(frame);
}
start();
