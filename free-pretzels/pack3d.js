// 3D foil pack for the /free-pretzels pack game. ES module, loaded by
// packs.js only when the game is on, WebGL works and reduced motion is
// off. Uses the vendored three.js r160 (MIT, free-pretzels/vendor/).
//
// Our own pack, built in code (no third-party model): a pillowed gold
// foil pouch with crimped seals, a tear strip near the top (like a real
// trading card pack) and the logo in the middle. Textures are drawn on
// canvases at run time (no texture files).
//
// Brand: lit metallic shading is allowed on this pack only (plan v2,
// decision 2). The logo is an unlit plane, so its colours are exactly the
// artwork; it never rotates in-plane (the pack only turns on its vertical
// axis, at most 25 degrees in the carousel) and it is hidden while the
// pack spins in.
//
// Finishes: the 4 pretzel packs keep the original foil exactly (user:
// "it was perfect before"); the Golden Ticket pack is polished mirror
// gold with a green "Golden Ticket" band. The studio the foil reflects
// is never seen on screen; it only shapes the reflections.

import * as THREE from './vendor/three-0.160.0.module.min.js';

const W = 1;                 // pack width (world units)
const H = 1.6;               // pack height
const DEPTH = 0.075;         // pillow bulge
const CRIMP = 0.07;          // crimp seal height, fraction of H
const TEAR = 0.20;           // tear line, fraction of H from the top
const Y_TEAR = H / 2 - TEAR * H;
const LOGO_W = 0.62;         // fraction of W; centred; clear space >= 12.5% of logo width
const LOGO_ASPECT = 1725 / 1864;
const MAX_YAW = 25 * Math.PI / 180;

const C = { green: '#0D5237', gold: '#D4B662', deep: '#B2872F', light: '#F2E7A4', black: '#000000' };
const BAND_Y = -0.5;         // Golden Ticket band centre (between logo and crimp)
const BAND_H = W / 8;
// Roughness multipliers on the foil's roughness map (about 0.22).
const FINISH = {
  satin: { roughness: 1, clearcoat: 0.35 },   // the original foil
  golden: { roughness: 0.45, clearcoat: 1 },
};

export function webglOK() {
  try {
    const c = document.createElement('canvas');
    const gl = window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl'));
    const lose = gl && gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return !!gl;
  } catch (e) {
    return false;
  }
}

// ─── surface ────────────────────────────────────────────────────────
// Pillow height at (x, y). Zero at the side edges and across the crimps,
// so front and back meet cleanly.
function surfaceZ(x, y) {
  const u = Math.min(1, Math.abs(2 * x / W));
  const v = Math.min(1, Math.abs(2 * y / H));
  const vc = 1 - 2 * CRIMP;
  const ex = Math.pow(Math.max(0, 1 - Math.pow(u, 5)), 0.55);
  const ey = v >= vc ? 0 : Math.pow(Math.max(0, 1 - Math.pow(v / vc, 7)), 0.55);
  return DEPTH * ex * ey;
}

function halfGeometry(y0, y1, back) {
  const segY = Math.max(4, Math.round(56 * (y1 - y0) / H));
  const g = new THREE.PlaneGeometry(W, y1 - y0, 44, segY);
  g.translate(0, (y0 + y1) / 2, 0);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    uv.setXY(i, back ? 1 - (x + W / 2) / W : (x + W / 2) / W, (y + H / 2) / H);
    pos.setZ(i, (back ? -1 : 1) * surfaceZ(x, y));
  }
  if (back) {
    // Flip winding so the back faces -z.
    const idx = g.index.array;
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i]; idx[i] = idx[i + 2]; idx[i + 2] = t; }
  }
  g.computeVertexNormals();
  return g;
}

function bandGeometry() {
  const g = new THREE.PlaneGeometry(W * 0.98, BAND_H, 24, 4);
  g.translate(0, BAND_Y, 0);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setZ(i, surfaceZ(pos.getX(i), pos.getY(i)) + 0.004);
  g.computeVertexNormals();
  return g;
}

function bandCanvas() {
  const c = canvas(1024, 128);
  const x = c.getContext('2d');
  x.fillStyle = C.green; x.fillRect(0, 0, 1024, 128);
  x.fillStyle = C.light;
  x.font = '400 72px "FatFrank", "Archivo Black", "Arial Black", sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText('GOLDEN TICKET', 512, 68, 960);
  return c;
}

function logoGeometry() {
  const lw = LOGO_W * W, lh = lw * LOGO_ASPECT;
  const cy = -0.02 * H; // optical centre of the pack below the tear strip
  const g = new THREE.PlaneGeometry(lw, lh, 12, 12);
  g.translate(0, cy, 0);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setZ(i, surfaceZ(pos.getX(i), pos.getY(i)) + 0.004);
  g.computeVertexNormals();
  return g;
}

// ─── canvas textures ────────────────────────────────────────────────
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Foil crinkle: many soft, low bumps so the gold breaks up the light
// like real pack foil. Seeded so every pack looks the same.
function crinkle(ctx, w, h, seed) {
  let x = seed;
  const rnd = () => { x = (x * 16807) % 2147483647; return (x - 1) / 2147483646; };
  for (let i = 0; i < 260; i++) {
    const cx = rnd() * w, cy = rnd() * h, r = (0.02 + rnd() * 0.07) * w;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r); // height data, not visible colour
    const up = rnd() > 0.5;
    g.addColorStop(0, up ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)');
    g.addColorStop(1, 'rgba(128,128,128,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
  }
  // Long, faint vertical creases from the sealing machine.
  for (let i = 0; i < 18; i++) {
    const cx = rnd() * w, wd = (0.004 + rnd() * 0.01) * w;
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
    ctx.fillRect(cx, 0, wd, h);
  }
}

// Height map -> tangent-space normal map.
function normalsFrom(hc, strength) {
  const w = hc.width, h = hc.height;
  const src = hc.getContext('2d').getImageData(0, 0, w, h).data;
  const out = canvas(w, h);
  const octx = out.getContext('2d');
  const img = octx.createImageData(w, h);
  const d = img.data;
  const hgt = (x, y) => src[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (hgt(x + 1, y) - hgt(x - 1, y)) * strength;
      const dy = (hgt(x, y + 1) - hgt(x, y - 1)) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * w + x) * 4;
      d[i] = (-dx * inv * 0.5 + 0.5) * 255;
      d[i + 1] = (dy * inv * 0.5 + 0.5) * 255;
      d[i + 2] = (inv * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

function drawFace(w, front) {
  const h = Math.round(w * H / W);
  const art = canvas(w, h), hm = canvas(w, h), orm = canvas(w, h);
  const a = art.getContext('2d'), m = hm.getContext('2d'), o = orm.getContext('2d');
  const crimp = CRIMP * h;
  const ORM = (rough, metal) => `rgb(255,${Math.round(rough * 255)},${Math.round(metal * 255)})`;

  // Plain gold foil everywhere, with a soft crinkle.
  a.fillStyle = C.gold; a.fillRect(0, 0, w, h);
  m.fillStyle = '#808080'; m.fillRect(0, 0, w, h);
  o.fillStyle = ORM(0.22, 1); o.fillRect(0, 0, w, h);
  crinkle(m, w, h, front ? 7 : 11);

  // Crimped seals: vertical ridges, deeper gold.
  [[0, crimp], [h - crimp, h]].forEach(([y0, y1]) => {
    a.fillStyle = C.deep; a.fillRect(0, y0, w, y1 - y0);
    o.fillStyle = ORM(0.38, 1); o.fillRect(0, y0, w, y1 - y0);
    const period = w / 64;
    for (let x = 0; x < w; x += period) {
      const g = m.createLinearGradient(x, 0, x + period, 0); // height ramp (data)
      g.addColorStop(0, '#202020'); g.addColorStop(0.5, '#e0e0e0'); g.addColorStop(1, '#202020');
      m.fillStyle = g; m.fillRect(x, y0, period, y1 - y0);
    }
    m.fillStyle = '#101010'; m.fillRect(0, y0 === 0 ? y1 - 3 : y0, w, 3);
  });

  // Tear strip near the top: a raised gold-light band with perforation,
  // on both faces so the rip reads from either side.
  const ty = TEAR * h;
  a.fillStyle = C.light; a.fillRect(0, ty - h * 0.007, w, h * 0.014);
  o.fillStyle = ORM(0.15, 1); o.fillRect(0, ty - h * 0.007, w, h * 0.014);
  m.fillStyle = '#d0d0d0'; m.fillRect(0, ty - h * 0.007, w, h * 0.014);
  m.fillStyle = '#202020';
  for (let x = 0; x < w; x += w / 40) m.fillRect(x, ty - 2, w / 80, 4);
  return { art, normal: normalsFrom(hm, front ? 5 : 4), orm };
}

function tex(c, srgb) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ─── environment: black studio with gold-light softboxes ────────────
function studio(renderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x030303);
  const box = (w, h, x, y, z, color, k) => {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side: THREE.DoubleSide });
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    p.position.set(x, y, z);
    p.lookAt(0, 0, 0);
    scene.add(p);
  };
  box(7, 4, -3, 4, 4, 0xffffff, 6);      // key, top left
  box(2.5, 9, 6, 0, 1, C.light, 4);      // rim strip, right
  box(2.5, 9, -6, -1, 0, C.light, 2.4);  // fill, left
  box(9, 2.5, 0, -5, 3, C.gold, 1.6);    // floor bounce
  box(5, 3, 1, 0.5, 7, 0xfff6dc, 2.2);   // front soft, keeps the face bright gold
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(scene, 0.035).texture;
  pmrem.dispose();
  scene.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  return env;
}

// ─── assets ─────────────────────────────────────────────────────────
function loadImage(srcs) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let i = 0;
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => { i++; if (i < srcs.length) img.src = srcs[i]; else reject(new Error('logo')); };
    img.src = srcs[0];
  });
}

function timeout(p, ms) {
  return Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
}

// Shared geometry, textures and materials; builds packs and scenes.
export async function createKit({ assets }) {
  if (!webglOK()) throw new Error('no webgl');
  if (document.fonts && document.fonts.load) {
    await timeout(Promise.all([document.fonts.load('400 100px "FatFrank"'), document.fonts.load('400 100px "Archivo Black"')]), 1500);
  }
  const logoImg = await loadImage([assets + 'ppf-logo-1864.webp', assets + 'ppf-logo-600.png']);
  const res = Math.min(1024, Math.max(512, Math.round(Math.min(window.innerWidth, 600) * Math.min(window.devicePixelRatio || 1, 2))));
  const f = drawFace(res, true);
  const b = drawFace(Math.round(res / 2), false);
  const geo = {
    topF: halfGeometry(Y_TEAR, H / 2, false), topB: halfGeometry(Y_TEAR, H / 2, true),
    botF: halfGeometry(-H / 2, Y_TEAR, false), botB: halfGeometry(-H / 2, Y_TEAR, true),
    logo: logoGeometry(), tear: new THREE.PlaneGeometry(W * 1.04, 0.016), band: bandGeometry(),
  };
  const maps = {
    front: { map: tex(f.art, true), normalMap: tex(f.normal), roughnessMap: tex(f.orm), metalnessMap: tex(f.orm) },
    back: { map: tex(b.art, true), normalMap: tex(b.normal), roughnessMap: tex(b.orm), metalnessMap: tex(b.orm) },
    logo: tex(logoImg, true),
    band: tex(bandCanvas(), true),
  };

  function foil(face) {
    return new THREE.MeshPhysicalMaterial({
      color: 0xffffff, metalness: 1, roughness: 1, ...maps[face],
      normalScale: new THREE.Vector2(0.9, 0.9),
      clearcoat: 0.35, clearcoatRoughness: 0.25, envMapIntensity: 1.15,
    });
  }

  function makePack() {
    const mats = { front: foil('front'), back: foil('back') };
    mats.logo = new THREE.MeshBasicMaterial({ map: maps.logo, transparent: true, toneMapped: false });
    mats.tear = new THREE.MeshBasicMaterial({ color: new THREE.Color(C.light), transparent: true, opacity: 0, toneMapped: false });
    const group = new THREE.Group();
    const top = new THREE.Group(), bot = new THREE.Group();
    top.add(new THREE.Mesh(geo.topF, mats.front), new THREE.Mesh(geo.topB, mats.back));
    bot.add(new THREE.Mesh(geo.botF, mats.front), new THREE.Mesh(geo.botB, mats.back));
    const logo = new THREE.Mesh(geo.logo, mats.logo);
    logo.renderOrder = 2;
    bot.add(logo);
    mats.band = new THREE.MeshBasicMaterial({ map: maps.band, transparent: true, toneMapped: false });
    const band = new THREE.Mesh(geo.band, mats.band);
    band.renderOrder = 2;
    band.visible = false;
    bot.add(band);
    const tear = new THREE.Mesh(geo.tear, mats.tear);
    tear.position.set(0, Y_TEAR, surfaceZ(0, Y_TEAR) + 0.006);
    tear.renderOrder = 3;
    group.add(top, bot, tear);
    const pack = { group, top, bot, logo, band, tear, mats };
    setFinish(pack, 'satin');
    return pack;
  }

  function makeRenderer(cv) {
    const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true, powerPreference: 'high-performance' });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.setClearColor(0x000000, 0);
    return r;
  }

  return {
    carousel: (cv, track, slots) => new Carousel(makeRenderer(cv), makePack, cv, track, slots),
    stage: (cv, anchor) => new StagePack(makeRenderer(cv), makePack, cv, anchor),
  };
}

// ─── shared scene plumbing ──────────────────────────────────────────
class Base {
  constructor(renderer, cv) {
    this.r = renderer;
    this.cv = cv;
    this.scene = new THREE.Scene();
    this.scene.environment = studio(renderer);
    this.cam = new THREE.PerspectiveCamera(26, 1, 0.1, 50);
    this.cam.position.set(0, 0, 6);
    this.key = new THREE.DirectionalLight(0xfff3d6, 1.4);
    this.key.position.set(-2, 3, 4);
    this.scene.add(this.key);
    this.raf = 0;
    this.tweens = [];
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.slow = 0;
    this.visible = true;
    this.paused = false;
    this.lost = false;
    this.onLost = null;
    this.frame = this.frame.bind(this);
    // The browser can drop a WebGL context (memory pressure, GPU reset).
    // Stop drawing and let packs.js fall back to the CSS packs.
    cv.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.stop();
      if (this.onLost) this.onLost();
    });
  }
  pause() { this.paused = true; this.stop(); }
  resume() { this.paused = false; this.kick(); }
  size() {
    const w = this.cv.clientWidth, h = this.cv.clientHeight;
    if (!w || !h) return false;
    this.r.setPixelRatio(this.dpr);
    this.r.setSize(w, h, false);
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
    this.w = w; this.h = h;
    // World units per CSS pixel on the z = 0 plane.
    this.wpp = (2 * this.cam.position.z * Math.tan(THREE.MathUtils.degToRad(this.cam.fov / 2))) / h;
    return true;
  }
  tween(dur, apply, ease, delay) {
    return new Promise((done) => {
      this.tweens.push({ t0: performance.now() + (delay || 0), dur, apply, ease: ease || easeOut, done });
      this.kick();
    });
  }
  kick() { if (!this.raf && this.visible && !this.paused && !this.lost) { this.last = 0; this.raf = requestAnimationFrame(this.frame); } }
  frame(t) {
    this.raf = 0;
    if (this.last) {
      const dt = t - this.last;
      this.slow = this.slow * 0.9 + (dt > 30 ? 1 : 0) * 0.1;
      if (this.slow > 0.6 && this.dpr > 1) { this.dpr = 1; this.size(); } // low frame rate: drop resolution
    }
    this.last = t;
    let active = false;
    this.tweens = this.tweens.filter((tw) => {
      const k = (t - tw.t0) / tw.dur;
      if (k < 0) { active = true; return true; }
      tw.apply(tw.ease(Math.min(1, k)));
      if (k >= 1) { tw.done(); return false; }
      active = true;
      return true;
    });
    const more = this.update(t) || active;
    this.r.render(this.scene, this.cam);
    if (more && this.visible && !this.paused) this.raf = requestAnimationFrame(this.frame);
  }
  update() { return false; }
  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.tweens.forEach((tw) => tw.done());
    this.tweens = [];
  }
  disposeScene() {
    if (this.scene.environment) this.scene.environment.dispose();
    this.r.dispose();
  }
}

// Satin gold (pretzel packs) or polished mirror gold with the green band
// (Golden Ticket pack).
function setFinish(p, finish) {
  const f = FINISH[finish] || FINISH.satin;
  [p.mats.front, p.mats.back].forEach((m) => { m.roughness = f.roughness; m.clearcoat = f.clearcoat; });
  p.band.visible = finish === 'golden';
  p.finish = finish;
}

function easeOut(k) { return 1 - Math.pow(1 - k, 3); }
function easeIn(k) { return k * k * k; }
function easeInOut(k) { return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; }
function easeBack(k) { const c = 1.7; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// ─── carousel ───────────────────────────────────────────────────────
// The DOM track (native scroll-snap, real buttons) handles swiping, taps
// and keyboard; this renders one 3D pack per slot at the slot's position.
class Carousel extends Base {
  constructor(renderer, makePack, cv, track, slots) {
    super(renderer, cv);
    this.track = track;
    this.slots = slots;
    this.packs = slots.map(() => {
      const p = makePack();
      p.mats.tear.opacity = 0;
      this.scene.add(p.group);
      return p;
    });
    this.chosen = -1;
    this.single = -1;
    this.sway = 0;
    this.pointer = { x: 0 };
    this.inView = true;
    this.lastActive = performance.now();
    // Render only while something moves: scrolling, a pointer, tweens, or
    // a short idle sway after the last interaction. Then the loop stops.
    this.poke = () => { this.lastActive = performance.now(); this.kick(); };
    this.onScroll = this.poke;
    this.onResize = () => { this.size(); this.poke(); };
    track.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('resize', this.onResize);
    this.onMove = (e) => {
      const r = cv.getBoundingClientRect();
      this.pointer.x = clamp((e.clientX - r.left) / r.width * 2 - 1, -1, 1);
      this.poke();
    };
    track.addEventListener('pointermove', this.onMove, { passive: true });
    this.io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => {
      this.inView = es[0].isIntersecting;
      this.visible = this.inView && !document.hidden;
      if (this.visible) this.poke();
    }) : null;
    if (this.io) this.io.observe(cv);
    this.onVis = () => { this.visible = this.inView && !document.hidden; if (this.visible) this.poke(); };
    document.addEventListener('visibilitychange', this.onVis);
    this.size();
    this.kick();
  }
  update(t) {
    if (!this.w) this.size();
    const box = this.cv.getBoundingClientRect();
    const mid = box.left + box.width / 2;
    let moving = false;
    // Gentle sway on the centred pack so the foil catches light, for a
    // few seconds after the last interaction only (battery).
    const idleFor = performance.now() - this.lastActive;
    const swaying = idleFor < 4000;
    this.sway = Math.sin(t / 1400) * 0.09 * (swaying ? Math.min(1, (4000 - idleFor) / 800) : 0);
    this.packs.forEach((p, i) => {
      const s = this.slots[i];
      const pk = s.querySelector('.pk') || s;
      const r = pk.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const d = (cx - mid) / Math.max(1, r.width * 1.15);
      const base = (r.height * this.wpp) / H;
      const g = p.group;
      if (this.chosen >= 0) return; // choose() animates
      const ad = Math.min(Math.abs(d), 1.6);
      g.position.set((cx - mid) * this.wpp, ((box.top + box.height / 2) - (r.top + r.height / 2)) * this.wpp, -ad * 0.35);
      g.scale.setScalar(base * (1 - 0.12 * Math.min(ad, 1)));
      const yaw = clamp(-d * 0.6, -MAX_YAW, MAX_YAW) + (ad < 0.5 ? this.sway + this.pointer.x * 0.12 : 0);
      g.rotation.set(0, clamp(yaw, -MAX_YAW, MAX_YAW), 0); // yaw only: the logo never tilts in-plane
      p.mats.front.envMapIntensity = p.mats.back.envMapIntensity = 1.15 - 0.5 * Math.min(ad, 1);
      if (Math.abs(d - (p.lastD || 0)) > 0.001) moving = true;
      p.lastD = d;
    });
    return moving || swaying;
  }
  // Chosen pack rises and grows, the others drop away.
  choose(i, ms) {
    this.chosen = i;
    const jobs = this.packs.map((p, n) => {
      const g = p.group, y0 = g.position.y, s0 = g.scale.x, x0 = g.position.x, r0 = g.rotation.y;
      if (n === i) return this.tween(ms, (k) => { g.position.x = x0 * (1 - k); g.rotation.y = r0 * (1 - k); g.scale.setScalar(s0 * (1 + 0.12 * k)); }, easeOut);
      return this.tween(ms, (k) => { g.position.y = y0 - k * 3; g.scale.setScalar(s0 * (1 - 0.3 * k)); }, easeIn);
    });
    return Promise.all(jobs);
  }
  reset() { this.chosen = -1; this.packs.forEach((p) => { p.lastD = null; }); this.paused = false; this.poke(); }
  // i < 0 shows all five (the only mode used now); golden gives the
  // shown packs the Golden Ticket finish.
  setSingle(i, golden) {
    this.single = i;
    this.packs.forEach((p, n) => {
      p.group.visible = i < 0 || n === i;
      setFinish(p, golden && (i < 0 || n === i) ? 'golden' : 'satin');
    });
    this.poke();
  }

  dispose() {
    this.stop();
    this.track.removeEventListener('scroll', this.onScroll);
    this.track.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVis);
    if (this.io) this.io.disconnect();
    this.disposeScene();
  }
}

// ─── stage pack (beats 1 to 3) ──────────────────────────────────────
// Positioned over the stage's .st-pack box so the DOM swipe target and
// the 3D pack line up exactly.
class StagePack extends Base {
  constructor(renderer, makePack, cv, anchor) {
    super(renderer, cv);
    this.anchor = anchor;
    this.p = makePack();
    this.scene.add(this.p.group);
    this.onResize = () => { this.size(); this.place(); this.kick(); };
    window.addEventListener('resize', this.onResize);
  }
  place() {
    const a = this.anchor();
    if (!a || !this.w) return;
    const box = this.cv.getBoundingClientRect();
    const g = this.p.group;
    g.scale.setScalar((a.height * this.wpp) / H);
    g.position.set(
      ((a.left + a.width / 2) - (box.left + box.width / 2)) * this.wpp,
      ((box.top + box.height / 2) - (a.top + a.height / 2)) * this.wpp, 0);
    this.home = g.position.clone();
  }
  reset(finish) {
    this.stop();
    this.size();
    this.place();
    const p = this.p;
    setFinish(p, finish || 'satin');
    p.top.position.set(0, 0, 0); p.top.rotation.set(0, 0, 0);
    p.bot.position.set(0, 0, 0);
    p.group.rotation.set(0, Math.PI / 2, 0);
    p.mats.logo.opacity = 0;
    p.mats.tear.opacity = 0;
    p.tear.scale.set(0.001, 1, 1);
    p.tear.position.x = -W / 2 * 1.04;
    this.cv.style.visibility = 'visible';
    this.kick();
  }
  // Beat 1: from edge-on to face-front; the key light sweeps for one glint.
  spinIn(ms) {
    const g = this.p.group;
    return this.tween(ms, (k) => {
      g.rotation.y = (Math.PI / 2) * (1 - k);
      this.key.position.set(-4 + 8 * k, 3, 4);
    }, (k) => 1 - Math.pow(1 - k, 2.4));
  }
  showLogo(ms) { return this.tween(ms, (k) => { this.p.mats.logo.opacity = k; }, (k) => k); }
  breathe(ms) {
    const g = this.p.group, s = g.scale.x;
    return this.tween(ms, (k) => g.scale.setScalar(s * (1 + 0.025 * Math.sin(k * Math.PI))), (k) => k);
  }
  drawTear(ms) {
    const t = this.p.tear, m = this.p.mats.tear;
    m.color.set(C.gold);
    return this.tween(ms, (k) => {
      m.opacity = 1;
      t.scale.x = Math.max(0.001, k);
      t.position.x = -W * 0.52 * (1 - k);
    }, easeInOut);
  }
  brighten(ms) {
    const t = this.p.tear, m = this.p.mats.tear;
    const a = new THREE.Color(C.gold), b = new THREE.Color(C.light);
    return this.tween(ms, (k) => { m.color.copy(a).lerp(b, k); t.scale.y = 1 + 0.6 * k; }, easeOut);
  }
  // Beat 3: top flies up and away, bottom (with the logo) drops straight
  // down with no rotation.
  rip(ms) {
    const p = this.p;
    const up = (this.h * 1.2) * this.wpp / p.group.scale.x;
    return this.tween(ms, (k) => {
      p.top.position.y = up * k;
      p.top.rotation.z = (-14 * Math.PI / 180) * k;
      p.bot.position.y = -up * k;
      p.mats.tear.opacity = 1 - Math.min(1, k * 4);
    }, easeIn).then(() => this.hide());
  }
  hide() { this.stop(); this.cv.style.visibility = 'hidden'; }
  dispose() { this.stop(); window.removeEventListener('resize', this.onResize); this.disposeScene(); }
}
