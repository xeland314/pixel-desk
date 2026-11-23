// La mascota: un gato de cajas con poses y rutinas aleatorias.
//
// El gato es un esqueleto sencillo (torso con patas y cola, cabeza con orejas
// y ojos) que se mueve entre poses planas de números. Cada rutina es una lista
// de tramos: interpolar hasta una pose en n pasos y, si hace falta, quedarse
// ahí un rato. Todo va a pasos (8 fps), así que las transiciones salen a
// saltos, como el resto de la escena.
//
// Rutinas:
//   sentado   parpadea y mueve la cola (reposo)
//   siesta    se levanta, da media vuelta a pasitos, se acuesta y duerme
//             8 minutos; de noche (22–7 h) duerme hasta la mañana y, de
//             tanto en tanto, alza una oreja y abre un ojo. Al despertar se
//             estira (delante y detrás) y vuelve a sentarse.
//   panza     se tumba, se pone panza arriba moviendo las patitas y vuelve.
//
// Depuración: ?cat=nap|belly|night (rutina inmediata; night simula la noche)
// o ?cat=pose:<nombre> para congelar una pose (sit, stand, curl, belly, bow…).
import * as THREE from './vendor/three.module.js';

const TAU = Math.PI * 2;
const NAP_MS = 8 * 60 * 1000;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (p) => Math.random() < p;

// ── Poses ───────────────────────────────────────────────────────────────────
// Todo en el marco del gato (origen en el suelo, bajo el centro del cuerpo;
// mira hacia +z). Cuerpo: bw×bh×bd con base en by y centro en bz. Patas: largo
// legF/legB y giros por pata. Cola: pivote (tpx,tpy,tpz), giros try/trz, largo
// del tramo bajo tbl y giro de la punta tix/tiz. Ojos y orejas: 0 cerrado/caída,
// 1 abierto/alzada. sit=1 muestra las patas delanteras de estar sentado.
const SIT = {
  rotY: 0, ox: 0, oz: 0,
  bw: 16, bh: 10, bd: 12, by: 0, bz: -1,
  ty: 0, tz: 0, trx: 0,
  hx: 0, hy: 10, hz: 0, hrx: 0, hry: 0, hrz: 0,
  legF: 0, legB: 0, flx: 0, frx: 0, blx: 0, brx: 0, flz: 0, frz: 0, blz: 0, brz: 0,
  sit: 1,
  tpx: 8, tpy: 0, tpz: -4, try: 0, trz: 0, tbl: 10, tix: 0, tiz: 0,
  eyeL: 1, eyeR: 1, earL: 1, earR: 1,
};
const STAND = {
  ...SIT,
  bw: 11, bh: 9, bd: 20, by: 5, bz: -1,
  hy: 9, hz: 9,
  legF: 5, legB: 5, sit: 0,
  tpx: 0, tpy: 11, tpz: -10, try: Math.PI / 2, trz: 0.9, tbl: 6, tix: 0, tiz: 0,
};
// La media vuelta antes de acostarse: camina en arco (izquierda, hacia el
// fondo y a la derecha) y termina mirando a la derecha, ARC_R más atrás.
const ARC_R = 3;
const arcAt = (a) => ({ ...STAND, rotY: a, ox: ARC_R * Math.cos(a), oz: -ARC_R * Math.sin(a) - ARC_R });
// De perfil, mirando al tocadiscos, pero con la cara vuelta hacia quien mira.
const RIGHT = { ...STAND, rotY: Math.PI / 2, hry: -Math.PI / 2, ox: -3, oz: -2 * ARC_R };
const CURL = {
  ...SIT,
  bw: 26, bh: 7, bd: 15, by: 0, bz: -2,
  hx: -5, hy: -1, hz: 4, hrx: 0, hrz: 0.08,
  sit: 0,
  // la cola rodea el cuerpo y tapa la barbilla
  tpx: 13, tpy: 0, tpz: -7, try: -Math.PI / 2, trz: 0, tbl: 19, tix: Math.PI / 2, tiz: 0,
  eyeL: 0, eyeR: 0, earL: 0.3, earR: 0.3,
};
// Enroscado tal como queda tras la media vuelta: el cuerpo de lado y la cara
// girada hacia quien mira.
const CURL_R = {
  ...CURL, bw: 16, bd: 20, rotY: Math.PI / 2, hry: -Math.PI / 2, hx: -6, hz: 4, oz: -2 * ARC_R,
  // la cola pasa por delante, a ras del suelo, de izquierda a derecha
  tpx: -8, tpy: 0, tpz: -10, try: -Math.PI / 2, trz: 0, tbl: 6, tix: 0, tiz: -Math.PI / 2,
};
const LOAF = { ...CURL, bw: 22, hx: 0, hy: 1, hz: 4, hrx: 0, hrz: 0, eyeL: 1, eyeR: 1, earL: 1, earR: 1,
  tpx: 10, tpy: 0, tpz: -4, try: 0, trz: 0, tbl: 8, tix: 0, tiz: -0.5 };
const BELLY = {
  ...STAND,
  bw: 12, bh: 9, bd: 18, by: 0, bz: 0,
  ty: 9, tz: 4, trx: -Math.PI / 2,
  hy: 13, hz: -1, hrz: 0.28,
  legF: 4, legB: 4, flx: -0.8, frx: -0.8, flz: -0.5, frz: 0.5, blx: 0.5, brx: 0.5, blz: -0.7, brz: 0.7,
  tpx: 5, tpy: 4, tpz: -9, try: 0, trz: 0, tbl: 8, tix: Math.PI / 2, tiz: 0,
};
const BOW = {
  ...RIGHT,
  trx: 0.3, legF: 6, legB: 8, flx: -1.0, frx: -1.0,
  hy: 4, hz: 12, hrx: -0.2,
  trz: 1.3, eyeL: 0.2, eyeR: 0.2,
};
const BACK = {
  ...RIGHT,
  trx: -0.12, legB: 7, blx: 0.9, brx: 0.9,
  hy: 10, hz: 10, hrx: -0.15,
};
const POSES = { sit: SIT, stand: STAND, right: RIGHT, curl: CURL, curlr: CURL_R, loaf: LOAF, belly: BELLY, bow: BOW, back: BACK };

const lerp = (a, b, t) => {
  const o = {};
  for (const k in b) o[k] = a[k] + (b[k] - a[k]) * t;
  return o;
};

/** Construye el gato dentro de `parent` y devuelve tick(step). */
export function buildCat(parent, C) {
  const q = new URLSearchParams(location.search).get('cat') || '';
  const isNight = q === 'night'
    ? () => true
    : () => { const h = new Date().getHours(); return h >= 22 || h < 7; };

  const mat = (color) => new THREE.MeshLambertMaterial({ color });
  const ubox = (p, color) => { const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat(color)); p.add(m); return m; };
  /** Caja unidad escalada: w,h,d con centro x,z y base y. */
  const put = (m, w, h, d, x, y, z) => {
    m.visible = w > 0.3 && h > 0.3 && d > 0.3;
    m.scale.set(Math.max(w, 0.01), Math.max(h, 0.01), Math.max(d, 0.01));
    m.position.set(x, y + h / 2, z);
  };
  /** Caja fija (no cambia de tamaño), apoyada en y. */
  const fixed = (p, w, h, d, color, x, y, z) => { const m = ubox(p, color); put(m, w, h, d, x, y, z); return m; };

  const root = new THREE.Group();
  root.position.set(2, 0.6, 0);
  parent.add(root);

  // Torso: cuerpo, parches, patas y cola.
  const torso = new THREE.Group();
  root.add(torso);
  const body = ubox(torso, C.orange);
  const chest = ubox(torso, C.cream);
  const belly = ubox(torso, C.cream);
  const stripes = [0, 1, 2, 3].map(() => ubox(torso, C.rust));
  const back = [0, 1, 2].map(() => ubox(torso, C.rust));   // rayas del lomo
  const legs = ['fl', 'fr', 'bl', 'br'].map((id) => {
    const g = new THREE.Group();
    torso.add(g);
    return { id, g, leg: ubox(g, C.orange), toe: ubox(g, C.cream) };
  });
  const tail = new THREE.Group();
  torso.add(tail);
  const tailBase = ubox(tail, C.orange);
  const tip = new THREE.Group();
  tail.add(tip);
  fixed(tip, 4, 9, 4, C.orange, 0, 0, 0);
  fixed(tip, 4, 2, 4.4, C.rust, 0, 4, 0);
  fixed(tip, 4, 4, 4, C.rust, 0, 9, 0);

  // Cabeza grande, estilo mascota (igual que el sprite original).
  const head = new THREE.Group();
  root.add(head);
  fixed(head, 22, 16, 14, C.orange, 0, 0, 0);
  const ears = [-8, 8].map((x) => {
    const e = new THREE.Group();
    e.position.set(x, 16, 0);
    fixed(e, 6, 5, 4, C.orange, 0, 0, 0);
    fixed(e, 4, 3, 1, C.sand, 0, 0, 2.1);
    head.add(e);
    return { e, side: Math.sign(x) };
  });
  for (const x of [-4, 0, 4]) {
    fixed(head, 2, 3, 1, C.rust, x, 13, 7.1);         // rayas de la frente
    fixed(head, 2, 0.6, 9, C.rust, x, 16, 1);         // y su continuación arriba
  }
  for (const x of [-10.5, 10.5]) fixed(head, 1, 2, 1, C.rust, x, 5, 7.1);   // mejillas
  for (const z of [-3, 1]) fixed(head, 0.6, 3, 2, C.rust, 11.1, 9, z);
  for (const z of [-3, 1]) fixed(head, 0.6, 3, 2, C.rust, -11.1, 9, z);
  fixed(head, 10, 6, 1, C.cream, 0, 0, 7.1);          // hocico
  fixed(head, 2, 2, 1, C.rust, 0, 4.4, 7.7);          // nariz
  const eyes = [-6, 6].map((x) => {
    const eye = new THREE.Group();
    eye.position.set(x, 8, 7.1);
    fixed(eye, 3, 4, 1, C.brown, 0, -2, 0);
    const shine = fixed(eye, 1, 1, 0.6, C.cream, -1, 1, 0.4);
    head.add(eye);
    return { eye, shine };
  });

  // Patas de estar sentado: las dos delante del pecho, simétricas.
  const sitPaws = new THREE.Group();
  root.add(sitPaws);
  for (const x of [-5, 5]) {
    fixed(sitPaws, 6, 5, 6, C.orange, x, 0, 6);
    fixed(sitPaws, 6, 1, 1, C.cream, x, 0, 9.4);
  }

  // «Z» de dormir: dos planos con una letra de 5×5 que suben a pasos.
  const zc = document.createElement('canvas');
  zc.width = zc.height = 5;
  const zg = zc.getContext('2d');
  zg.fillStyle = C.cream;
  for (const [x, y] of [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [3, 1], [2, 2], [1, 3], [0, 4], [1, 4], [2, 4], [3, 4], [4, 4]]) zg.fillRect(x, y, 1, 1);
  const zt = new THREE.CanvasTexture(zc);
  zt.magFilter = zt.minFilter = THREE.NearestFilter;
  zt.generateMipmaps = false;
  zt.colorSpace = THREE.SRGBColorSpace;
  const zs = [5, 4].map((s) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshBasicMaterial({ map: zt, transparent: true, alphaTest: 0.5 }));
    m.visible = false;
    parent.add(m);
    return m;
  });

  // ── Aplicar una pose (más los detalles del momento) ──
  function apply(P, fx) {
    root.position.set(2 + P.ox, 0.6 + fx.bob, P.oz);
    root.rotation.y = P.rotY;
    torso.position.set(0, P.ty, P.tz);
    torso.rotation.x = P.trx;

    const bh = P.bh + fx.breath;
    put(body, P.bw, bh, P.bd, 0, P.by, P.bz);
    put(chest, P.bw * 0.5, bh * 0.7, 1, 0, P.by + bh * 0.1, P.bz + P.bd / 2);
    put(belly, P.bw * 0.6, 0.6, P.bd * 0.6, 0, P.by - 0.4, P.bz);
    stripes.forEach((s, i) => {
      const side = i < 2 ? 1 : -1;
      const z = P.bz + P.bd * (i % 2 ? 0.04 : -0.29);
      put(s, 0.6, bh * 0.7, 2, side * (P.bw / 2 + 0.05), P.by + bh * 0.2, z);
    });
    back.forEach((s, i) => put(s, P.bw * 0.7, 0.6, 2, 0, P.by + bh, P.bz + P.bd * (-0.3 + i * 0.22)));

    const rot = { fl: [P.flx, P.flz], fr: [P.frx, P.frz], bl: [P.blx, P.blz], br: [P.brx, P.brz] };
    for (const l of legs) {
      const front = l.id[0] === 'f';
      const left = l.id[1] === 'l';
      const L = front ? P.legF : P.legB;
      l.g.position.set((left ? -1 : 1) * (P.bw / 2 - 2.5), P.by, P.bz + (front ? 1 : -1) * (P.bd / 2 - 3));
      const [rx, rz] = rot[l.id];
      l.g.rotation.set(rx + (fx.gait[l.id] || 0), 0, rz);
      put(l.leg, 4, L, 4, 0, -L, 0);
      put(l.toe, 4, L > 0.5 ? 1 : 0, 1, 0, -L, 2.1);
    }

    tail.position.set(P.tpx, P.tpy, P.tpz);
    tail.rotation.set(0, P.try, P.trz);
    put(tailBase, P.tbl, 4, 4, P.tbl / 2, 0, 0);
    tip.position.set(P.tbl, 2.4, 0);
    tip.rotation.set(P.tix, 0, P.tiz + fx.wag);

    head.position.set(P.hx, P.hy, P.hz);
    head.rotation.set(P.hrx, P.hry, P.hrz);
    ears.forEach(({ e, side }, i) => {
      const v = Math.min(1, Math.max(0, (i ? P.earR : P.earL) + fx.ear[i]));
      e.scale.y = 0.55 + 0.45 * v;
      e.rotation.z = -side * (1 - v) * 0.5;
    });
    eyes.forEach(({ eye, shine }, i) => {
      const v = Math.min(1, Math.max(0, (i ? P.eyeR : P.eyeL) + fx.eye[i]));
      eye.scale.y = Math.max(0.15, v);
      shine.visible = v > 0.5;
    });

    sitPaws.visible = P.sit >= 0.5;

    zs.forEach((z, i) => {
      z.visible = fx.z >= 0;
      if (fx.z < 0) return;
      const t = (fx.z + i * 12) % 24;
      z.position.set(2 + P.hx + 10 + i * 5 + (t >> 3), 0.6 + P.hy + 19 + (t >> 1), 8);
    });
  }

  // ── Rutinas ──
  // Un tramo: { to: pose, n: pasos de transición, mode, hold?: pasos,
  //             until?: (msDesdeQueLlegó) => bool }
  const night = isNight;
  function idle() {
    const wait = night() ? rnd(20, 60) : rnd(90, 240);
    return [{ to: SIT, n: 1, mode: 'sit', until: (ms) => ms >= wait * 1000 }];
  }
  function nap() {
    // Media vuelta a pasitos: 8 tramos cortos por el arco.
    const arc = [];
    for (let i = 1; i <= 8; i++) arc.push({ to: arcAt(-Math.PI / 2 - (i * Math.PI) / 8), n: 3, mode: 'walk' });
    const lie = { ...CURL_R, rotY: -1.5 * Math.PI };   // mismo giro con que acaba el arco
    return [
      { to: arcAt(-Math.PI / 2), n: 6, mode: 'stand' },                    // se levanta de perfil
      ...arc,                                                              // media vuelta
      { to: lie, n: 8, mode: 'lie' },                                      // y se acuesta
      { to: lie, n: 1, mode: 'sleep', until: (ms) => ms >= NAP_MS && !night() }, // toda la noche si toca
      { to: RIGHT, n: 8, mode: 'stand' },                                  // se levanta
      { to: BOW, n: 6, mode: 'stretch', hold: 14 },                        // estira delante
      { to: BACK, n: 6, mode: 'stretch', hold: 10 },                       // y detrás
      { to: RIGHT, n: 5, mode: 'stand' },
      { to: { ...STAND, oz: -2 * ARC_R }, n: 6, mode: 'walk' },            // se gira al frente
      { to: STAND, n: 8, mode: 'walk' },                                   // pasitos de vuelta
      { to: SIT, n: 6, mode: 'stand' },                                    // y a su sitio
    ];
  }
  function bellyUp() {
    return [
      { to: LOAF, n: 6, mode: 'lie' },
      { to: BELLY, n: 8, mode: 'belly', hold: Math.round(rnd(60, 120)) },
      { to: LOAF, n: 8, mode: 'lie' },
      { to: SIT, n: 6, mode: 'stand' },
    ];
  }
  function nextRoutine() {
    if (night() || pick(0.45)) return nap();
    return bellyUp();
  }

  let cur = { ...SIT };
  let from = cur;
  let queue = [];
  let seg = null;
  let k = 0;           // pasos dentro del tramo
  let arrived = 0;     // Date.now() al terminar la transición
  let frozen = null;

  function next() {
    // Normaliza el giro para no dar vueltas de más en la siguiente transición.
    cur.rotY = Math.atan2(Math.sin(cur.rotY), Math.cos(cur.rotY));
    if (!queue.length) queue = seg && seg.mode === 'sit' ? nextRoutine() : idle();
    seg = queue.shift();
    from = { ...cur };
    k = 0;
    arrived = 0;
  }

  if (q.startsWith('pose:') && POSES[q.slice(5)]) frozen = POSES[q.slice(5)];
  else if (q === 'nap' || q === 'night') queue = nap();
  else if (q === 'belly') queue = bellyUp();
  next();

  // Detalles que van encima de la pose: parpadeo, oreja y ojo al dormir,
  // respiración, la cola, las patitas…
  let blinkAt = 0;
  let peekAt = 0;
  let peekK = -1;
  const WAG = [0, -0.16, -0.32, -0.16, 0, 0.12, 0.24, 0.12];

  return (step) => {
    const now = Date.now();
    const fx = { bob: 0, breath: 0, wag: 0, ear: [0, 0], eye: [0, 0], gait: {}, z: -1 };
    if (frozen) { apply(frozen, fx); return; }

    k++;
    if (k <= seg.n) cur = lerp(from, seg.to, k / seg.n);
    else {
      if (!arrived) arrived = now;
      const doneHold = seg.hold == null || k - seg.n >= seg.hold;
      const doneUntil = !seg.until || seg.until(now - arrived);
      if (doneHold && doneUntil) next();
    }

    const mode = seg.mode;
    const awake = mode !== 'sleep' && mode !== 'lie';
    if (awake) {
      if (!blinkAt) blinkAt = now + rnd(3000, 7000);
      if (now >= blinkAt) { fx.eye = [-1, -1]; blinkAt = now + rnd(3000, 7000); }
    }
    if (mode === 'sit') {
      fx.wag = WAG[(step >> 1) % WAG.length];
    } else if (mode === 'walk') {
      const s = step % 2 ? 0.22 : -0.22;            // pasitos cortos
      fx.gait = { fl: s, br: s, fr: -s, bl: -s };
      fx.bob = step % 2 ? 0.4 : 0;
      fx.wag = WAG[step % WAG.length] * 0.5;
    } else if (mode === 'stand' || mode === 'stretch') {
      fx.wag = WAG[(step >> 2) % WAG.length] * 0.5;
    } else if (mode === 'belly') {
      const s = (step >> 2) % 2 ? 0.25 : -0.25;     // patitas al aire
      fx.gait = { fl: s, fr: -s };
      fx.wag = WAG[(step >> 1) % WAG.length];
    } else if (mode === 'sleep') {
      fx.breath = (step >> 4) % 2 ? 0.6 : 0;         // respira despacio
      fx.z = step % 24;
      // De noche, de tanto en tanto: alza una oreja, abre un ojo y vuelve a dormir.
      if (night()) {
        if (!peekAt) peekAt = now + rnd(40000, 120000);
        if (peekK < 0 && now >= peekAt) peekK = 0;
        if (peekK >= 0) {
          const t = peekK++;
          fx.ear[1] = t < 30 ? 0.7 : 0;
          fx.eye[1] = t >= 8 && t < 24 ? 0.8 : 0;
          if (t >= 8 && t < 24) fx.z = -1;
          if (peekK >= 32) { peekK = -1; peekAt = now + rnd(40000, 120000); }
        }
      }
    }
    apply(cur, fx);
  };
}
