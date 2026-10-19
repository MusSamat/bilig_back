#!/usr/bin/env node
/**
 * respiratory.glb: the human respiratory system, authored here from three.js
 * geometry and implicit (signed-distance) shapes, our own work (CC0). Built in
 * metres around the carina and scaled ×7 (≈ 3.8 scene units tall).
 *
 *   node respiratory.mjs <out.glb> [report.json]
 *
 * Node names are a contract with the content:
 *   Nose (external nose + nasal cavity with conchae), Larynx (thyroid and
 *   cricoid cartilages, epiglottis), Trachea (with C-shaped cartilage rings),
 *   Bronchi_L / Bronchi_R (main and lobar bronchi), Bronchioles_L /
 *   Bronchioles_R (branching tree filling each lobe), Lung_L (2 lobes) and
 *   Lung_R (3 lobes) semi-translucent so the tree shows, Alveoli_1…Alveoli_9
 *   (a magnified alveolar cluster with its capillary net, beside the right
 *   lung, one alveolus cut open), Diaphragm (two cupolae, central tendon,
 *   crura), Ribs (a light, partial cage open at the front, with the thoracic
 *   spine).
 * Decorative, bound to no concept: Pharynx (nose → larynx), Alveolar_Duct
 * (terminal bronchiole, alveolar duct, pulmonary arteriole and venule),
 * Zoom_Callout (translucent cone from the right lung to the cluster).
 * _L / _R are the subject's left / right: the body faces +z, its left is +x.
 *
 * Lung lobes are meshed from one lung field cut by the fissure planes
 * (surface nets + meshoptimizer), so the lobes fit together with a thin
 * fissure gap; the bronchial tree is grown by recursive splitting of each
 * lobe's volume (deterministic), so it fills the lobe like a real tree.
 */
import { writeFileSync } from 'node:fs';
import { Matrix4 } from 'three';
import { checkBudget, createIO, docTriangles, nodeTree, optimise } from './lib.mjs';
import { hsl, makeNoise, mix as mix3, normalMapPng, pillow, rng, shade, surface } from './three-gltf.mjs';
import { Model, add, basis, blob, capsule, clamp, comb, cross, dot, ell, implicitMesh, len, lerp, lerp3, limb, material, mul, norm, sheet, smax, smin, smoothstep, sub } from './anatomy.mjs';

const [outPath, reportPath] = process.argv.slice(2);
if (!outPath) {
  console.error('usage: node respiratory.mjs <out.glb> [report.json]');
  process.exit(2);
}

const SCALE = 7;
const CENTRE_Y = 0.025;
const N = makeNoise(515);
const R = rng(9091);

const BUMPS = await normalMapPng(41, { kind: 'bumps', strength: 1.8 });
const M_LUNG = material({ name: 'lung', o: 0.42, r: 0.42, cc: 0.7, ccr: 0.2, normal: BUMPS, ns: 0.3, rep: 6 });
const M_AIRWAY = material({ name: 'airway', r: 0.42, cc: 0.45, ccr: 0.25 });
const M_CART = material({ name: 'cartilage', r: 0.3, cc: 0.6, ccr: 0.18 });
const M_SKIN = material({ name: 'skin', r: 0.55, sheen: 0.4, sheenColor: [1, 0.85, 0.8] });
const M_MUCOSA = material({ name: 'mucosa', o: 0.78, r: 0.35, cc: 0.6, ccr: 0.2 });
const M_ALV = material({ name: 'alveolus', r: 0.38, cc: 0.65, ccr: 0.2, normal: BUMPS, ns: 0.25, rep: 3, ds: true });
const M_VESSEL = material({ name: 'vessel', r: 0.35, cc: 0.6, ccr: 0.2 });
const M_MUSCLE = material({ name: 'diaphragm', r: 0.5, cc: 0.35, ccr: 0.3, normal: BUMPS, ns: 0.35, rep: 8 });
const M_BONE = material({ name: 'rib', o: 0.3, r: 0.55, cc: 0.15 });
const M_CALLOUT = material({ name: 'callout', o: 0.16, r: 0.3, ds: true });

const m = new Model('RespiratorySystem');
const deg = Math.PI / 180;

/* ------------------------------------------------------------------ paint */

const tone = (h, s, l, { amp = 0.04, f = 60, k = 0.08 } = {}) => (p, n, u, v, cav) => {
  const t = N.fbm(p[0] * f, p[1] * f, p[2] * f, 3);
  return shade(hsl(h + 6 * t, s, l + amp * t), clamp(1 - k * cav, 0.65, 1.08) * (0.9 + 0.1 * (n[1] * 0.5 + 0.5)));
};
const CART = tone(198, 0.26, 0.8, { amp: 0.03, f: 120 });
const IVORY = tone(40, 0.3, 0.84, { amp: 0.03 });
const MUCOSA = tone(356, 0.5, 0.72, { amp: 0.04 });
const SKIN = tone(18, 0.42, 0.72, { amp: 0.025, f: 90 });

/* ------------------------------------------------------------- body plan */

/** Diaphragm height under (x, z): right cupola higher than the left, deep posterior recesses. */
function dome(x, z) {
  const back = Math.max(0, -z - 0.02);
  const cr = -0.122 - 9 * (x + 0.07) ** 2 - 5 * z * z - 9 * back * back;
  const cl = -0.136 - 9 * (x - 0.07) ** 2 - 5 * z * z - 9 * back * back;
  const k = 0.008;
  const mx = Math.max(cr, cl);
  return mx + k * Math.log(Math.exp((cr - mx) / k) + Math.exp((cl - mx) / k));
}
const HEART = { c: [0.018, -0.088, 0.03], r: [0.07, 0.056, 0.06] };
const LUNG = { Xc: 0.083, H: 0.26 };
const qEll = (t, k) => {
  const u = clamp(t / k);
  return Math.sqrt(Math.max(0, 1 - (1 - u) ** 2));
};
const lungW = (t) => 0.063 * qEll(t, 0.62) * (1 + 0.05 * Math.sin(Math.PI * clamp(t)));
const lungD = (t) => 0.075 * qEll(t, 0.68);
const lungZc = (t) => -0.004 - 0.012 * t;
const apexY = (s) => (s < 0 ? 0.075 : 0.07);

/** Lung field for side s (−1 right, +1 left), < 0 inside. */
function lungField(s) {
  const top = apexY(s);
  return (p) => {
    const X = s * p[0];
    const t = (top - p[1]) / LUNG.H;
    const w = lungW(t);
    const d = lungD(t);
    const zc = lungZc(t);
    const r = Math.hypot(X - LUNG.Xc, p[2] - zc);
    let f;
    if (t <= 0.002) f = r + (p[1] - top);
    else f = (Math.hypot((X - LUNG.Xc) / w, (p[2] - zc) / d) - 1) * Math.min(w, d);
    f = smax(f, dome(p[0], p[2]) + 0.004 - p[1], 0.012);
    f = smax(f, 0.021 - X, 0.01);
    f = smax(f, -ell(p, HEART.c, HEART.r), 0.012);
    return f + 0.0008 * N.fbm(p[0] * 40, p[1] * 40, p[2] * 40, 2);
  };
}
/** Oblique fissure plane (> 0: upper / front part). */
const oblique = (s) => {
  const y0 = s < 0 ? 0.02 : 0.032;
  const n = norm([0, 0.12, 0.17]);
  return (p) => n[1] * (p[1] - y0) + n[2] * (p[2] + 0.07) + 0.006 * Math.sin(p[0] * 40);
};
const horizontal = (p) => p[1] - (-0.012 + 0.04 * p[2]);
const GAP = 0.0022;
const LOBES = {
  R: [
    { key: 'RU', f: (L, o) => (p) => smax(smax(L(p), GAP - o(p), 0.004), GAP - horizontal(p), 0.004) },
    { key: 'RM', f: (L, o) => (p) => smax(smax(L(p), GAP - o(p), 0.004), GAP + horizontal(p), 0.004) },
    { key: 'RL', f: (L, o) => (p) => smax(L(p), GAP + o(p), 0.004) },
  ],
  L: [
    { key: 'LU', f: (L, o) => (p) => smax(L(p), GAP - o(p), 0.004) },
    { key: 'LL', f: (L, o) => (p) => smax(L(p), GAP + o(p), 0.004) },
  ],
};

/* ------------------------------------------------------------- lungs, tree */

const lungPaint = (h) => (p, n, u, v, cav) => {
  // Pink pleura with a faint polygonal lobule pattern.
  const lob = N.ridge(p[0] * 70, p[1] * 70, p[2] * 70, 2);
  const t = N.fbm(p[0] * 25, p[1] * 25, p[2] * 25, 3);
  return shade(hsl(h + 5 * t, 0.68, 0.74 + 0.04 * t), (1 - 0.18 * smoothstep(0.82, 0.97, lob)) * clamp(1 - 0.06 * cav, 0.75, 1.05));
};

function samples(f, lo, hi, step) {
  const out = [];
  for (let z = lo[2]; z <= hi[2]; z += step) for (let y = lo[1]; y <= hi[1]; y += step) for (let x = lo[0]; x <= hi[0]; x += step) if (f([x, y, z]) < -0.005) out.push([x, y, z]);
  return out;
}
const centroid = (S) => mul(S.reduce((a, b) => add(a, b), [0, 0, 0]), 1 / S.length);
function principal(S, c) {
  let v = [0.6, 0.5, 0.62];
  for (let it = 0; it < 12; it++) {
    let w = [0, 0, 0];
    for (const q of S) {
      const d = sub(q, c);
      w = add(w, mul(d, dot(d, v)));
    }
    v = norm(w);
  }
  return v;
}

/** Bronchiole paint by calibre: cartilage-cream large airways → coral small ones. */
const treePaint = (r) => {
  const k = smoothstep(0.0034, 0.0012, r);
  const a = hsl(32, 0.32, 0.85);
  const b = hsl(8, 0.62, 0.68);
  const base = mix3(a, b, k);
  return (p, n, t, u, cav) => shade(base, clamp(1 - 0.07 * cav, 0.75, 1.05) * (0.88 + 0.12 * (n[1] * 0.5 + 0.5)));
};
function segment(node, a, b, r, rEnd = r * 0.9) {
  const na = r > 0.0026 ? 10 : r > 0.0014 ? 6 : 4;
  m.add(node, limb([a, lerp3(a, b, 0.5), b], na, r > 0.002 ? 4 : 2, (t) => lerp(r, rEnd, t), { paint: treePaint(r), cap: 0.12 }), M_AIRWAY);
}
/** Recursive volume-splitting tree: each branch aims at the centroid of its share of the lobe. */
function grow(node, f, p0, S, r, depth, maxDepth) {
  let c = centroid(S);
  if (f(c) > -0.003) c = S.reduce((best, q) => (len(sub(q, c)) < len(sub(best, c)) ? q : best), S[0]);
  if (depth >= maxDepth || S.length < 6) {
    segment(node, p0, c, r, r * 0.8);
    return;
  }
  const end = lerp3(p0, c, depth === 0 ? 0.55 : 0.5);
  segment(node, p0, end, r);
  const ax = principal(S, c);
  const A = [];
  const B = [];
  for (const q of S) (dot(sub(q, c), ax) < 0 ? A : B).push(q);
  const rc = r * 0.79;
  grow(node, f, end, A, rc, depth + 1, maxDepth);
  grow(node, f, end, B, rc, depth + 1, maxDepth);
}

/** C-shaped cartilage rings along a straight airway a → b (open at the back). */
function rings(node, a, b, radius, count, { open = 60, rr = 0.0015, from = 0.04, to = 0.96 } = {}) {
  const ax = norm(sub(b, a));
  const back = norm(sub([0, 0, -1], mul(ax, dot([0, 0, -1], ax))));
  const side = cross(ax, back);
  for (let i = 0; i < count; i++) {
    const c = lerp3(a, b, lerp(from, to, count === 1 ? 0.5 : i / (count - 1)));
    const pts = [];
    const n = 14;
    for (let k = 0; k <= n; k++) {
      const th = (open / 2) * deg + (k / n) * (360 - open) * deg;
      pts.push(comb(c, [back, Math.cos(th) * radius], [side, Math.sin(th) * radius]));
    }
    m.add(node, limb(pts, 6, 24, (t) => rr * (0.75 + 0.25 * Math.sin(Math.PI * t)), { paint: CART, cap: 0.05 }), M_CART);
  }
}

function lungs() {
  const carina = [0, 0, -0.005];
  // Main and lobar bronchi.
  const RB = {
    main: [carina, [-0.022, -0.022, -0.006]],
    upper: [[-0.02, -0.02, -0.006], [-0.046, -0.004, -0.01]],
    inter: [[-0.022, -0.022, -0.006], [-0.03, -0.046, -0.002]],
    middle: [[-0.03, -0.044, -0.002], [-0.048, -0.056, 0.022]],
    lower: [[-0.03, -0.045, -0.002], [-0.044, -0.074, -0.02]],
  };
  const LB = {
    main: [carina, [0.04, -0.03, -0.008]],
    upper: [[0.039, -0.029, -0.008], [0.062, -0.016, 0.004]],
    lower: [[0.04, -0.031, -0.008], [0.054, -0.07, -0.02]],
  };
  const tubeR = (r0, r1) => (t) => lerp(r0, r1, t);
  const bron = (node, [a, b], r0, r1) => m.add(node, limb([a, lerp3(a, b, 0.5), b], 14, 8, tubeR(r0, r1), { paint: treePaint(r0), cap: 0.1 }), M_AIRWAY);
  bron('Bronchi_R', RB.main, 0.0078, 0.0072);
  bron('Bronchi_R', RB.upper, 0.0052, 0.0046);
  bron('Bronchi_R', RB.inter, 0.0064, 0.006);
  bron('Bronchi_R', RB.middle, 0.0044, 0.004);
  bron('Bronchi_R', RB.lower, 0.0056, 0.005);
  bron('Bronchi_L', LB.main, 0.0068, 0.0064);
  bron('Bronchi_L', LB.upper, 0.0054, 0.0048);
  bron('Bronchi_L', LB.lower, 0.0054, 0.0048);
  rings('Bronchi_R', ...RB.main, 0.0085, 3, { rr: 0.0012, from: 0.25, to: 0.8 });
  rings('Bronchi_L', ...LB.main, 0.0074, 6, { rr: 0.0011, from: 0.15, to: 0.85 });

  const starts = { RU: RB.upper[1], RM: RB.middle[1], RL: RB.lower[1], LU: LB.upper[1], LL: LB.lower[1] };
  const depthOf = { RU: 6, RM: 5, RL: 6, LU: 6, LL: 6 };
  const hue = { RU: 352, RM: 348, RL: 354, LU: 352, LL: 355 };
  for (const [side, s] of [
    ['R', -1],
    ['L', 1],
  ]) {
    const L = lungField(s);
    const o = oblique(s);
    const lo = s < 0 ? [-0.16, -0.25, -0.1] : [0.0, -0.25, -0.1];
    const hi = s < 0 ? [0.0, 0.085, 0.09] : [0.16, 0.085, 0.09];
    for (const lobe of LOBES[side]) {
      const f = lobe.f(L, o);
      m.add(`Lung_${side}`, implicitMesh(f, lo, hi, 0.0028, { tris: lobe.key === 'RM' ? 3500 : 6000, paint: lungPaint(hue[lobe.key]), ao: 0.01 }), M_LUNG);
      const S = samples(f, lo, hi, 0.0065);
      grow(`Bronchioles_${side}`, f, starts[lobe.key], S, 0.0042, 0, depthOf[lobe.key]);
    }
  }
}

/* ------------------------------------------------------- upper airway */

const TRACHEA = { top: [0, 0.112, 0.012], bottom: [0, 0.004, -0.004] };

function trachea() {
  const { top, bottom } = TRACHEA;
  m.add('Trachea', limb([top, lerp3(top, bottom, 0.5), bottom], 24, 16, 0.0092, { paint: MUCOSA, cap: 0.02 }), M_AIRWAY);
  rings('Trachea', top, bottom, 0.0101, 18, { rr: 0.0017, from: 0.03, to: 0.95, open: 70 });
}

function larynx() {
  const S = 'Larynx';
  const base = [0, 0.114, 0.013];
  const ax = norm(sub(TRACHEA.top, TRACHEA.bottom));
  // Laryngeal airway (mucosa) inside the cartilages.
  m.add(S, limb([base, [0, 0.14, 0.014], [0, 0.168, 0.01]], 20, 10, (t) => 0.0098 + 0.0016 * Math.sin(Math.PI * t), { paint: MUCOSA, cap: 0.05 }), M_AIRWAY);
  // Cricoid: signet ring, tall lamina at the back.
  const q = basis([1, 0, 0], ax);
  m.add(S, blob(add(base, [0, 0.002, 0]), [0.0122, 0.0034, 0.0122], { q, nu: 28, nv: 8, e: [1, 0.5, 1], shape: (d) => [1, 1 + 1.6 * Math.max(0, -d[2]) ** 2, 1], paint: CART }), M_CART);
  // Thyroid cartilage: two laminae meeting at the laryngeal prominence, superior notch, horns.
  for (const s of [-1, 1]) {
    const P = (U, W) => {
      const u = (U + 1) / 2; // front → back
      const w = (W + 1) / 2; // bottom → top
      const yTop = 0.165 - 0.009 * Math.exp(-((u / 0.12) ** 2)) - 0.004 * u;
      const yBot = 0.124 + 0.004 * Math.sin(Math.PI * u);
      const y = lerp(yBot, yTop, w);
      const x = s * (0.0025 + 0.0175 * Math.sin((u * Math.PI) / 2) + 0.002 * w);
      const z = 0.031 - 0.032 * u + 0.004 * w * (1 - u);
      return [x, y, z];
    };
    m.add(S, sheet(16, 14, P, () => 0.0013, { paint: CART }), M_CART);
    m.add(S, limb([[s * 0.0215, 0.16, -0.001], [s * 0.022, 0.17, -0.004], [s * 0.021, 0.177, -0.006]], 6, 8, (t) => 0.0016 - 0.0004 * t, { paint: CART }), M_CART);
    m.add(S, blob([s * 0.006, 0.124, -0.007], [0.003, 0.005, 0.003], { nu: 10, nv: 8, paint: CART }), M_CART); // arytenoid
  }
  // Epiglottis: leaf curving up and back behind the tongue.
  const E = (U, W) => {
    const w = (W + 1) / 2;
    const width = 0.004 + 0.008 * Math.sin(Math.PI * Math.min(1, w * 0.85 + 0.15));
    return [U * width, 0.15 + 0.04 * w, 0.02 - 0.006 * w - 0.01 * w * w + 0.004 * U * U];
  };
  m.add(S, sheet(12, 14, E, () => 0.001, { paint: tone(48, 0.5, 0.8) }), M_CART);
}

function noseAndPharynx() {
  // Pharynx: from the nasopharynx behind the nasal cavity down to the laryngeal inlet.
  m.add('Pharynx', limb([[0, 0.172, -0.004], [0, 0.205, -0.014], [0, 0.245, -0.018], [0, 0.272, -0.012], [0, 0.284, 0.004]], 18, 28, (t) => 0.0115 + 0.003 * Math.sin(Math.PI * t), { paint: MUCOSA, cap: 0.05 }), M_MUCOSA);
  const S = 'Nose';
  // Nasal cavity: tall, narrow passage with three conchae on each side wall.
  const cav = (p) => {
    return smax(ell(p, [0, 0.292, 0.045], [0.016, 0.026, 0.05]), Math.abs(p[0]) - 0.014, 0.004);
  };
  m.add(S, implicitMesh(cav, [-0.02, 0.26, -0.01], [0.02, 0.325, 0.1], 0.002, { tris: 2500, paint: MUCOSA }), M_MUCOSA);
  for (const s of [-1, 1])
    for (const [y, z, l] of [
      [0.304, 0.035, 0.022],
      [0.291, 0.04, 0.03],
      [0.277, 0.042, 0.034],
    ])
      m.add(S, blob([s * 0.011, y, z], [0.003, 0.0035, l], { q: basis([1, 0, 0], [0, 1, 0.15]), nu: 12, nv: 10, paint: tone(352, 0.5, 0.66) }), M_AIRWAY);
  // External nose: dorsum, tip and alae, open nostrils.
  const nose = (p) => {
    let f = capsule(p, [0, 0.318, 0.083], [0, 0.274, 0.108], 0.0065, 0.0095);
    f = smin(f, ell(p, [0, 0.27, 0.105], [0.009, 0.008, 0.009]), 0.006);
    for (const s of [-1, 1]) f = smin(f, ell(p, [s * 0.013, 0.266, 0.093], [0.008, 0.0075, 0.011]), 0.008);
    for (const s of [-1, 1]) f = smax(f, -ell(p, [s * 0.0068, 0.262, 0.1], [0.0042, 0.0042, 0.0085]), 0.002);
    f = smax(f, 0.085 - p[2] - 0.15 * (p[1] - 0.27), 0.004); // open towards the cavity
    return f;
  };
  m.add(S, implicitMesh(nose, [-0.03, 0.25, 0.07], [0.03, 0.325, 0.125], 0.0012, { tris: 4000, paint: SKIN }), M_SKIN);
}

/* ------------------------------------------------- alveoli (magnified) */

function alveoli() {
  const A0 = [-0.25, -0.036, 0.03];
  const T0 = [-0.192, -0.008, 0.03];
  const T1 = [-0.218, -0.022, 0.03];
  const duct = [
    norm([-1, 0.45, 0.15]),
    norm([-0.75, -0.75, 0.1]),
    norm([-0.35, -0.2, 0.95]),
  ];
  const D = duct.map((d) => comb(T1, [d, 0.021]));
  const Ad = 'Alveolar_Duct';
  m.add(Ad, limb([T0, lerp3(T0, T1, 0.5), T1], 12, 6, 0.0042, { paint: treePaint(0.0016), cap: 0.1 }), M_AIRWAY);
  for (const d of D) m.add(Ad, limb([T1, lerp3(T1, d, 0.5), d], 10, 6, (t) => 0.0036 - 0.001 * t, { paint: treePaint(0.0012), cap: 0.12 }), M_AIRWAY);
  // Nine alveoli: three around each duct end.
  const spreads = [
    [norm([-1, 0.6, -0.4]), norm([-0.6, 1, 0.5]), norm([-1, -0.1, 0.7])],
    [norm([-0.9, -0.6, -0.5]), norm([0.1, -1, 0.3]), norm([-0.7, -0.5, 0.9])],
    [norm([-0.6, 0.3, 1]), norm([0.25, -0.35, 1]), norm([-0.3, -0.8, 0.8])],
  ];
  const centres = [];
  D.forEach((d, k) => spreads[k].forEach((dir) => centres.push({ c: comb(d, [dir, 0.0144]), r: 0.0122 + 0.0032 * R() })));
  // The alveolus most facing the camera is cut open to show the air space and thin wall.
  const view = norm([0.1, 0.25, 1]);
  let open = 0;
  centres.forEach(({ c }, i) => {
    if (dot(sub(c, A0), view) > dot(sub(centres[open].c, A0), view)) open = i;
  });
  const flow = norm([0.4, -1, 0.1]); // arteriole (top) → venule (bottom)
  const capCol = (p) => {
    const t = clamp(dot(sub(p, A0), flow) / 0.06 + 0.5);
    return mix3(hsl(228, 0.55, 0.46), hsl(356, 0.72, 0.46), smoothstep(0.15, 0.85, t));
  };
  const alvPaint = (side) => (p, n, u, v, cav) => {
    const t = N.fbm(p[0] * 300, p[1] * 300, p[2] * 300, 2);
    return shade(hsl(8 + 6 * t, 0.55, side === 'in' ? 0.82 : 0.76 + 0.03 * t), clamp(1 - 0.07 * cav, 0.75, 1.05));
  };
  centres.forEach(({ c, r }, i) => {
    const node = `Alveoli_${i + 1}`;
    const dirOf = (u, v) => [Math.sin(v * Math.PI) * Math.cos(u * 2 * Math.PI), Math.cos(v * Math.PI), Math.sin(v * Math.PI) * Math.sin(u * 2 * Math.PI)];
    const rad = (d) => r * (1 + 0.05 * N.n(d[0] * 2 + i * 7, d[1] * 2, d[2] * 2));
    const isOpen = i === open;
    m.add(
      node,
      surface(32, 22, (u, v) => {
        const d = dirOf(u, v);
        return comb(c, [d, rad(d)]);
      }, isOpen ? {
        cut: (u, v) => dot(dirOf(u, v), view) > 0.45,
        thick: 0.0011,
        paint: (p, n, u, v, cv, side) => alvPaint(side)(p, n, u, v, cv),
        rim: [[0, hsl(8, 0.5, 0.74)], [1, hsl(8, 0.45, 0.8)]],
      } : { paint: alvPaint('out') }),
      M_ALV,
    );
    // Capillary net: wobbly loops hugging the alveolus.
    const loops = 7;
    for (let j = 0; j < loops; j++) {
      const y = 1 - (2 * (j + 0.5)) / loops;
      const ph = j * 2.39996 + i;
      const a = norm([Math.sqrt(1 - y * y) * Math.cos(ph), y, Math.sqrt(1 - y * y) * Math.sin(ph)]);
      const e1 = norm(cross(a, Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
      const e2 = cross(a, e1);
      const lat = (R() - 0.5) * 0.9;
      const rho = Math.sqrt(1 - lat * lat);
      const pts = [];
      const n = 26;
      for (let k = 0; k < n; k++) {
        const th = (k / n) * Math.PI * 2;
        let d = norm(comb(mul(a, lat), [e1, Math.cos(th) * rho], [e2, Math.sin(th) * rho]));
        d = norm(add(d, mul([N.n(d[0] * 3 + j, d[1] * 3, i), N.n(d[1] * 3, d[2] * 3 + j, i), N.n(d[2] * 3, d[0] * 3, i + j)], 0.25)));
        pts.push(comb(c, [d, rad(d) * 1.045 + 0.0004]));
      }
      if (isOpen) {
        // Only the part of the loop away from the opening.
        const keep = pts.map((p) => dot(norm(sub(p, c)), view) < 0.38);
        let start = keep.findIndex((k, idx) => k && !keep[(idx + n - 1) % n]);
        if (start < 0) continue;
        const run = [];
        for (let k = 0; k < n && keep[(start + k) % n]; k++) run.push(pts[(start + k) % n]);
        if (run.length < 4) continue;
        m.add(node, limb(run, 3, run.length * 2, 0.00095, { paint: (p) => capCol(p), cap: 0.04 }), M_VESSEL);
      } else m.add(node, limb(pts, 3, 44, 0.00095, { paint: (p) => capCol(p), closed: true, cap: 0 }), M_VESSEL);
    }
  });
  // Pulmonary arteriole (blue) in along the bronchiole, venule (red) out below.
  const art = [[-0.19, 0.004, 0.022], [-0.205, -0.004, 0.024], [-0.222, -0.012, 0.03]];
  m.add(Ad, limb(art, 8, 12, (t) => 0.0024 - 0.0008 * t, { paint: () => hsl(228, 0.55, 0.46), cap: 0.08 }), M_VESSEL);
  for (const d of D) m.add(Ad, limb([art[2], lerp3(art[2], d, 0.6), comb(d, [norm(sub(d, T1)), 0.006], [[0, 1, 0], 0.004])], 6, 8, (t) => 0.0015 - 0.0005 * t, { paint: () => hsl(228, 0.55, 0.46), cap: 0.1 }), M_VESSEL);
  const ven = [[-0.19, -0.058, 0.03], [-0.215, -0.062, 0.032], [-0.238, -0.066, 0.034]];
  m.add(Ad, limb(ven, 8, 12, (t) => 0.0026 - 0.0008 * t, { paint: () => hsl(356, 0.72, 0.46), cap: 0.08 }), M_VESSEL);
  // Callout: a translucent cone from a ring on the right lung to the cluster.
  const L = lungField(-1);
  let lp = [-0.12, -0.03, 0.03];
  while (L(lp) < 0) lp = add(lp, [-0.001, 0, 0]);
  const Z = 'Zoom_Callout';
  const axis = norm(sub(A0, lp));
  const e1 = norm(cross(axis, [0, 0, 1]));
  const e2 = cross(axis, e1);
  const r0 = 0.006;
  const r1 = 0.056;
  const far = comb(lp, [axis, len(sub(A0, lp)) - 0.05]);
  m.add(Z, surface(40, 2, (u, v) => comb(lerp3(lp, far, v), [e1, Math.cos(u * 2 * Math.PI) * lerp(r0, r1, v)], [e2, Math.sin(u * 2 * Math.PI) * lerp(r0, r1, v)]), { paint: () => hsl(200, 0.4, 0.9) }), M_CALLOUT);
  const ringPts = (c, r) => Array.from({ length: 48 }, (_, k) => comb(c, [e1, Math.cos((k / 48) * 2 * Math.PI) * r], [e2, Math.sin((k / 48) * 2 * Math.PI) * r]));
  m.add(Z, limb(ringPts(lp, r0), 5, 48, 0.0007, { paint: () => hsl(200, 0.3, 0.92), closed: true, cap: 0 }), M_CART);
  m.add(Z, limb(ringPts(far, r1), 5, 96, 0.0009, { paint: () => hsl(200, 0.3, 0.92), closed: true, cap: 0 }), M_CART);
}

/* ------------------------------------------------- diaphragm and ribs */

function diaphragm() {
  const S = 'Diaphragm';
  const map = (X, Z) => {
    const x = 0.152 * X;
    const z = -0.008 + 0.088 * Z;
    return [x, dome(x, z) - 0.0035, z];
  };
  const tendon = (x, z) => {
    // Trefoil central tendon: three leaves around a centre in front of the spine.
    const c = [0.004, 0.012];
    const dx = x - c[0];
    const dz = z - c[1];
    const a = Math.atan2(dz, dx);
    const r = Math.hypot(dx / 1.2, dz);
    return 1 - smoothstep(0.034, 0.046, r / (0.75 + 0.25 * Math.cos(3 * (a - Math.PI / 2))));
  };
  m.add(
    S,
    pillow(
      48,
      36,
      (X, Z) => {
        const p = map(X, Z);
        const e = 1e-3;
        const pu = sub(map(X + e, Z), map(X - e, Z));
        const pv = sub(map(X, Z + e), map(X, Z - e));
        return { p, n: norm(cross(pv, pu)) };
      },
      (X, Z) => 0.0028 * (1 - 0.4 * (X * X + Z * Z)),
      {
        profile: 0.5,
        paint: (p, n, X, Z, cav) => {
          const tnd = tendon(p[0], p[2]);
          const ang = Math.atan2(p[2] - 0.012, p[0]);
          const fib = N.n(ang * 18, Math.hypot(p[0], p[2]) * 20, 0.5);
          const muscle = shade(hsl(356 + 4 * fib, 0.55, 0.45 + 0.04 * fib), clamp(1 - 0.08 * cav, 0.7, 1.08));
          return mix3(muscle, hsl(40, 0.18, 0.86), tnd);
        },
      },
    ),
    M_MUSCLE,
  );
  // Crura down to the lumbar spine.
  for (const s of [-1, 1]) m.add(S, limb([[s * 0.018, -0.165, -0.056], [s * 0.017, -0.2, -0.066], [s * 0.013, -0.235, -0.07], [s * 0.011, -0.255, -0.068]], 10, 16, (t) => 0.0055 - 0.003 * t, { paint: (p, n, t) => mix3(hsl(356, 0.55, 0.42), hsl(40, 0.18, 0.8), smoothstep(0.75, 1, t)), cap: 0.1 }), M_MUSCLE);
}

function ribs() {
  const S = 'Ribs';
  const spineZ = -0.078;
  // Light thoracic spine: bodies and spinous processes.
  for (let i = 0; i < 12; i++) {
    const y = 0.098 - 0.0245 * i;
    m.add(S, blob([0, y, spineZ], [0.011 + 0.004 * (i / 11), 0.009 + 0.002 * (i / 11), 0.01 + 0.003 * (i / 11)], { nu: 14, nv: 8, e: [1, 0.4, 1], paint: IVORY }), M_BONE);
    m.add(S, limb([[0, y, spineZ - 0.014], [0, y - 0.012, spineZ - 0.03]], 6, 4, 0.0028, { paint: IVORY }), M_BONE);
  }
  // Ribs 1–10, back and side only (the front is left open).
  for (const s of [-1, 1]) {
    const top = apexY(s);
    for (let i = 0; i < 10; i++) {
      const y0 = 0.09 - 0.0245 * i;
      const drop = 0.03 + 0.004 * i;
      const psi0 = -2.25;
      const psiE = i < 2 ? 0.6 : 0.1 + 0.02 * i;
      const pts = [[s * 0.014, y0, spineZ - 0.002]];
      const n = 12;
      for (let k = 0; k <= n; k++) {
        const g = k / n;
        const psi = lerp(psi0, psiE, g);
        const y = y0 - drop * g ** 1.4;
        const t = Math.max(0.05, (top - y) / LUNG.H);
        const cl = 0.011;
        pts.push([s * (LUNG.Xc + (lungW(t) + cl) * Math.cos(psi)), y, lungZc(t) + (lungD(t) + cl) * Math.sin(psi)]);
      }
      m.add(S, limb(pts, 7, 36, (t) => 0.0034 * (0.85 + 0.15 * smoothstep(0, 0.15, t)) * (1 - 0.25 * smoothstep(0.85, 1, t)), { paint: IVORY, cap: 0.08 }), M_BONE);
    }
  }
}

/* ------------------------------------------------------------------ build */

noseAndPharynx();
larynx();
trachea();
lungs();
alveoli();
diaphragm();
ribs();

const M = new Matrix4().makeTranslation(0, -CENTRE_Y * SCALE, 0).multiply(new Matrix4().makeScale(SCALE, SCALE, SCALE));
const doc = m.toDocument(M);
const io = await createIO();
const before = (await io.writeBinary(doc)).byteLength;
await optimise(doc, { ratio: 1 });
const glb = await io.writeBinary(doc);
const tris = docTriangles(doc);
checkBudget(outPath, glb.byteLength, tris, { maxBytes: 1.5 * 1024 * 1024 });
writeFileSync(outPath, glb);
const report = { sizeBefore: before, sizeAfter: glb.byteLength, trianglesAfter: tris, textures: doc.getRoot().listTextures().length, nodes: nodeTree(doc) };
if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`${outPath}: ${glb.byteLength} bytes, ${tris} triangles`);
