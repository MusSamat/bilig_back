#!/usr/bin/env node
/**
 * leaf.glb: a textbook block diagram of a leaf cross-section (dicot),
 * authored here with three.js geometry (our own work, CC0).
 *
 *   node leaf.mjs <out.glb> [report.json]
 *
 * No free (CC0 / CC BY / public domain) leaf cross-section model was found:
 * the ones that exist are paid marketplace models, login-gated templates or
 * physical teaching models.
 *
 * Layers, top to bottom (y up, the block spans x ±2.4, z ±1.3; the front
 * face z = +1.3 is the cut):
 *   Cuticle (wax, top and bottom) · Epidermis_Upper (flat irregular tabular
 *   cells, a Voronoi tiling) · Palisade_1…n (irregular columns with rounded
 *   ends, chloroplasts along their walls) · Spongy_1…n (lobed cells joined by
 *   their arms around air spaces) · Epidermis_Lower with stomata
 *   (GuardCell_*a/b, kidney-shaped, around Stoma_* = pore + substomatal air
 *   chamber) · Cuticle.
 * Every mesophyll cell has its chloroplasts in Chloro_<cell> and their grana
 * (thylakoid stacks, where chlorophyll sits) in Thylakoid_<cell>. The vein
 * (bundle sheath, xylem vessels with lignin rings, phloem sieve tubes and
 * companion cells) has no concept in the topic: decorative.
 * Node names follow the topic's masks; the stoma, chloroplast and mesophyll
 * anchors of the topic sit on real parts.
 * Colour is per vertex (COLOR_0): concept hue with per-cell and noise tone
 * variation, darkened in creases and towards cell bases (baked AO look).
 */
import { writeFileSync } from 'node:fs';
import { DoubleSide, FrontSide, Group, Mesh, MeshPhysicalMaterial, Vector3 } from 'three';
import { checkBudget, createIO, docTriangles, nodeTree, optimise } from './lib.mjs';
import { frame, hsl, makeNoise, merged, mix, pillow, placed, rng, shade, surface, toDocument, topicColours, tube } from './three-gltf.mjs';

const [outPath, reportPath] = process.argv.slice(2);
if (!outPath) {
  console.error('usage: node leaf.mjs <out.glb> [report.json]');
  process.exit(2);
}
const T = topicColours('photosynthesis', 'bio');

const MATS = new Map();
function mat(key, { o = 1, r = 0.5, cc = 0, ccr = 0.4, ds = false } = {}) {
  if (!MATS.has(key)) MATS.set(key, new MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: r, metalness: 0, transparent: o < 1, opacity: o, clearcoat: cc, clearcoatRoughness: ccr, side: ds ? DoubleSide : FrontSide }));
  return MATS.get(key);
}
const CELL = () => mat('cell', { r: 0.55, cc: 0.25, ccr: 0.5, ds: true });
const PLASTID = () => mat('plastid', { r: 0.4, cc: 0.5, ccr: 0.35 });
const EPI = () => mat('epidermis', { o: 0.5, r: 0.3, cc: 0.6, ccr: 0.25, ds: true });

function named(name, parent) {
  const g = new Group();
  g.name = name;
  parent.add(g);
  return g;
}
const add = (parent, geo, m) => {
  const o = new Mesh(geo, m);
  parent.add(o);
  return o;
};
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

const X = 2.4;
const Z = 1.3;
const Y_EPI = [0.8, 1.0];
const Y_PAL = [0.02, 0.78];
const Y_SPO = [-0.78, 0.0];
const STOMATA = [new Vector3(0.8, -0.9, 0.4), new Vector3(-0.85, -0.9, -0.55), new Vector3(1.95, -0.9, -0.75), new Vector3(-1.95, -0.9, 0.75)];
const VEIN = { x: -1.55, y: -0.38, r: 0.36 };

const hEpi = T.hue('Epidermis_Upper', 75);
const hMes = T.hue('Palisade_1', 110);
const hChl = T.hue('Chloro_1', 120);
const hThy = T.hue('Thylakoid_1', 130);
const hSto = T.hue('Stoma_1', 160);

/* ---------------------------------------------------------- 2D Voronoi */

/** Voronoi cells of `sites` (xz) inside the block's rectangle, each shrunk by `gap`. */
function voronoi(sites, gap) {
  const rect = [
    [-X, -Z],
    [X, -Z],
    [X, Z],
    [-X, Z],
  ];
  return sites.map((s, i) => {
    let poly = rect;
    for (let j = 0; j < sites.length; j++) {
      if (j === i) continue;
      const o = sites[j];
      const nx = o[0] - s[0];
      const nz = o[1] - s[1];
      const l = Math.hypot(nx, nz);
      if (l > 1.6) continue;
      const mx = (s[0] + o[0]) / 2 - (nx / l) * gap;
      const mz = (s[1] + o[1]) / 2 - (nz / l) * gap;
      const side = (p) => (p[0] - mx) * nx + (p[1] - mz) * nz;
      const out = [];
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k];
        const b = poly[(k + 1) % poly.length];
        const sa = side(a);
        const sb = side(b);
        if (sa <= 0) out.push(a);
        if (sa * sb < 0) {
          const t = sa / (sa - sb);
          out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
      }
      poly = out;
    }
    // Pull the outline in from the block's sides too (the cut face stays flush).
    const c = poly.reduce((m, p) => [m[0] + p[0] / poly.length, m[1] + p[1] / poly.length], [0, 0]);
    return { site: s, poly, c };
  });
}

/** Distance from c to the polygon boundary along angle th. */
function rayDist(poly, c, th) {
  const dx = Math.cos(th);
  const dz = Math.sin(th);
  let best = Infinity;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k];
    const b = poly[(k + 1) % poly.length];
    const ex = b[0] - a[0];
    const ez = b[1] - a[1];
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a[0] - c[0]) * ez - (a[1] - c[1]) * ex) / den;
    const s = ((a[0] - c[0]) * dz - (a[1] - c[1]) * dx) / den;
    if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.min(best, t);
  }
  return Number.isFinite(best) ? best : 0.05;
}

/**
 * A cell grown from a polygon footprint: superellipsoid profile (eh: side
 * roundness, ev: end roundness), y from y0 to y1, noise lumps; `lean` tilts
 * the column. Returns { geo, at(u, v) } — `at` gives surface points for
 * placing chloroplasts.
 */
function polyCell(cell, y0, y1, N, { eh = 0.3, ev = 0.4, nu = 18, nv = 10, lumps = 0.04, lean = [0, 0], shrink = 1, paint }) {
  const { poly, c } = cell;
  const rho = new Map();
  const R = (u) => {
    const k = Math.round(u * 1e6);
    if (!rho.has(k)) rho.set(k, rayDist(poly, c, u * Math.PI * 2) * shrink);
    return rho.get(k);
  };
  const at = (u, v) => {
    const th = u * Math.PI * 2;
    const ph = v * Math.PI;
    const hs = Math.abs(Math.sin(ph)) ** eh;
    const cv = Math.cos(ph);
    const vs = Math.sign(cv) * Math.abs(cv) ** ev;
    const r = R(u) * hs;
    let x = c[0] + Math.cos(th) * r;
    let z = c[1] + Math.sin(th) * r;
    let y = (y0 + y1) / 2 + (vs * (y1 - y0)) / 2;
    const k = 1 + lumps * N.fbm(x * 3, y * 3, z * 3, 2);
    x = c[0] + (x - c[0]) * k + lean[0] * vs;
    z = c[1] + (z - c[1]) * k + lean[1] * vs;
    return [Math.max(-X, Math.min(X, x)), y, Math.max(-Z, Math.min(Z, z))];
  };
  return { geo: surface(nu, nv, at, { paint }), at };
}

/* -------------------------------------------------------- chloroplasts */

const R0 = rng(5);
const NCh = makeNoise(77);
const chloroVariants = [0, 1, 2].map((k) =>
  surface(
    7,
    5,
    (u, v) => {
      const t = u * Math.PI * 2;
      const f = v * Math.PI;
      const d = [Math.sin(f) * Math.cos(t), Math.cos(f), Math.sin(f) * Math.sin(t)];
      const w = 1 + 0.08 * NCh.n(d[0] * 2 + k, d[1] * 2, d[2] * 2);
      // Lens: long along x, flat along z (the cell wall's normal).
      return [d[1] * 1.0 * w, d[2] * 0.72 * w, d[0] * 0.36 * w];
    },
    { paint: (p, n, u, v, c) => shade(hsl(hChl + 3 * k - 3, 0.62, 0.34 + 0.04 * k + 0.05 * p[2]), clamp(1 - 0.08 * c, 0.7, 1.1)) },
  ),
);
const granumGeo = pillow(4, 2, (U, V) => ({ p: [U * 0.32, V * 0.36, 0], n: [0, 0, 1] }), () => 0.07, { paint: (p, n, U, V, c, y) => hsl(hThy + 4, 0.62, 0.24 + 0.05 * Math.abs(y)) });

/** Chloroplasts set half into a cell wall at the given points, each with a granum (thylakoid stack) inside. */
function chloroplasts(id, spots, size) {
  const env = named(`Chloro_${id}`, root);
  const thy = named(`Thylakoid_${id}`, root);
  const e = [];
  const t = [];
  spots.forEach(({ p, n, up }, i) => {
    const q = frame(up, n);
    const s = size * (0.85 + R0() * 0.3);
    e.push(placed(chloroVariants[i % 3], { p, q, s }));
    const off = n.map((x) => x * s * 0.12);
    t.push(placed(granumGeo, { p: [p[0] + off[0], p[1] + off[1], p[2] + off[2]], q, s }));
  });
  add(env, merged(e), PLASTID());
  add(thy, merged(t), PLASTID());
}

/* ------------------------------------------------------------- build */

const root = new Group();
root.name = 'LeafSection';

/* cuticle (top and bottom), one concept node */
{
  const cut = named('Cuticle', root);
  const N = makeNoise(3);
  const slab = (y, seed) =>
    pillow(
      40,
      10,
      (U, V) => ({ p: [U * (X + 0.02), y + 0.006 * N.n(U * 6 + seed, V * 4, seed), V * (Z + 0.02)], n: [0, 1, 0] }),
      () => 0.022,
      { square: true, profile: 0.15, paint: (p) => hsl(hEpi - 10, 0.5, 0.78 + 0.04 * N.n(p[0] * 3, p[2] * 3, seed)) },
    );
  add(cut, merged([slab(1.03, 1), slab(-1.03, 2)]), mat('cuticle', { o: 0.4, r: 0.15, cc: 1, ccr: 0.1, ds: true }));
}

/* epidermis: flat irregular cells, gaps for stomata in the lower one */
function epidermis(name, y0, y1, seed, holes = []) {
  const g = named(name, root);
  const R = rng(seed);
  const N = makeNoise(seed);
  const sites = [];
  const nx = 10;
  const nz = 5;
  for (let i = 0; i < nx; i++)
    for (let k = 0; k < nz; k++) {
      const s = [-X + ((i + 0.5) * 2 * X) / nx + (R() - 0.5) * 0.3, -Z + ((k + 0.5) * 2 * Z) / nz + (R() - 0.5) * 0.3];
      if (holes.some((h) => Math.hypot(s[0] - h.x, s[1] - h.z) < 0.3)) continue;
      sites.push(s);
    }
  const all = [...sites, ...holes.map((h) => [h.x, h.z])];
  const cells = voronoi(all, 0.012).slice(0, sites.length);
  const parts = cells.map((cell, i) => {
    const hv = (R() - 0.5) * 8;
    const lv = (R() - 0.5) * 0.08;
    const top = y1 - R() * 0.03;
    return polyCell(cell, y0 + R() * 0.02, top, N, {
      eh: 0.22,
      ev: 0.5,
      nu: 12,
      nv: 4,
      lumps: 0.02,
      paint: (p, n, u, v, c) => shade(hsl(hEpi + hv, 0.42, 0.7 + lv), clamp(1 - 0.08 * c, 0.75, 1.1) * (0.85 + 0.15 * Math.abs(n[1]))),
    }).geo;
  });
  add(g, merged(parts), EPI());
}
epidermis('Epidermis_Upper', Y_EPI[0], Y_EPI[1], 11);
epidermis('Epidermis_Lower', -Y_EPI[1], -Y_EPI[0], 12, STOMATA);

/* palisade mesophyll: irregular columns, chloroplasts along their walls */
{
  const R = rng(21);
  const sites = [];
  const nx = 13;
  const nz = 6;
  for (let i = 0; i < nx; i++)
    for (let k = 0; k < nz; k++) sites.push([-X + ((i + 0.5) * 2 * X) / nx + (R() - 0.5) * 0.16, -Z + ((k + 0.5) * 2 * Z) / nz + (R() - 0.5) * 0.18]);
  const cells = voronoi(sites, 0.045);
  cells.forEach((cell, i) => {
    const id = i + 1;
    const N = makeNoise(200 + i);
    const g = named(`Palisade_${id}`, root);
    const hv = (R() - 0.5) * 10;
    const lv = (R() - 0.5) * 0.06;
    const y0 = Y_PAL[0] + R() * 0.08;
    const y1 = Y_PAL[1] - R() * 0.05;
    const pc = polyCell(cell, y0, y1, N, {
      eh: 0.42,
      ev: 0.5,
      nu: 14,
      nv: 8,
      lumps: 0.06,
      shrink: 0.92,
      lean: [(R() - 0.5) * 0.06, (R() - 0.5) * 0.06],
      paint: (p, n, u, v, c) => {
        const base = 0.7 + 0.3 * smooth(y0, y1, p[1]);
        return shade(hsl(hMes - 14 + hv, 0.48, 0.56 + lv + 0.04 * N.n(p[0] * 6, p[1] * 6, p[2] * 6)), base * clamp(1 - 0.08 * c, 0.75, 1.1));
      },
    });
    add(g, pc.geo, CELL());
    const spots = [];
    const n = 9;
    for (let j = 0; j < n; j++) {
      const u = (j + R() * 0.6) / n;
      const v = 0.2 + (((j * 5) % n) / n) * 0.6 + (R() - 0.5) * 0.04;
      const p = pc.at(u, v);
      const pu = pc.at(u, v + 0.01);
      const th = u * Math.PI * 2;
      const nrm = [Math.cos(th), 0, Math.sin(th)];
      spots.push({ p, n: nrm, up: [pu[0] - p[0], pu[1] - p[1], pu[2] - p[2]] });
    }
    chloroplasts(`P${id}`, spots, 0.058);
  });
}

/* spongy mesophyll: lobed cells reaching for their neighbours around air spaces */
{
  const R = rng(17);
  const pts = [];
  const ok = (p) =>
    Math.hypot(p.x - VEIN.x, p.y - VEIN.y) > VEIN.r + 0.2 &&
    !STOMATA.some((s) => Math.hypot(p.x - s.x, p.z - s.z) < 0.34 && p.y < -0.4) &&
    Math.abs(p.x) < X - 0.14 &&
    Math.abs(p.z) < Z - 0.12;
  let guard = 0;
  while (pts.length < 64 && guard++ < 20000) {
    const p = new Vector3((R() * 2 - 1) * X, Y_SPO[0] + 0.17 + R() * (Y_SPO[1] - Y_SPO[0] - 0.32), (R() * 2 - 1) * Z);
    if (!ok(p) || pts.some((q) => q.distanceTo(p) < 0.4)) continue;
    pts.push(p);
  }
  pts.forEach((p, i) => {
    const id = i + 1;
    const N = makeNoise(400 + i);
    const g = named(`Spongy_${id}`, root);
    const nb = pts
      .filter((q) => q !== p)
      .map((q) => ({ q, d: q.distanceTo(p) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 4)
      .filter((o) => o.d < 0.62);
    const arms = nb.map((o) => ({ dir: o.q.clone().sub(p).normalize(), len: o.d / 2 + 0.02 }));
    const r0 = 0.14 + R() * 0.03;
    const hv = (R() - 0.5) * 10;
    const radius = (d) => {
      let r = r0 * (1 + 0.12 * N.fbm(d.x * 2, d.y * 2, d.z * 2, 2));
      for (const a of arms) {
        const k = Math.max(0, d.dot(a.dir)) ** 6;
        r = Math.max(r, r0 * 0.6 + (a.len - r0 * 0.6) * k);
      }
      return r;
    };
    const d = new Vector3();
    const at = (u, v) => {
      const t = u * Math.PI * 2;
      const f = v * Math.PI;
      d.set(Math.sin(f) * Math.cos(t), Math.cos(f) * 0.8, Math.sin(f) * Math.sin(t)).normalize();
      const r = radius(d);
      return [p.x + d.x * r, Math.max(-0.8, Math.min(0.02, p.y + d.y * r * 0.85)), p.z + d.z * r];
    };
    const geo = surface(14, 8, at, {
      paint: (q, n, u, v, c) => {
        const dist = Math.hypot(q[0] - p.x, q[1] - p.y, q[2] - p.z) / r0;
        return shade(hsl(hMes - 18 + hv, 0.44, 0.6 + 0.04 * N.n(q[0] * 6, q[1] * 6, q[2] * 6)), clamp(1 - 0.1 * c, 0.7, 1.1) * (1 - 0.12 * smooth(1.2, 2.4, dist)));
      },
    });
    add(g, geo, CELL());
    const spots = [];
    for (let j = 0; j < 4; j++) {
      const u = (j + R() * 0.7) / 4;
      const v = 0.3 + R() * 0.4;
      const q = at(u, v);
      const q2 = at(u, v + 0.02);
      const nrm = [q[0] - p.x, (q[1] - p.y) * 1.2, q[2] - p.z];
      const l = Math.hypot(...nrm);
      spots.push({ p: q, n: nrm.map((x) => x / l), up: [q2[0] - q[0], q2[1] - q[1], q2[2] - q[2]] });
    }
    chloroplasts(`S${id}`, spots, 0.06);
  });
}

/* stomata: two kidney-shaped guard cells around a pore, substomatal air chamber above */
{
  const guardM = mat('guard', { r: 0.45, cc: 0.4, ccr: 0.35 });
  STOMATA.forEach((c, i) => {
    const id = i + 1;
    const N = makeNoise(600 + i);
    const st = named(`Stoma_${id}`, root);
    add(
      st,
      pillow(16, 6, (U, V) => ({ p: [c.x + U * 0.03, c.y - 0.03, c.z + V * 0.15], n: [0, 1, 0] }), () => 0.05, { paint: () => hsl(hSto - 20, 0.35, 0.12) }),
      mat('pore', { r: 0.8 }),
    );
    add(
      st,
      surface(20, 12, (u, v) => {
        const t = u * Math.PI * 2;
        const f = v * Math.PI;
        const k = 1 + 0.1 * N.fbm(Math.cos(t), Math.cos(f), Math.sin(t), 2);
        return [c.x + Math.sin(f) * Math.cos(t) * 0.26 * k, c.y + 0.3 + Math.cos(f) * 0.17 * k, c.z + Math.sin(f) * Math.sin(t) * 0.26 * k];
      }, { paint: () => hsl(hSto + 20, 0.3, 0.86) }),
      mat('chamber', { o: 0.18, r: 0.2, ds: true }),
    );
    for (const side of [-1, 1]) {
      const g = named(`GuardCell_${id}${side < 0 ? 'a' : 'b'}`, root);
      const pts = [];
      for (let k = 0; k <= 12; k++) {
        const a = -Math.PI / 2 + (k / 12) * Math.PI;
        pts.push(new Vector3(c.x + side * Math.cos(a) * 0.1, c.y - 0.01 + 0.012 * Math.cos(a), c.z + Math.sin(a) * 0.21));
      }
      const tb = tube(pts, 12, 24, (t) => 0.05 * (0.78 + 0.22 * Math.sin(Math.PI * t)), {
        cap: 0.18,
        paint: (p, n, t, a, cv) => shade(hsl(hSto - 4 + 6 * N.n(p[0] * 9, p[1] * 9, p[2] * 9), 0.5, 0.5), clamp(1 - 0.1 * cv, 0.7, 1.1)),
      });
      // A few chloroplasts in each guard cell (stomata are the epidermis's green cells).
      const dots = [0.3, 0.5, 0.7].map((t) => {
        const a = -Math.PI / 2 + t * Math.PI;
        return placed(chloroVariants[0], { p: [c.x + side * Math.cos(a) * 0.1, c.y - 0.06, c.z + Math.sin(a) * 0.21], q: frame([0, 0, 1], [0, -1, 0]), s: 0.028 });
      });
      add(g, merged([tb, ...dots]), guardM);
    }
  });
}

/* vein (vascular bundle) along z: decorative */
{
  const vein = new Group();
  vein.name = '';
  vein.position.set(VEIN.x, VEIN.y, 0);
  root.add(vein);
  const R = rng(31);
  const N = makeNoise(31);
  /** Thick-walled pipe along z, open at both ends (a vessel seen in section at the cut face). */
  const pipe = (x, y, r, wall, paintOut, paintIn, nAround = 14, nAlong = 10) => {
    const L = Z - 0.01;
    const b = 0.012;
    // v runs: outer wall back→front, front annulus, inner wall front→back, back annulus (a closed torus-like surface).
    const prof = [];
    for (let k = 0; k <= nAlong; k++) prof.push({ z: -L + b + ((2 * L - 2 * b) * k) / nAlong, r, side: 'out' });
    prof.push({ z: L, r: r - b, side: 'rim' }, { z: L, r: r - wall + b, side: 'rim' });
    for (let k = nAlong; k >= 0; k--) prof.push({ z: -L + b + ((2 * L - 2 * b) * k) / nAlong, r: r - wall, side: 'in' });
    prof.push({ z: -L, r: r - wall + b, side: 'rim' }, { z: -L, r: r - b, side: 'rim' }, { ...prof[0] });
    const nv = prof.length - 1;
    return surface(
      nAround,
      nv,
      (u, v) => {
        const q = prof[Math.round(v * nv)];
        const a = u * Math.PI * 2;
        const w = 1 + 0.05 * N.n(x * 9 + Math.cos(a), y * 9 + Math.sin(a), q.z * 0.6);
        return [x + Math.cos(a) * q.r * w, y + Math.sin(a) * q.r * w, q.z];
      },
      { paint: (p, n, u, v, c) => (prof[Math.round(v * nv)].side === 'in' ? paintIn(p) : paintOut(p, prof[Math.round(v * nv)].side)) },
    );
  };
  const parts = [];
  // Bundle sheath: a ring of pale parenchyma cells.
  for (let k = 0; k < 13; k++) {
    const a = (k / 13) * Math.PI * 2 + R() * 0.1;
    const rr = VEIN.r - 0.02;
    const cx = Math.cos(a) * rr;
    const cy = Math.sin(a) * rr * 0.95;
    const r = 0.075 + R() * 0.012;
    parts.push(
      tube([new Vector3(cx, cy, -Z + 0.01), new Vector3(cx, cy, 0), new Vector3(cx, cy, Z - 0.01)], 10, 14, () => r, {
        cap: 0.03,
        paint: (p, n, t, aa, c) => shade(hsl(68, 0.42, 0.68 + 0.04 * N.n(p[0] * 7, p[1] * 7, p[2])), clamp(1 - 0.1 * c, 0.75, 1.05)),
      }),
    );
  }
  // Xylem (upper side): wide vessels, lignified walls with ring thickenings inside.
  const xyl = [
    [-0.13, 0.12, 0.07],
    [0.04, 0.17, 0.08],
    [0.18, 0.08, 0.058],
    [-0.03, 0.0, 0.055],
    [-0.19, -0.01, 0.045],
    [0.13, -0.05, 0.045],
  ];
  for (const [x, y, r] of xyl)
    parts.push(
      pipe(
        x,
        y,
        r,
        r * 0.28,
        (p, side) => (side === 'rim' ? hsl(222, 0.55, 0.55) : hsl(224, 0.5, 0.48 + 0.04 * N.n(p[0] * 9, p[1] * 9, p[2] * 2))),
        (p) => shade(hsl(226, 0.48, 0.34), 0.8),
      ),
    );
  // Phloem (lower side): sieve tubes and small dense companion cells.
  for (const [x, y] of [[-0.15, -0.17], [-0.03, -0.21], [0.1, -0.18], [-0.08, -0.08], [0.21, -0.12]])
    parts.push(pipe(x, y, 0.042, 0.009, () => hsl(28, 0.62, 0.55), () => shade(hsl(32, 0.55, 0.42), 0.85), 12, 8));
  for (const [x, y] of [[-0.09, -0.22], [0.04, -0.25], [0.16, -0.23], [-0.2, -0.1], [0.02, -0.12]])
    parts.push(
      tube([new Vector3(x, y, -Z + 0.01), new Vector3(x, y, Z - 0.01)], 8, 8, () => 0.02, {
        cap: 0.01,
        paint: (p, n, t, a, c) => hsl(16, 0.55, 0.42),
      }),
    );
  add(vein, merged(parts), mat('vein', { r: 0.5, cc: 0.3, ccr: 0.4, ds: true }));
}

const doc = toDocument(root);
const io = await createIO();
const before = (await io.writeBinary(doc)).byteLength;
await optimise(doc, { ratio: 1 });
const glb = await io.writeBinary(doc);
const tris = docTriangles(doc);
checkBudget(outPath, glb.byteLength, tris);
writeFileSync(outPath, glb);
const nodes = nodeTree(doc).filter((l) => !/^\s*(\[\d+\])?$/.test(l) && !/_Mesh/.test(l) && !/^\s{4,}/.test(l));
if (reportPath) writeFileSync(reportPath, JSON.stringify({ sizeBefore: before, sizeAfter: glb.byteLength, trianglesAfter: tris, textures: 0, nodes }, null, 2) + '\n');
console.log(`${outPath}: ${glb.byteLength} bytes, ${tris} triangles`);
