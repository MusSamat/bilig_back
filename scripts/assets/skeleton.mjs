#!/usr/bin/env node
/**
 * skeleton.glb: a full human skeleton, authored here from three.js geometry
 * (our own work, CC0). Standing in the anatomical position (palms forward),
 * arms slightly away from the body, adult proportions (1.75 m, built in
 * metres and scaled ×2 → 3.5 scene units, centred on the hips).
 *
 *   node skeleton.mjs <out.glb> [report.json]
 *
 * Node names are a contract with the content (masks Skel_*, Joint_*, Muscle_*):
 *   Skel_Skull, Skel_Cervical, Skel_Spine (thoracic + lumbar, with discs),
 *   Skel_Clavicle_L/R, Skel_Scapula_L/R, Skel_Ribs (12 pairs + costal
 *   cartilage), Skel_Sternum, Skel_Humerus_L/R, Skel_Radius_L/R,
 *   Skel_Ulna_L/R, Skel_Hand_L/R, Skel_Pelvis (hip bones + sacrum),
 *   Skel_Coccyx, Skel_Femur_L/R, Skel_Patella_L/R, Skel_Tibia_L/R,
 *   Skel_Fibula_L/R, Skel_Foot_L/R, Joint_Ball_Shoulder_L/R,
 *   Joint_Ball_Hip_L/R, Joint_Hinge_Elbow_L/R, Joint_Hinge_Knee_L/R,
 *   Muscle_Biceps_R, Muscle_Triceps_R.
 * _L / _R are the subject's left / right: the figure faces +z, so its left
 * side is +x.
 *
 * Look: ivory bone (vertex colour with seeded noise tone and baked cavity
 * shading, a fine bump normal map, a faint clearcoat), articular cartilage of
 * the four joint nodes in a pale blue-white gloss (subtly highlighted), the
 * biceps and triceps of the right arm semi-translucent red with tendon ends.
 */
import { writeFileSync } from 'node:fs';
import { CatmullRomCurve3, Matrix4 } from 'three';
import { checkBudget, createIO, docTriangles, nodeTree, optimise } from './lib.mjs';
import { hsl, makeNoise, normalMapPng, rng, shade, surface } from './three-gltf.mjs';
import { Model, V, add, basis, blob, clamp, comb, cross, capsule, cup, ell, implicitMesh, limb, material, mul, norm, polyTube, rotateTowards, sheet, smax, smin, smoothstep, spline, sub, lerp, lerp3 } from './anatomy.mjs';

const [outPath, reportPath] = process.argv.slice(2);
if (!outPath) {
  console.error('usage: node skeleton.mjs <out.glb> [report.json]');
  process.exit(2);
}

const SCALE = 2;
const CENTRE_Y = 0.875;
const NB = makeNoise(77);
const NS = makeNoise(2024);
const R = rng(4242);
const deg = Math.PI / 180;

const BUMPS = await normalMapPng(31, { kind: 'bumps', strength: 1.6 });
const M_BONE = material({ name: 'bone', r: 0.62, cc: 0.12, ccr: 0.55, normal: BUMPS, ns: 0.35, rep: 5 });
const M_TOOTH = material({ name: 'enamel', r: 0.3, cc: 0.5, ccr: 0.2 });
const M_CART = material({ name: 'cartilage', r: 0.32, cc: 0.55, ccr: 0.2 });
const M_JOINT = material({ name: 'joint', r: 0.28, cc: 0.7, ccr: 0.15, emissive: [0.035, 0.05, 0.06] });
const M_MUSCLE = material({ name: 'muscle', o: 0.55, r: 0.42, cc: 0.45, ccr: 0.25, normal: BUMPS, ns: 0.25, rep: 3 });

/* ------------------------------------------------------------------ paint */

/** Ivory bone: seeded tone variation, cavity darkening, a little sky occlusion. */
function bonePaint({ h = 41, s = 0.34, l = 0.8, k = 0.09 } = {}) {
  return (p, n, u, v, cav) => {
    const t = NB.fbm(p[0] * 34, p[1] * 34, p[2] * 34, 3);
    const f = NB.n(p[0] * 230, p[1] * 230, p[2] * 230);
    const ao = clamp(1 - k * cav, 0.62, 1.08) * (0.9 + 0.1 * (n[1] * 0.5 + 0.5));
    return shade(hsl(h + 6 * t, s + 0.08 * t, l + 0.045 * t + 0.015 * f), ao);
  };
}
const IVORY = bonePaint();
const cartPaint = (h = 192, s = 0.36, l = 0.8) => (p, n, u, v, cav) => {
  const t = NB.n(p[0] * 120, p[1] * 120, p[2] * 120);
  return shade(hsl(h + 6 * t, s, l + 0.03 * t), clamp(1 - 0.06 * cav, 0.75, 1.05) * (0.92 + 0.08 * (n[1] * 0.5 + 0.5)));
};
const CART = cartPaint();
const JOINT = cartPaint(195, 0.42, 0.79);
const TOOTH = (p, n, u, v, cav) => shade(hsl(46 + 4 * NB.n(p[0] * 300, p[1] * 300, 0), 0.28, 0.9), clamp(1 - 0.08 * cav, 0.7, 1.05));

const m = new Model('Skeleton');
const bone = (node, geo) => m.add(node, geo, M_BONE);

/** Long-bone shaft: thicker metaphyses at both ends (ra, rb = end radii, r = mid). */
const shaftR = (ra, r, rb, ea = 0.18, eb = 0.18) => (t) => r + (ra - r) * (1 - smoothstep(0, ea, t)) + (rb - r) * smoothstep(1 - eb, 1, t);

/* ------------------------------------------------------------------ skull */

function skull() {
  const S = 'Skel_Skull';
  // Cranium and upper face as one implicit solid: smooth union of the vault,
  // maxilla, cheekbones with their arches, brow ridges, nasal bones and
  // mastoids, minus the orbits, the nasal aperture and the temporal fossae
  // (so the zygomatic arches are real bridges and the orbits real cavities).
  const orb = (p, s) => ell(p, [s * 0.032, 1.606, 0.058], [0.018, 0.0165, 0.03]);
  const nas = (p) => ell(p, [0, 1.583, 0.07], [0.0095 + 0.0035 * clamp((1.59 - p[1]) / 0.015, -1, 1), 0.017, 0.024]);
  const f = (p) => {
    let s = smax(ell(p, [0, 1.664, -0.014], [0.071, 0.075, 0.094]), 1.598 - p[1] + 0.006 * clamp((p[2] - 0.02) / 0.04, 0, 1), 0.016);
    s = smin(s, ell(p, [0, 1.588, 0.036], [0.045, 0.031, 0.041]), 0.012); // maxilla
    s = smin(s, ell(p, [0, 1.566, 0.052], [0.03, 0.012, 0.026]), 0.01); // alveolar arch
    for (const x of [-1, 1]) {
      s = smin(s, ell(p, [x * 0.05, 1.598, 0.048], [0.014, 0.015, 0.016]), 0.008); // zygomatic body
      s = smin(s, polyTube(p, [[x * 0.056, 1.597, 0.04], [x * 0.065, 1.6, 0.018], [x * 0.066, 1.603, -0.002], [x * 0.06, 1.607, -0.014]], (t) => 0.0042 - 0.0008 * Math.sin(Math.PI * t)), 0.004); // arch
      s = smin(s, capsule(p, [x * 0.05, 1.598, 0.052], [x * 0.047, 1.628, 0.06], 0.0052, 0.0045), 0.006); // lateral orbital rim
      s = smin(s, ell(p, [x * 0.026, 1.629, 0.07], [0.021, 0.0075, 0.011]), 0.008); // brow ridge
      s = smin(s, ell(p, [x * 0.053, 1.596, -0.034], [0.007, 0.011, 0.008]), 0.008); // mastoid
    }
    s = smin(s, ell(p, [0, 1.611, 0.074], [0.0065, 0.014, 0.008]), 0.006); // nasal bones
    for (const x of [-1, 1]) {
      s = smax(s, -orb(p, x), 0.004);
      s = smax(s, -ell(p, [x * 0.092, 1.634, 0.0], [0.021, 0.03, 0.032]), 0.008);
    }
    s = smax(s, -nas(p), 0.003);
    return s + 0.0006 * NS.fbm(p[0] * 70, p[1] * 70, p[2] * 70, 3);
  };
  bone(
    S,
    implicitMesh(f, [-0.085, 1.55, -0.115], [0.085, 1.745, 0.095], 0.0017, {
      tris: 14000,
      paint: (p, n, u, v, cav) => {
        const q = sub(p, [0, 1.664, -0.014]);
        const cor = Math.abs(q[2] - 0.025 + 0.12 * q[1]);
        const sag = q[1] > 0.02 && q[2] < 0.03 ? Math.abs(q[0] + 0.0015 * Math.sin(q[2] * 400)) : 1;
        const lam = q[2] < -0.02 ? Math.abs(q[1] - 0.02 + 0.55 * (-q[2] - 0.05) - 2.2 * q[0] * q[0]) : 1;
        const suture = Math.min(cor, sag, lam) < 0.0014 && q[1] > -0.01 ? 0.8 : 1;
        const inO = Math.min(orb(p, -1), orb(p, 1));
        const deep = Math.max((1 - smoothstep(0.0, 0.004, inO)) * smoothstep(0.078, 0.05, p[2]), (1 - smoothstep(0.0, 0.004, nas(p))) * smoothstep(0.08, 0.06, p[2]));
        return shade(IVORY(p, n, u, v, cav), suture * (1 - 0.85 * deep));
      },
    }),
  );
  // Mandible: body along the arch (taller than thick), rami, coronoid processes, condyles.
  const arch = [
    [-0.047, 1.537, -0.004],
    [-0.043, 1.531, 0.022],
    [-0.031, 1.527, 0.046],
    [-0.016, 1.524, 0.064],
    [0, 1.523, 0.072],
    [0.016, 1.524, 0.064],
    [0.031, 1.527, 0.046],
    [0.043, 1.531, 0.022],
    [0.047, 1.537, -0.004],
  ];
  const Y0 = 1.53;
  const squash = (q) => [q[0], Y0 + (q[1] - Y0) / 2.1, q[2]];
  const jaw = (p) => {
    let s = polyTube(squash(p), arch.map(squash), (t) => 0.0062 + 0.0012 * Math.exp(-(((t - 0.5) / 0.12) ** 2)));
    s = smin(s, ell(p, [0, 1.512, 0.072], [0.012, 0.006, 0.007]), 0.006); // chin
    for (const x of [-1, 1]) {
      // Ramus: a plate gonion → condyle / coronoid with the mandibular notch between.
      const g = [x * 0.047, 1.536, -0.002];
      const c = [x * 0.051, 1.594, -0.011];
      const k = [x * 0.046, 1.593, 0.019];
      s = smin(s, capsule(p, g, c, 0.0048, 0.0042), 0.008);
      s = smin(s, capsule(p, [x * 0.045, 1.546, 0.022], k, 0.0045, 0.0028), 0.008);
      s = smin(s, smax(capsule(p, [x * 0.047, 1.55, 0.006], [x * 0.049, 1.575, 0.004], 0.0035, 0.0035) - 0.009, Math.abs(p[0] - x * 0.048) - 0.0032, 0.002), 0.006);
      s = smin(s, ell(p, [x * 0.052, 1.598, -0.011], [0.0095, 0.0045, 0.0055]), 0.004); // condyle
    }
    return s + 0.0004 * NS.fbm(p[0] * 90, p[1] * 90, p[2] * 90, 2);
  };
  bone(S, implicitMesh(jaw, [-0.066, 1.5, -0.025], [0.066, 1.61, 0.09], 0.0013, { tris: 5000, paint: IVORY }));
  // Teeth: upper and lower arches, incisors narrow and tall, molars broad.
  for (const [y0, zOff, w] of [
    [1.5585, 0.001, 0.0272],
    [1.5455, -0.002, 0.0255],
  ]) {
    for (let k = 0; k < 16; k++) {
      const a = ((k + 0.5) / 16) * 2 - 1;
      const x = w * a;
      const z = 0.076 + zOff - 0.04 * a * a;
      const back = Math.abs(a);
      const r = [0.0024 + 0.0022 * back, 0.0052 - 0.0014 * back, 0.0021 + 0.0026 * back];
      const tan = norm([1, 0, (-0.08 * a) / w]);
      m.add(S, blob([x, y0, z], r, { q: basis([tan[0], 0, tan[2]], [0, 1, 0]), nu: 10, nv: 6, e: [0.7, 0.8, 0.7], paint: TOOTH }), M_TOOTH);
    }
  }
}

/* ------------------------------------------------------------------ spine */

const spineCurve = new CatmullRomCurve3(
  [
    [0, 1.582, -0.02],
    [0, 1.5, -0.022],
    [0, 1.44, -0.04],
    [0, 1.33, -0.066],
    [0, 1.22, -0.07],
    [0, 1.13, -0.056],
    [0, 1.04, -0.034],
    [0, 0.982, -0.04],
  ].map(V),
  false,
  'centripetal',
);
const SPINE_LEN = spineCurve.getLength();
/** Vertebra centres and frames by level (C1…C7, T1…T12, L1…L5). */
const LEVELS = [];

function vertebra(node, kind, i, P, up) {
  const fwd = norm(cross([1, 0, 0], up)); // ⟂ up, pointing forward
  const q = basis([1, 0, 0], up);
  const W = (l) => {
    // local (x right, y up, z forward) → world
    const v = V(l).applyQuaternion(q);
    return [P[0] + v.x, P[1] + v.y, P[2] + v.z];
  };
  const T = kind === 'T' ? i / 11 : 0;
  const dims = {
    C: { bx: 0.0085 + 0.0006 * i, bz: 0.0075, h: 0.0125, canal: 0.011, ar: 0.0027, sl: 0.016 + 0.003 * (i === 6), sa: 25, tp: 0.016, tb: 0.002, dh: 0.004 },
    T: { bx: 0.0115 + 0.006 * T, bz: 0.0105 + 0.004 * T, h: 0.0175 + 0.004 * T, canal: 0.0085, ar: 0.0034, sl: 0.03, sa: 55 - 15 * T, tp: 0.021 - 0.004 * T, tb: 0.008, dh: 0.0042 },
    L: { bx: 0.019 + 0.001 * i, bz: 0.0145, h: 0.024, canal: 0.0095, ar: 0.0045, sl: 0.026, sa: 8, tp: 0.03, tb: 0.002, dh: 0.0075 },
  }[kind];
  const { bx, bz, h, canal, ar, sl, sa, tp, tb } = dims;
  const kidney = (d) => [1, 1, d[2] < 0 ? 1 - 0.12 * Math.max(0, 1 - Math.abs(d[0]) * 2.2) : 1];
  bone(node, blob(P, [bx, h / 2, bz], { q, nu: 16, nv: 8, e: [1, 0.3, 1], shape: kidney, noise: NS, amp: 0.03, freq: 120, paint: IVORY }));
  m.add(node, blob(W([0, -(h / 2 + dims.dh / 2), 0.0004]), [bx * 0.97, dims.dh / 2 + 0.0004, bz * 0.95], { q, nu: 16, nv: 6, e: [1, 0.4, 1], shape: kidney, paint: CART }), M_CART);
  // Neural arch around the canal.
  const zb = -bz * 0.75;
  const zc = -bz - canal;
  const arch = [
    [-bx * 0.55, 0, zb],
    [-bx * 0.68, 0, -bz - canal * 0.45],
    [-canal * 0.55, 0.0005, zc],
    [0, 0.001, zc - canal * 0.1],
    [canal * 0.55, 0.0005, zc],
    [bx * 0.68, 0, -bz - canal * 0.45],
    [bx * 0.55, 0, zb],
  ].map(W);
  bone(node, limb(arch, 6, 12, ar, { paint: IVORY, cap: 0.05 }));
  // Spinous process (down and back), flattened knob at the tip.
  const sp0 = [0, 0.001, zc - canal * 0.05];
  const sp1 = [0, -sl * Math.sin(sa * deg), zc - canal * 0.1 - sl * Math.cos(sa * deg)];
  bone(node, limb([W(sp0), W(lerp3(sp0, sp1, 0.5)), W(sp1)], 6, 6, (t) => ar * (1.05 - 0.15 * t + 0.25 * smoothstep(0.75, 1, t)), { paint: IVORY }));
  // Transverse processes.
  for (const s of [-1, 1]) {
    const a = [s * bx * 0.7, 0.0015, -bz - canal * 0.4];
    const b = [s * (bx * 0.6 + tp), 0.002, -bz - canal * 0.45 - tb];
    bone(node, limb([W(a), W(lerp3(a, b, 0.5)), W(b)], 6, 6, (t) => ar * (0.95 + 0.25 * smoothstep(0.7, 1, t)), { paint: IVORY }));
  }
  return { P, up, fwd, q, bx, bz, h, canal, W, tipT: (s) => W([s * (bx * 0.6 + tp), 0.002, -bz - canal * 0.45 - tb]) };
}

function spine() {
  const kinds = [...Array(7).fill('C'), ...Array(12).fill('T'), ...Array(5).fill('L')];
  const step = kinds.map((k, i) => (k === 'C' ? 0.0175 : k === 'T' ? 0.0215 + 0.0045 * (i - 7) / 11 + 0.0042 : 0.0315));
  const total = step.reduce((a, b) => a + b, 0);
  const f = (SPINE_LEN - 0.012) / total;
  let sc = 0.004;
  kinds.forEach((kind, j) => {
    const centre = sc + (step[j] * f) / 2 - 0.002;
    sc += step[j] * f;
    const t = centre / SPINE_LEN;
    const p = spineCurve.getPointAt(t);
    const tg = spineCurve.getTangentAt(t);
    const up = norm([-tg.x, -tg.y, -tg.z]);
    const i = kind === 'C' ? j : kind === 'T' ? j - 7 : j - 19;
    LEVELS.push(vertebra(kind === 'C' ? 'Skel_Cervical' : 'Skel_Spine', kind, i, [p.x, p.y, p.z], up));
  });
}

/* ------------------------------------------------------- sternum and ribs */

const STERNUM = { top: [0, 1.398, 0.058], bottom: [0, 1.25, 0.098] };
const sternumAt = (t) => lerp3(STERNUM.top, STERNUM.bottom, t);

function sternum() {
  const S = 'Skel_Sternum';
  const ax = norm(sub(STERNUM.bottom, STERNUM.top));
  const q = basis([1, 0, 0], mul(ax, -1));
  // Manubrium (broad, jugular notch on top), body, xiphoid process.
  bone(S, blob(sternumAt(0.13), [0.026, 0.023, 0.0065], { q, nu: 20, nv: 12, e: [0.8, 0.8, 1], shape: (d) => [1 - 0.35 * Math.max(0, -d[1]), 1 - 0.12 * Math.exp(-((d[0] / 0.25) ** 2)) * Math.max(0, d[1]), 1], noise: NS, amp: 0.03, freq: 80, paint: IVORY }));
  bone(S, blob(sternumAt(0.6), [0.0165, 0.056, 0.0058], { q, nu: 18, nv: 20, e: [0.8, 0.9, 1], shape: (d) => [1 + 0.15 * Math.max(0, -d[1]) - 0.1 * Math.max(0, d[1]), 1, 1], noise: NS, amp: 0.03, freq: 80, paint: IVORY }));
  bone(S, blob(comb(STERNUM.bottom, [ax, 0.02]), [0.0085, 0.019, 0.004], { q, nu: 12, nv: 10, e: [0.9, 1, 1], shape: (d) => [1 - 0.5 * Math.max(0, -d[1]), 1, 1], paint: IVORY }));
}

function ribs() {
  const S = 'Skel_Ribs';
  //            a      b      drop   φend  sternal t
  const spec = [
    [0.058, 0.05, 0.03, 2.55, 0.08],
    [0.083, 0.068, 0.05, 2.5, 0.2],
    [0.1, 0.082, 0.064, 2.48, 0.33],
    [0.113, 0.091, 0.077, 2.46, 0.47],
    [0.122, 0.097, 0.089, 2.44, 0.6],
    [0.128, 0.1, 0.1, 2.42, 0.74],
    [0.132, 0.101, 0.112, 2.4, 0.88],
    [0.134, 0.1, 0.118, 2.3, null],
    [0.133, 0.097, 0.12, 2.22, null],
    [0.128, 0.093, 0.118, 2.12, null],
    [0.12, 0.088, 0.085, 1.7, null],
    [0.105, 0.082, 0.06, 1.25, null],
  ];
  for (const s of [-1, 1]) {
    const ends = [];
    spec.forEach(([a, b, drop, phiE, st], i) => {
      const L = LEVELS[7 + i];
      const head = comb(L.P, [[s, 0, 0], L.bx * 0.95], [L.fwd, -L.bz * 0.55]);
      const tub = L.tipT(s);
      const phi0 = Math.asin(clamp((Math.abs(tub[0]) + 0.012) / a, 0, 0.95));
      const zc = tub[2] - 0.012 + b * Math.cos(phi0);
      const y0 = tub[1] + 0.002;
      const pts = [head, add(tub, [0, 0.001, -0.004])];
      const n = 10;
      for (let k = 0; k <= n; k++) {
        const phi = lerp(phi0, phiE, k / n);
        const g = (phi - phi0) / (Math.PI - phi0);
        pts.push([s * a * Math.sin(phi), y0 - drop * g ** 1.35, zc - b * Math.cos(phi)]);
      }
      bone(S, limb(pts, 7, 30, (t) => (i === 0 ? 0.0062 : 0.0052) * (0.85 + 0.15 * smoothstep(0, 0.2, t)) * (i >= 10 ? 1 - 0.3 * smoothstep(0.7, 1, t) : 1), { paint: IVORY, cap: 0.03 }));
      const end = pts[pts.length - 1];
      const before = pts[pts.length - 2];
      ends.push({ end, dir: norm(sub(end, before)), st });
    });
    // Costal cartilage: true ribs to the sternum, 8–10 to the cartilage above, 11–12 short caps.
    const cartPts = [];
    ends.forEach(({ end, dir, st }, i) => {
      let pts;
      if (st !== null) {
        const att = add(sternumAt(st), [s * (i === 0 ? 0.022 : 0.015), 0, -0.002]);
        const mid = add(lerp3(comb(end, [dir, 0.02]), att, 0.5), [0, i > 2 ? -0.006 : 0, 0.004]);
        pts = [comb(end, [dir, -0.004]), comb(end, [dir, 0.014]), mid, att];
      } else if (i <= 9) {
        const prev = cartPts[i - 1];
        const target = prev(0.42 + 0.06 * (i - 7));
        pts = [comb(end, [dir, -0.004]), comb(end, [dir, 0.016]), add(lerp3(comb(end, [dir, 0.016]), target, 0.5), [0, -0.004, 0.004]), target];
      } else {
        pts = [comb(end, [dir, -0.004]), comb(end, [dir, 0.012])];
      }
      cartPts.push(spline(pts));
      m.add(S, limb(pts, 8, pts.length > 2 ? 16 : 4, (t) => 0.0048 * (1 - 0.15 * t), { paint: CART, cap: 0.08 }), M_CART);
    });
  }
}

/* ------------------------------------------------------- shoulder girdle */

const SHOULDER = (s) => [s * 0.177, 1.402, -0.03];

function girdle(s) {
  const side = s > 0 ? 'L' : 'R';
  // Clavicle: S-curve from the manubrium to the acromion.
  bone(
    `Skel_Clavicle_${side}`,
    limb([add(STERNUM.top, [s * 0.026, 0.006, -0.004]), [s * 0.06, 1.413, 0.07], [s * 0.11, 1.426, 0.045], [s * 0.15, 1.433, 0.0], [s * 0.172, 1.435, -0.025]], 10, 36, (t) => 0.0068 - 0.0016 * Math.sin(Math.PI * t) + 0.0018 * smoothstep(0.8, 1, t) + 0.0016 * (1 - smoothstep(0, 0.15, t)), { paint: IVORY }),
  );
  const S = `Skel_Scapula_${side}`;
  // Blade: triangle lateral angle (A) – superior angle (B) – inferior angle (C), curved to the ribs.
  const A = [s * 0.152, 1.398, -0.052];
  const B = [s * 0.072, 1.442, -0.098];
  const Cc = [s * 0.088, 1.27, -0.104];
  const P = (U, W) => {
    const u = (U + 1) / 2;
    const w = (W + 1) / 2;
    const edge = lerp3(B, Cc, w);
    const p = lerp3(A, edge, u);
    const bow = Math.sin(Math.PI * u) * Math.sin(Math.PI * w);
    return add(p, [s * 0.004 * bow, 0, -0.008 * bow * u]);
  };
  bone(
    S,
    sheet(
      30,
      26,
      P,
      (U, W) => {
        const u = (U + 1) / 2;
        const w = (W + 1) / 2;
        return 0.0022 + 0.009 * (1 - smoothstep(0, 0.35, u)) + 0.0025 * smoothstep(0.8, 1, w) * (1 - u) + 0.0018 * smoothstep(0.9, 1, u);
      },
      { paint: IVORY },
    ),
  );
  // Glenoid cavity (cartilage-lined cup facing the humeral head), neck, spine, acromion, coracoid.
  const J = SHOULDER(s);
  m.add(S, blob(add(J, [-s * 0.024, 0, -0.004]), [0.004, 0.019, 0.013], { q: basis([1, 0, 0.15 * s], [0, 1, 0]), nu: 14, nv: 10, e: [0.6, 1, 1], paint: CART }), M_CART);
  bone(S, blob(add(J, [-s * 0.031, -0.001, -0.008]), [0.008, 0.02, 0.014], { nu: 14, nv: 10, paint: IVORY }));
  bone(S, limb([[s * 0.075, 1.395, -0.103], [s * 0.11, 1.41, -0.095], [s * 0.145, 1.425, -0.075], [s * 0.168, 1.437, -0.045]], 8, 24, (t) => 0.0035 + 0.003 * smoothstep(0.5, 1, t), { paint: IVORY }));
  bone(S, blob([s * 0.175, 1.442, -0.032], [0.013, 0.005, 0.02], { q: basis([1, 0.15 * s, 0], [0, 1, 0]), nu: 16, nv: 10, e: [0.8, 0.7, 0.8], paint: IVORY }));
  bone(S, limb([add(J, [-s * 0.03, 0.018, -0.01]), add(J, [-s * 0.028, 0.025, 0.012]), add(J, [-s * 0.02, 0.016, 0.03])], 7, 12, (t) => 0.0048 - 0.0012 * t, { paint: IVORY }));
}

/* --------------------------------------------------------------- upper limb */

function arm(s) {
  const side = s > 0 ? 'L' : 'R';
  const J = SHOULDER(s);
  const aA = 12 * deg;
  const dA = norm([s * Math.sin(aA), -Math.cos(aA), 0.02]);
  const lA = norm([s * Math.cos(aA), Math.sin(aA), 0]);
  const E = comb(J, [dA, 0.305]);
  const aF = 19 * deg;
  const dF = norm([s * Math.sin(aF), -Math.cos(aF), 0.07]);
  const lF = norm([s * Math.cos(aF), Math.sin(aF), 0]);
  const Wr = comb(E, [dF, 0.248]);
  const fwd = [0, 0, 1];

  m.add(`Joint_Ball_Shoulder_${side}`, blob(J, [0.0235, 0.0235, 0.0235], { nu: 28, nv: 18, paint: JOINT }), M_JOINT);

  const H = `Skel_Humerus_${side}`;
  bone(H, limb([comb(J, [dA, 0.008], [lA, 0.012]), comb(J, [dA, 0.04], [lA, 0.008]), comb(J, [dA, 0.15], [lA, 0.002], [fwd, 0.002]), comb(E, [dA, -0.075]), comb(E, [dA, -0.012])], 18, 44, shaftR(0.019, 0.0105, 0.0135, 0.2, 0.25), { paint: IVORY }));
  bone(H, blob(comb(J, [lA, 0.017], [dA, 0.008], [fwd, 0.006]), [0.013, 0.017, 0.014], { nu: 16, nv: 12, noise: NS, amp: 0.05, freq: 60, paint: IVORY })); // greater tubercle
  bone(H, blob(comb(J, [lA, 0.006], [dA, 0.012], [fwd, 0.017]), [0.006, 0.009, 0.006], { nu: 10, nv: 8, paint: IVORY })); // lesser tubercle
  const qE = basis(lA, mul(dA, -1));
  bone(H, blob(comb(E, [dA, -0.014]), [0.027, 0.014, 0.011], { q: qE, nu: 20, nv: 12, e: [0.8, 1, 1], paint: IVORY })); // distal flare
  bone(H, blob(comb(E, [lA, -0.029], [dA, -0.012]), [0.008, 0.007, 0.007], { nu: 10, nv: 8, paint: IVORY })); // medial epicondyle
  bone(H, blob(comb(E, [lA, 0.024], [dA, -0.012]), [0.006, 0.007, 0.006], { nu: 10, nv: 8, paint: IVORY })); // lateral epicondyle
  // Elbow hinge: trochlea + capitulum as one cartilage roller across the joint.
  m.add(`Joint_Hinge_Elbow_${side}`, blob(E, [0.022, 0.0115, 0.0115], { q: qE, nu: 24, nv: 14, e: [0.3, 1, 1], shape: (d) => { const g = 1 - 0.14 * Math.exp(-(((d[0] + 0.25 * s) / 0.18) ** 2)); return [1, g, g]; }, paint: JOINT }), M_JOINT);

  // Ulna (medial): olecranon behind the trochlea, tapering to a small head.
  const U = `Skel_Ulna_${side}`;
  bone(U, limb([comb(E, [lF, -0.006], [dA, -0.02], [fwd, -0.016]), comb(E, [lF, -0.008], [dF, 0.012], [fwd, -0.01]), comb(E, [lF, -0.011], [dF, 0.07]), comb(E, [lF, -0.013], [dF, 0.16]), comb(Wr, [lF, -0.013], [dF, -0.006])], 12, 40, (t) => 0.0055 + 0.0065 * (1 - smoothstep(0, 0.3, t)) + 0.0015 * smoothstep(0.88, 1, t), { paint: IVORY }));
  bone(U, blob(comb(E, [lF, -0.006], [dF, 0.014], [fwd, 0.008]), [0.006, 0.005, 0.007], { nu: 10, nv: 8, paint: IVORY })); // coronoid
  bone(U, blob(comb(Wr, [lF, -0.016], [dF, 0.002], [fwd, -0.003]), [0.0035, 0.006, 0.0035], { nu: 8, nv: 6, paint: IVORY })); // styloid

  // Radius (lateral): disc-shaped head at the capitulum, broad distal end.
  const Rd = `Skel_Radius_${side}`;
  const qF = basis(lF, mul(dF, -1));
  bone(Rd, blob(comb(E, [lF, 0.014], [dF, 0.017]), [0.0105, 0.0048, 0.0105], { q: qF, nu: 16, nv: 8, e: [1, 0.45, 1], paint: IVORY }));
  bone(Rd, limb([comb(E, [lF, 0.014], [dF, 0.02]), comb(E, [lF, 0.016], [dF, 0.08], [fwd, 0.002]), comb(E, [lF, 0.021], [dF, 0.16], [fwd, 0.002]), comb(Wr, [lF, 0.013], [dF, -0.012])], 12, 36, (t) => 0.0055 + 0.0015 * Math.sin(Math.PI * t) + 0.004 * smoothstep(0.75, 1, t), { paint: IVORY }));
  bone(Rd, blob(comb(Wr, [lF, 0.008], [dF, -0.008]), [0.016, 0.008, 0.0095], { q: qF, nu: 16, nv: 10, e: [0.9, 0.8, 1], paint: IVORY }));
  bone(Rd, blob(comb(Wr, [lF, 0.022], [dF, -0.004]), [0.004, 0.007, 0.004], { q: qF, nu: 8, nv: 6, paint: IVORY })); // styloid

  // Hand (palm forward): carpals, metacarpals, phalanges, relaxed slight flexion.
  const Hd = `Skel_Hand_${side}`;
  const qH = basis(lF, mul(dF, -1));
  for (let row = 0; row < 2; row++)
    for (let col = 0; col < 4; col++) {
      const c = comb(Wr, [dF, 0.009 + row * 0.0135], [lF, -0.017 + col * 0.0112 + (row ? 0.0015 : 0)], [fwd, 0.002 * Math.sin(col)]);
      const r = [0.0062 + 0.0012 * R(), 0.0068 + 0.001 * R(), 0.0058 + 0.001 * R()];
      bone(Hd, blob(c, r, { q: qH, nu: 10, nv: 8, e: [0.85, 0.85, 0.85], noise: NS, amp: 0.08, freq: 150, paint: IVORY }));
    }
  const rays = [
    { off: 0.019, base: 0.022, spread: 40, palm: 30, len: [0.043, 0.031, 0.024], r: 0.0052 },
    { off: 0.011, base: 0.031, spread: 7, palm: 0, len: [0.066, 0.041, 0.025, 0.018], r: 0.0045 },
    { off: 0.0015, base: 0.032, spread: 0, palm: 0, len: [0.064, 0.045, 0.028, 0.019], r: 0.0046 },
    { off: -0.0075, base: 0.031, spread: -6, palm: 0, len: [0.058, 0.042, 0.026, 0.019], r: 0.0042 },
    { off: -0.016, base: 0.029, spread: -12, palm: 0, len: [0.053, 0.035, 0.02, 0.017], r: 0.0039 },
  ];
  rays.forEach((ray, k) => {
    let d = rotateTowards(dF, lF, ray.spread * deg);
    d = rotateTowards(d, fwd, ray.palm * deg);
    let p = comb(Wr, [dF, ray.base], [lF, ray.off], [fwd, k === 0 ? 0.008 : 0]);
    ray.len.forEach((L, j) => {
      const r0 = ray.r * (1 - 0.13 * j);
      const tip = j === ray.len.length - 1;
      const q = comb(p, [d, L]);
      bone(Hd, limb([p, lerp3(p, q, 0.5), q], 8, 10, (t) => r0 * (0.72 + 0.32 * (1 - smoothstep(0, 0.25, t)) + (tip ? -0.12 * smoothstep(0.6, 1, t) : 0.26 * smoothstep(0.75, 1, t))), { paint: IVORY, cap: 0.12 }));
      p = comb(q, [d, 0.0012]);
      d = rotateTowards(d, fwd, (k === 0 ? 10 : [8, 14, 12][j] ?? 10) * deg);
    });
  });
  return { J, E, Wr, dA, lA, dF, lF };
}

/* --------------------------------------------------------- pelvis, legs */

const HIP = (s) => [s * 0.088, 0.906, 0.006];

function pelvis() {
  const S = 'Skel_Pelvis';
  // Sacrum: curved triangular plate with sacral foramina.
  const ax = spline([
    [0, 0.979, -0.044],
    [0, 0.94, -0.066],
    [0, 0.9, -0.082],
    [0, 0.866, -0.084],
  ]);
  const P = (U, W) => {
    const t = (W + 1) / 2;
    const w = lerp(0.054, 0.012, t ** 0.85);
    const c = ax(t);
    return add(c, [U * w, 0.004 * (1 - t) * U * U, -0.006 * U * U * (1 - t)]);
  };
  bone(
    S,
    sheet(28, 28, P, (U, W) => lerp(0.017, 0.0045, (W + 1) / 2) * (1 - 0.35 * U * U), {
      paint: (p, n, U, W, cav) => {
        const t = (W + 1) / 2;
        let dark = 0;
        for (const tf of [0.18, 0.37, 0.56, 0.74]) for (const uf of [-0.42, 0.42]) dark = Math.max(dark, 1 - smoothstep(0.035, 0.07, Math.hypot((U - uf) * 0.45, t - tf)));
        return shade(IVORY(p, n, U, W, cav), 1 - 0.5 * dark);
      },
    }),
  );
  for (const s of [-1, 1]) {
    // Ilium: fan-shaped wing from the iliac crest down to the acetabulum, flaring outward.
    const crest = spline([
      [s * 0.04, 1.0, -0.086],
      [s * 0.088, 1.032, -0.076],
      [s * 0.13, 1.04, -0.034],
      [s * 0.138, 1.026, 0.018],
      [s * 0.116, 0.996, 0.054],
    ]);
    const low = spline([
      [s * 0.04, 0.938, -0.066],
      [s * 0.062, 0.925, -0.042],
      [s * 0.08, 0.922, -0.016],
      [s * 0.092, 0.928, 0.014],
      [s * 0.098, 0.94, 0.038],
    ]);
    const Pw = (U, W) => {
      const u = (U + 1) / 2;
      const w = (W + 1) / 2;
      const p = lerp3(crest(u), low(u), w);
      const bow = Math.sin(Math.PI * w) * Math.sin(Math.PI * clamp(u * 1.1));
      return add(p, [s * 0.012 * bow, -0.002 * bow, -0.004 * bow]);
    };
    bone(
      S,
      sheet(32, 22, Pw, (U, W) => {
        const w = (W + 1) / 2;
        return 0.0028 + 0.004 * (1 - smoothstep(0, 0.12, w)) + 0.008 * smoothstep(0.65, 1, w) + 0.004 * (1 - smoothstep(0, 0.2, (U + 1) / 2));
      }, { paint: IVORY }),
    );
    // Acetabulum: thick cup around the femoral head, opening laterally, forward and down.
    const J = HIP(s);
    const open = norm([s * 0.72, -0.38, 0.5]);
    bone(S, cup(J, open, 0.0335, 0.0262, 100 * deg, { nu: 40, nv: 30, paint: (p, n, u, v, cav) => (v > 0.6 ? CART(p, n, u, v, cav) : IVORY(p, n, u, v, cav)) }));
    // Pubis and ischium: ring around the obturator foramen.
    const ring = [
      [s * 0.09, 0.888, 0.03],
      [s * 0.058, 0.886, 0.054],
      [s * 0.03, 0.876, 0.061],
      [s * 0.011, 0.862, 0.06],
      [s * 0.014, 0.842, 0.054],
      [s * 0.032, 0.826, 0.038],
      [s * 0.055, 0.818, 0.016],
      [s * 0.074, 0.82, -0.008],
      [s * 0.084, 0.84, -0.022],
      [s * 0.088, 0.872, -0.02],
    ];
    bone(S, limb(ring, 10, 60, (t, a) => 0.0068 + 0.0035 * Math.exp(-(((t - 0.72) / 0.1) ** 2)) + 0.002 * Math.exp(-(((t - 0.32) / 0.08) ** 2)), { paint: IVORY, closed: true, cap: 0 }));
    bone(S, blob([s * 0.077, 0.827, -0.014], [0.012, 0.016, 0.012], { nu: 14, nv: 10, noise: NS, amp: 0.06, freq: 60, paint: IVORY })); // ischial tuberosity
    bone(S, blob([s * 0.04, 0.924, -0.083], [0.006, 0.012, 0.007], { nu: 10, nv: 8, paint: IVORY })); // posterior inferior iliac spine
  }
  // Pubic symphysis disc.
  m.add(S, blob([0, 0.86, 0.061], [0.0055, 0.014, 0.0065], { nu: 12, nv: 10, paint: CART }), M_CART);

  // Coccyx: four fused, shrinking segments curving forward.
  const co = spline([
    [0, 0.862, -0.082],
    [0, 0.846, -0.08],
    [0, 0.832, -0.073],
    [0, 0.82, -0.064],
  ]);
  for (let k = 0; k < 4; k++) {
    const r = 0.0085 - 0.0017 * k;
    const c = co(k / 3.3 + 0.08);
    bone('Skel_Coccyx', blob(c, [r, r * 0.55, r * 0.7], { nu: 12, nv: 8, e: [1, 0.7, 1], paint: IVORY }));
  }
}

function leg(s) {
  const side = s > 0 ? 'L' : 'R';
  const J = HIP(s);
  m.add(`Joint_Ball_Hip_${side}`, blob(J, [0.0245, 0.0245, 0.0245], { nu: 28, nv: 18, paint: JOINT }), M_JOINT);
  const Fm = `Skel_Femur_${side}`;
  const K = [s * 0.096, 0.486, -0.006];
  bone(Fm, limb([comb(J, [[s, -0.3, 0], 0.012]), [s * 0.113, 0.89, 0.002], [s * 0.13, 0.881, -0.002]], 14, 12, (t) => 0.0145 + 0.002 * t, { paint: IVORY })); // neck
  bone(Fm, limb([[s * 0.138, 0.892, -0.006], [s * 0.132, 0.8, 0.004], [s * 0.118, 0.68, 0.012], [s * 0.104, 0.575, 0.006], [s * 0.097, 0.512, -0.004]], 18, 52, shaftR(0.019, 0.0132, 0.024, 0.16, 0.2), { paint: IVORY }));
  bone(Fm, blob([s * 0.144, 0.892, -0.01], [0.016, 0.025, 0.02], { nu: 16, nv: 12, noise: NS, amp: 0.05, freq: 50, paint: IVORY })); // greater trochanter
  bone(Fm, blob([s * 0.113, 0.852, -0.017], [0.007, 0.009, 0.007], { nu: 10, nv: 8, paint: IVORY })); // lesser trochanter
  bone(Fm, blob([s * 0.096, 0.51, -0.006], [0.036, 0.018, 0.024], { nu: 20, nv: 12, paint: IVORY })); // epicondyles
  for (const k of [-1, 1]) bone(Fm, blob([s * 0.096 + k * 0.0205, 0.497, -0.01], [0.0155, 0.019, 0.027], { nu: 18, nv: 14, paint: IVORY })); // condyles
  m.add(`Joint_Hinge_Knee_${side}`, blob(K, [0.034, 0.012, 0.022], { nu: 28, nv: 14, e: [0.35, 1, 1], shape: (d) => { const g = 1 - 0.12 * Math.exp(-((d[0] / 0.2) ** 2)); return [1, g, g]; }, paint: JOINT }), M_JOINT);
  bone(`Skel_Patella_${side}`, blob([s * 0.097, 0.514, 0.031], [0.021, 0.025, 0.0095], { q: basis([1, 0, 0], [0, 1, -0.15]), nu: 18, nv: 14, shape: (d) => [1 + 0.18 * d[1], 1, 1 - 0.2 * Math.max(0, -d[2])], noise: NS, amp: 0.04, freq: 80, paint: IVORY }));

  const Tb = `Skel_Tibia_${side}`;
  bone(Tb, blob([s * 0.095, 0.463, -0.006], [0.037, 0.014, 0.027], { nu: 22, nv: 12, e: [1, 0.6, 1], noise: NS, amp: 0.03, freq: 60, paint: IVORY })); // plateau
  bone(Tb, limb([[s * 0.095, 0.462, -0.004], [s * 0.094, 0.4, 0.004], [s * 0.092, 0.25, 0.006], [s * 0.088, 0.12, 0.001], [s * 0.087, 0.08, -0.003]], 16, 52, shaftR(0.026, 0.0115, 0.017, 0.2, 0.15), { paint: IVORY }));
  bone(Tb, blob([s * 0.095, 0.425, 0.02], [0.008, 0.012, 0.007], { nu: 10, nv: 8, paint: IVORY })); // tuberosity
  bone(Tb, blob([s * 0.073, 0.07, -0.002], [0.007, 0.015, 0.009], { nu: 10, nv: 8, paint: IVORY })); // medial malleolus
  const Fb = `Skel_Fibula_${side}`;
  bone(Fb, blob([s * 0.126, 0.442, -0.022], [0.0085, 0.009, 0.0085], { nu: 12, nv: 8, paint: IVORY }));
  bone(Fb, limb([[s * 0.126, 0.44, -0.022], [s * 0.125, 0.3, -0.02], [s * 0.12, 0.13, -0.016], [s * 0.118, 0.07, -0.014]], 10, 44, shaftR(0.0068, 0.0052, 0.007), { paint: IVORY }));
  bone(Fb, blob([s * 0.12, 0.058, -0.014], [0.007, 0.016, 0.009], { nu: 10, nv: 8, paint: IVORY })); // lateral malleolus

  // Foot: tarsals, metatarsals, phalanges.
  const Ft = `Skel_Foot_${side}`;
  const tar = [
    [[s * 0.093, 0.062, 0.0], [0.017, 0.013, 0.025], [0, 0.05]], // talus
    [[s * 0.097, 0.03, -0.032], [0.015, 0.017, 0.035], [0, 0.3]], // calcaneus
    [[s * 0.082, 0.05, 0.034], [0.014, 0.009, 0.007], [0, 0]], // navicular
    [[s * 0.113, 0.032, 0.036], [0.011, 0.011, 0.014], [0, 0]], // cuboid
    [[s * 0.066, 0.045, 0.054], [0.006, 0.011, 0.01], [0, 0]], // cuneiforms
    [[s * 0.079, 0.048, 0.053], [0.0055, 0.01, 0.009], [0, 0]],
    [[s * 0.092, 0.045, 0.052], [0.006, 0.01, 0.009], [0, 0]],
  ];
  for (const [c, r, [, tilt]] of tar) bone(Ft, blob(c, r, { q: basis([1, 0, 0], [0, 1, -tilt]), nu: 14, nv: 10, e: [0.85, 0.85, 0.85], noise: NS, amp: 0.06, freq: 90, paint: IVORY }));
  const xb = [0.066, 0.079, 0.091, 0.102, 0.113];
  const yb = [0.042, 0.043, 0.039, 0.033, 0.027];
  const zb = [0.064, 0.066, 0.064, 0.058, 0.05];
  const xh = [0.062, 0.08, 0.094, 0.107, 0.12];
  const zh = [0.135, 0.136, 0.13, 0.121, 0.11];
  for (let k = 0; k < 5; k++) {
    const b = [s * xb[k], yb[k], zb[k]];
    const h = [s * xh[k], 0.015 - 0.001 * k, zh[k]];
    const r0 = k === 0 ? 0.0068 : 0.0038;
    bone(Ft, limb([b, lerp3(b, h, 0.5), h], 8, 14, (t) => r0 * (1 + 0.3 * (1 - smoothstep(0, 0.2, t)) + 0.3 * smoothstep(0.8, 1, t) - 0.12 * Math.sin(Math.PI * t)), { paint: IVORY, cap: 0.1 }));
    let d = norm([s * 0.05 * (k - 1), -0.1, 1]);
    let p = comb(h, [d, 0.003]);
    const lens = k === 0 ? [0.029, 0.024] : [0.026, 0.012, 0.011].map((L) => L * (1 - 0.07 * k));
    lens.forEach((L, j) => {
      const q = comb(p, [d, L]);
      const tip = j === lens.length - 1;
      const r1 = (k === 0 ? 0.0066 : 0.0042) * (1 - 0.1 * j);
      bone(Ft, limb([p, lerp3(p, q, 0.5), q], 8, 8, (t) => r1 * (0.8 + 0.25 * (1 - smoothstep(0, 0.25, t)) + (tip ? -0.15 * smoothstep(0.6, 1, t) : 0.2 * smoothstep(0.75, 1, t))), { paint: IVORY, cap: 0.12 }));
      p = comb(q, [d, 0.001]);
      d = norm(add(d, [0, j === 0 ? 0.05 : -0.15, 0]));
    });
  }
}

/* ------------------------------------------------------- muscles (right arm) */

function muscles(armR) {
  const { J, E, dA, lA, dF, lF } = armR;
  const fwd = [0, 0, 1];
  const back = [0, 0, -1];
  const muscle = (base = 356) => (p, n, t, a, cav) => {
    const fib = NB.n(a * 46, t * 3, 0.5);
    const tend = smoothstep(0.16, 0.05, t) + smoothstep(0.86, 0.97, t);
    const red = shade(hsl(base + 4 * fib, 0.62, 0.42 + 0.05 * fib), clamp(1 - 0.08 * cav, 0.7, 1.1));
    const white = hsl(40, 0.2, 0.86);
    const k = clamp(tend);
    return [red[0] + (white[0] - red[0]) * k, red[1] + (white[1] - red[1]) * k, red[2] + (white[2] - red[2]) * k];
  };
  const tendon = (p, n, t, a, cav) => shade(hsl(40, 0.2, 0.86), clamp(1 - 0.06 * cav, 0.8, 1.05));
  // Biceps brachii: two heads (long head over the humeral head, short head from the coracoid) into one belly.
  const B = 'Muscle_Biceps_R';
  const ins = comb(E, [dF, 0.03], [lF, 0.008], [fwd, 0.006]);
  const b0 = comb(J, [dA, 0.07], [fwd, 0.03]);
  m.add(B, limb([b0, comb(J, [dA, 0.13], [fwd, 0.037]), comb(J, [dA, 0.2], [fwd, 0.036]), comb(E, [dA, -0.035], [fwd, 0.026]), comb(E, [fwd, 0.016]), ins], 24, 44, (t, a) => 0.003 + 0.0175 * Math.sin(Math.PI * clamp((t - 0.02) / 0.9)) ** 1.6 * (1 + 0.08 * Math.cos(a * 2 * Math.PI)), { paint: muscle(), cap: 0.04 }), M_MUSCLE);
  m.add(B, limb([comb(J, [lA, -0.012], [dA, -0.02], [back, 0.002]), comb(J, [dA, -0.012], [fwd, 0.022]), comb(J, [dA, 0.03], [fwd, 0.03]), comb(b0, [dA, 0.02])], 8, 16, 0.0032, { paint: tendon }), M_MUSCLE);
  m.add(B, limb([comb(J, [lA, -0.03], [fwd, 0.035], [dA, -0.006]), comb(J, [lA, -0.014], [dA, 0.04], [fwd, 0.034]), comb(b0, [dA, 0.025], [lA, -0.004])], 8, 14, (t) => 0.004 + 0.006 * smoothstep(0.5, 1, t), { paint: tendon }), M_MUSCLE);
  // Triceps brachii: long head from below the glenoid, lateral head from the back of the humerus, to the olecranon.
  const T = 'Muscle_Triceps_R';
  const olec = comb(E, [dA, -0.022], [back, 0.02]);
  m.add(T, limb([comb(J, [lA, -0.03], [dA, 0.03], [back, 0.032]), comb(J, [dA, 0.09], [back, 0.04]), comb(J, [dA, 0.17], [back, 0.042]), comb(E, [dA, -0.07], [back, 0.034]), olec], 24, 44, (t, a) => 0.004 + 0.02 * Math.sin(Math.PI * clamp((t - 0.03) / 0.92)) ** 1.3 * (1 + 0.1 * Math.cos(a * 2 * Math.PI)), { paint: muscle(352), cap: 0.05 }), M_MUSCLE);
  m.add(T, limb([comb(J, [dA, 0.055], [lA, 0.016], [back, 0.02]), comb(J, [dA, 0.13], [lA, 0.017], [back, 0.03]), comb(E, [dA, -0.08], [lA, 0.012], [back, 0.03]), comb(olec, [dA, -0.02], [lA, 0.004])], 18, 32, (t) => 0.003 + 0.0125 * Math.sin(Math.PI * t) ** 1.2, { paint: muscle(352), cap: 0.06 }), M_MUSCLE);
}

/* ------------------------------------------------------------------ build */

skull();
spine();
sternum();
ribs();
const arms = {};
for (const s of [1, -1]) {
  girdle(s);
  arms[s] = arm(s);
}
pelvis();
for (const s of [1, -1]) leg(s);
muscles(arms[-1]);

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
