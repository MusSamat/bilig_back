/**
 * Geometry kit for authored landscape dioramas (glaciers, water-cycle): a
 * height-field block with strata walls and a section cap, clipped surfaces
 * (marching triangles, so ice margins, lake shores and zone boundaries follow
 * their contour instead of the grid), ribbons draped on the ground (rivers,
 * streams, dashed lines), tubes (moraine ridges, arrows), blobs (clouds,
 * boulders) and cones (trees). Everything is plain arrays written straight
 * into a glTF-Transform Document with vertex colours (COLOR_0), so one
 * material per part is enough and the files stay small.
 *
 * Section mode in the client clips z > 0 (plane through the model centre, z ≤ 0
 * kept). Section caps are therefore vertical faces at z = CAP_Z facing +z:
 * hidden inside their volumes in «whole» view, exposed in «section».
 */
import { Document } from '@gltf-transform/core';

export const CAP_Z = -0.004;

// --- scalar helpers ---------------------------------------------------------------------------
export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

// --- colour (sRGB hex in, linear RGB out: glTF COLOR_0 and baseColorFactor are linear) --------
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const rgb = (hex) => [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
export const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * clamp(t));
export const shade = (c, k) => c.map((v) => clamp(v * k));

// --- deterministic noise ----------------------------------------------------------------------
export function makeNoise(seed = 1) {
  const hash = (i, j) => {
    let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 982451653)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  const n2 = (x, z) => {
    const i = Math.floor(x);
    const j = Math.floor(z);
    const fx = x - i;
    const fz = z - j;
    const u = fx * fx * (3 - 2 * fx);
    const v = fz * fz * (3 - 2 * fz);
    return lerp(lerp(hash(i, j), hash(i + 1, j), u), lerp(hash(i, j + 1), hash(i + 1, j + 1), u), v) * 2 - 1;
  };
  /** Fractal value noise in [-1, 1]. */
  const fbm = (x, z, oct = 4) => {
    let s = 0;
    let a = 0.5;
    let f = 1;
    let n = 0;
    for (let o = 0; o < oct; o++) {
      s += a * n2(x * f + o * 17.3, z * f - o * 9.1);
      n += a;
      a *= 0.5;
      f *= 2.03;
    }
    return s / n;
  };
  /** Ridged noise in [0, 1]: sharp crests, for mountain chains. */
  const ridged = (x, z, oct = 4) => {
    let s = 0;
    let a = 0.5;
    let f = 1;
    let n = 0;
    for (let o = 0; o < oct; o++) {
      const r = 1 - Math.abs(n2(x * f + o * 31.7, z * f + o * 12.9));
      s += a * r * r;
      n += a;
      a *= 0.5;
      f *= 2.1;
    }
    return s / n;
  };
  return { n2, fbm, ridged, rand: (i, j = 0) => hash(i, j) };
}

// --- polylines --------------------------------------------------------------------------------
const dist2 = (a, b) => a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0);

/** Uniform Catmull-Rom through `pts` (2D or 3D), resampled at about `step`. */
export function spline(pts, step) {
  if (pts.length < 2) return pts.map((p) => [...p]);
  const out = [];
  const P = [pts[0], ...pts, pts[pts.length - 1]];
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    const n = Math.max(1, Math.ceil(Math.sqrt(dist2(p1, p2)) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push(
        p1.map((_, d) => 0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3)),
      );
    }
  }
  out.push([...pts[pts.length - 1]]);
  return out;
}

/** Nearest point of a dense 2D polyline: { d, i, t } (t = arc-length fraction). */
export function nearestOnPath(path, x, z) {
  let best = { d: Infinity, i: 0 };
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, az] = path[i];
    const [bx, bz] = path[i + 1];
    const vx = bx - ax;
    const vz = bz - az;
    const t = clamp(((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz || 1));
    const d = Math.hypot(x - (ax + t * vx), z - (az + t * vz));
    if (d < best.d) best = { d, i: i + t };
  }
  return { d: best.d, i: best.i, t: best.i / Math.max(1, path.length - 1) };
}

/** Chain unordered segments [[p, q], …] (2D) into polylines. */
export function chain(segments, eps = 1e-4) {
  const key = (p) => `${Math.round(p[0] / eps)},${Math.round(p[1] / eps)}`;
  const ends = new Map();
  const used = new Array(segments.length).fill(false);
  segments.forEach(([p, q], i) => {
    for (const e of [p, q]) {
      const k = key(e);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push(i);
    }
  });
  const lines = [];
  for (let s = 0; s < segments.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    const line = [segments[s][0], segments[s][1]];
    for (const dir of [1, -1]) {
      for (;;) {
        const end = dir === 1 ? line[line.length - 1] : line[0];
        const next = (ends.get(key(end)) ?? []).find((i) => !used[i]);
        if (next === undefined) break;
        used[next] = true;
        const [p, q] = segments[next];
        const other = key(p) === key(end) ? q : p;
        if (dir === 1) line.push(other);
        else line.unshift(other);
      }
    }
    lines.push(line);
  }
  return lines;
}

// --- geometry buffer --------------------------------------------------------------------------
export class Geo {
  constructor() {
    this.P = [];
    this.N = [];
    this.C = [];
    this.UV = [];
    this.I = [];
  }
  get count() {
    return this.P.length / 3;
  }
  v(p, n, c = [1, 1, 1], uv = null) {
    this.P.push(p[0], p[1], p[2]);
    this.N.push(n[0], n[1], n[2]);
    this.C.push(c[0], c[1], c[2]);
    if (uv) this.UV.push(uv[0], uv[1]);
    return this.count - 1;
  }
  /** Triangle wound so its face normal points along `n`. */
  tri(a, b, c, n) {
    const P = this.P;
    const ux = P[3 * b] - P[3 * a];
    const uy = P[3 * b + 1] - P[3 * a + 1];
    const uz = P[3 * b + 2] - P[3 * a + 2];
    const vx = P[3 * c] - P[3 * a];
    const vy = P[3 * c + 1] - P[3 * a + 1];
    const vz = P[3 * c + 2] - P[3 * a + 2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-14) return;
    if (cx * n[0] + cy * n[1] + cz * n[2] >= 0) this.I.push(a, b, c);
    else this.I.push(a, c, b);
  }
  quad(a, b, c, d, n) {
    this.tri(a, b, c, n);
    this.tri(a, c, d, n);
  }
  append(g) {
    const off = this.count;
    for (const k of ['P', 'N', 'C', 'UV']) for (const v of g[k]) this[k].push(v);
    for (const i of g.I) this.I.push(i + off);
    return this;
  }
  get triangles() {
    return this.I.length / 3;
  }
  /** Smooth (area-weighted) normals for vertices from `from` on. */
  smoothNormals(from = 0) {
    const n = new Float64Array(this.P.length);
    for (let t = 0; t < this.I.length; t += 3) {
      const [a, b, c] = [this.I[t], this.I[t + 1], this.I[t + 2]];
      if (a < from) continue;
      const P = this.P;
      const ux = P[3 * b] - P[3 * a];
      const uy = P[3 * b + 1] - P[3 * a + 1];
      const uz = P[3 * b + 2] - P[3 * a + 2];
      const vx = P[3 * c] - P[3 * a];
      const vy = P[3 * c + 1] - P[3 * a + 1];
      const vz = P[3 * c + 2] - P[3 * a + 2];
      const f = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      for (const i of [a, b, c]) for (let d = 0; d < 3; d++) n[3 * i + d] += f[d];
    }
    for (let i = from; i < this.count; i++) {
      const l = Math.hypot(n[3 * i], n[3 * i + 1], n[3 * i + 2]) || 1;
      for (let d = 0; d < 3; d++) this.N[3 * i + d] = n[3 * i + d] / l;
    }
    return this;
  }
}

// --- height fields ----------------------------------------------------------------------------
/** Normal of y = h(x, z) by central differences. */
export const fieldNormal = (h, e = 0.01) => (x, z) => {
  const dx = (h(x + e, z) - h(x - e, z)) / (2 * e);
  const dz = (h(x, z + e) - h(x, z - e)) / (2 * e);
  const l = Math.hypot(dx, 1, dz);
  return [-dx / l, 1 / l, -dz / l];
};

/**
 * Grid triangles over [x0,x1]×[z0,z1] (two per cell). `visit(corners)` gets
 * three {x, z, f} corners per triangle, f = phi at the corner (or 1).
 */
function forEachTriangle({ x0, x1, z0, z1, step, phi }, visit) {
  const nx = Math.round((x1 - x0) / step);
  const nz = Math.round((z1 - z0) / step);
  const F = new Float64Array((nx + 1) * (nz + 1));
  const X = (i) => x0 + ((x1 - x0) * i) / nx;
  const Z = (j) => z0 + ((z1 - z0) * j) / nz;
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) F[j * (nx + 1) + i] = phi ? phi(X(i), Z(j)) : 1;
  const c = (i, j) => ({ x: X(i), z: Z(j), f: F[j * (nx + 1) + i], id: j * (nx + 1) + i });
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      // alternate the diagonal so the mesh has no directional bias
      const flip = (i + j) % 2 === 1;
      const [a, b, cc, d] = [c(i, j), c(i + 1, j), c(i + 1, j + 1), c(i, j + 1)];
      if (flip) {
        visit([a, b, d]);
        visit([b, cc, d]);
      } else {
        visit([a, b, cc]);
        visit([a, cc, d]);
      }
    }
}

const crossing = (p, q) => {
  const t = p.f / (p.f - q.f);
  return { x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t, f: 0, id: null, edge: [p.id, q.id].sort((a, b) => a - b).join('-') };
};

/**
 * Surface y = h(x, z) kept where phi(x, z) ≥ 0, clipped exactly on phi = 0
 * (marching triangles). Returns { geo, boundary } where boundary holds the
 * [[x,z],[x,z]] segments of the cut.
 */
export function surface({ x0, x1, z0, z1, step, h, phi = null, color, normal = null, lift = 0 }) {
  const g = new Geo();
  const nrm = normal ?? fieldNormal(h, step * 0.5);
  const cache = new Map();
  const vert = (p) => {
    const k = p.id ?? p.edge;
    if (cache.has(k)) return cache.get(k);
    const y = h(p.x, p.z) + lift;
    const n = nrm(p.x, p.z);
    const i = g.v([p.x, y, p.z], n, color ? color(p.x, y, p.z, n) : [1, 1, 1]);
    cache.set(k, i);
    return i;
  };
  const boundary = [];
  const up = [0, 1, 0];
  forEachTriangle({ x0, x1, z0, z1, step, phi }, (tri) => {
    const inside = tri.map((p) => p.f >= 0);
    if (inside.every((v) => !v)) return;
    if (inside.every(Boolean)) {
      g.tri(vert(tri[0]), vert(tri[1]), vert(tri[2]), up);
      return;
    }
    const poly = [];
    const cut = [];
    for (let k = 0; k < 3; k++) {
      const p = tri[k];
      const q = tri[(k + 1) % 3];
      if (p.f >= 0) poly.push(p);
      if (p.f >= 0 !== q.f >= 0) {
        const c = crossing(p, q);
        poly.push(c);
        cut.push(c);
      }
    }
    const idx = poly.map(vert);
    for (let k = 1; k < idx.length - 1; k++) g.tri(idx[0], idx[k], idx[k + 1], up);
    if (cut.length === 2) boundary.push([
      [cut[0].x, cut[0].z],
      [cut[1].x, cut[1].z],
    ]);
  });
  return { geo: g, boundary };
}

/** Segments of the contour fn = 0 inside mask ≥ 0 (same triangulation as `surface`). */
export function contour({ x0, x1, z0, z1, step, fn, mask = null }) {
  const segs = [];
  forEachTriangle({ x0, x1, z0, z1, step, phi: fn }, (tri) => {
    const ins = tri.map((p) => p.f >= 0);
    if (ins.every(Boolean) || ins.every((v) => !v)) return;
    const cut = [];
    for (let k = 0; k < 3; k++) {
      const p = tri[k];
      const q = tri[(k + 1) % 3];
      if (p.f >= 0 !== q.f >= 0) cut.push(crossing(p, q));
    }
    if (cut.length !== 2) return;
    // the mask must hold on the whole triangle, so contours stop short of the mask edge
    if (mask && tri.some((p) => mask(p.x, p.z) < 0)) return;
    segs.push([
      [cut[0].x, cut[0].z],
      [cut[1].x, cut[1].z],
    ]);
  });
  return segs;
}

/**
 * Vertical curtain along boundary segments, from top(x,z) down to bottom(x,z),
 * facing away from phi (outward = towards phi < 0). Ice cliffs, margins.
 */
export function curtain(segments, { top, bottom, phi, cTop, cBottom }) {
  const g = new Geo();
  for (const [p, q] of segments) {
    const mx = (p[0] + q[0]) / 2;
    const mz = (p[1] + q[1]) / 2;
    let n = [-(q[1] - p[1]), 0, q[0] - p[0]];
    const l = Math.hypot(n[0], n[2]) || 1;
    n = [n[0] / l, 0, n[2] / l];
    if (phi(mx + n[0] * 0.01, mz + n[2] * 0.01) > phi(mx, mz)) n = [-n[0], 0, -n[2]];
    const ct = (x, z) => (typeof cTop === 'function' ? cTop(x, z) : cTop);
    const cb = (x, z) => (typeof cBottom === 'function' ? cBottom(x, z) : cBottom);
    const a = g.v([p[0], bottom(p[0], p[1]), p[1]], n, cb(p[0], p[1]));
    const b = g.v([q[0], bottom(q[0], q[1]), q[1]], n, cb(q[0], q[1]));
    const c = g.v([q[0], top(q[0], q[1]), q[1]], n, ct(q[0], q[1]));
    const d = g.v([p[0], top(p[0], p[1]), p[1]], n, ct(p[0], p[1]));
    g.quad(a, b, c, d, n);
  }
  return g;
}

/**
 * Banded vertical wall along a 2D path (diorama sides, section caps).
 * bandsAt(x, z) → [{ top, bottom, cTop, cBottom? }] with the same band count
 * at every column; empty bands (top ≤ bottom) are skipped.
 */
export function bandWall(path, bandsAt, normal) {
  const g = new Geo();
  const cols = path.map(([x, z]) => bandsAt(x, z));
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, az] = path[i];
    const [bx, bz] = path[i + 1];
    for (let k = 0; k < cols[i].length; k++) {
      const A = cols[i][k];
      const B = cols[i + 1][k];
      if (A.top - A.bottom < 1e-5 && B.top - B.bottom < 1e-5) continue;
      const a = g.v([ax, A.bottom, az], normal, A.cBottom ?? A.cTop);
      const b = g.v([bx, B.bottom, bz], normal, B.cBottom ?? B.cTop);
      const c = g.v([bx, B.top, bz], normal, B.cTop);
      const d = g.v([ax, A.top, az], normal, A.cTop);
      g.quad(a, b, c, d, normal);
    }
  }
  return g;
}

/** Evenly spaced points from a to b (inclusive), 2D. */
export const line = (a, b, step) => {
  const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
  return Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
};

/**
 * Horizontal strata between `base` and `top`: `layers` = [{ to: y, color }]
 * bottom-up, plus a skin of `skin` thickness coloured `skinColor(x, z)` under
 * the surface. Returns a bandsAt function for bandWall.
 */
export function strata({ base, top, layers, skin = 0.035, skinColor }) {
  return (x, z) => {
    const t = top(x, z);
    const under = t - skin;
    const bands = [];
    let from = base;
    for (const L of layers) {
      const b = Math.max(base, Math.min(from, under));
      const tt = Math.max(b, Math.min(L.to, under));
      // `skip` leaves the band empty: another node draws it (an aquifer)
      bands.push({ bottom: b, top: L.skip ? b : tt, cTop: L.color ?? [0, 0, 0] });
      from = L.to;
    }
    const sk = skinColor(x, z);
    bands.push({ bottom: Math.max(base, under), top: Math.max(base, t), cTop: sk, cBottom: shade(sk, 0.8) });
    return bands;
  };
}

// --- tubes, ribbons, blobs, cones -------------------------------------------------------------
const sub = (a, b) => a.map((v, i) => v - b[i]);
const add = (a, b) => a.map((v, i) => v + b[i]);
const scale = (a, k) => a.map((v) => v * k);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => scale(a, 1 / (Math.hypot(...a) || 1));

/**
 * Tube along a 3D path (parallel-transport frames). radius(t) and color(t)
 * may be functions of the arc fraction t; `flatten` squashes the vertical
 * axis (ridges half sunk into the ground).
 */
export function tube(pts, { radius, color, segs = 8, capEnd = false, capStart = false, flatten = 1 }) {
  const g = new Geo();
  const R = typeof radius === 'function' ? radius : () => radius;
  const Cf = typeof color === 'function' ? color : () => color;
  const n = pts.length;
  const T = pts.map((p, i) => norm(sub(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)])));
  let N0 = Math.abs(T[0][1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  N0 = norm(sub(N0, scale(T[0], dot(N0, T[0]))));
  const rings = [];
  let Nv = N0;
  for (let i = 0; i < n; i++) {
    Nv = norm(sub(Nv, scale(T[i], dot(Nv, T[i]))));
    const B = cross3(T[i], Nv);
    const t = i / Math.max(1, n - 1);
    const r = R(t, i);
    const c = Cf(t, i);
    const ring = [];
    for (let k = 0; k < segs; k++) {
      const a = (2 * Math.PI * k) / segs;
      let dir = add(scale(Nv, Math.cos(a)), scale(B, Math.sin(a)));
      const off = [dir[0] * r, dir[1] * r * flatten, dir[2] * r];
      if (flatten !== 1) dir = norm([dir[0] * flatten, dir[1], dir[2] * flatten]);
      ring.push(g.v(add(pts[i], off), dir, c));
    }
    rings.push(ring);
  }
  for (let i = 0; i < n - 1; i++)
    for (let k = 0; k < segs; k++) {
      const a = rings[i][k];
      const b = rings[i + 1][k];
      const c = rings[i + 1][(k + 1) % segs];
      const d = rings[i][(k + 1) % segs];
      const nn = g.N.slice(3 * a, 3 * a + 3);
      g.quad(a, b, c, d, nn);
    }
  const cap = (i, sign) => {
    const nn = scale(T[i], sign);
    const centre = g.v(pts[i], nn, Cf(i / Math.max(1, n - 1), i));
    for (let k = 0; k < segs; k++) {
      const a = g.v(g.P.slice(3 * rings[i][k], 3 * rings[i][k] + 3), nn, Cf(i / (n - 1), i));
      const b = g.v(g.P.slice(3 * rings[i][(k + 1) % segs], 3 * rings[i][(k + 1) % segs] + 3), nn, Cf(i / (n - 1), i));
      g.tri(centre, a, b, nn);
    }
  };
  if (capStart) cap(0, -1);
  if (capEnd) cap(n - 1, 1);
  return g;
}

/** Cone from `base` along `dir` (unit) — tree crowns, arrow heads. */
export function cone(base, { radius, height, color, segs = 8, dir = [0, 1, 0], baseCap = false }) {
  const g = new Geo();
  const D = norm(dir);
  let U = Math.abs(D[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  U = norm(sub(U, scale(D, dot(U, D))));
  const V = cross3(D, U);
  const apex = add(base, scale(D, height));
  const slope = radius / height;
  const ring = [];
  for (let k = 0; k <= segs; k++) {
    const a = (2 * Math.PI * k) / segs;
    const radial = add(scale(U, Math.cos(a)), scale(V, Math.sin(a)));
    const nn = norm(add(radial, scale(D, slope)));
    ring.push({ p: add(base, scale(radial, radius)), n: nn });
  }
  for (let k = 0; k < segs; k++) {
    const a = g.v(ring[k].p, ring[k].n, color);
    const b = g.v(ring[k + 1].p, ring[k + 1].n, color);
    const mid = norm(add(ring[k].n, ring[k + 1].n));
    const c = g.v(apex, mid, color);
    g.tri(a, b, c, mid);
  }
  if (baseCap) {
    const nn = scale(D, -1);
    const c0 = g.v(base, nn, color);
    for (let k = 0; k < segs; k++) g.tri(c0, g.v(ring[k + 1].p, nn, color), g.v(ring[k].p, nn, color), nn);
  }
  return g;
}

/** Arrow along a 3D path: tube shaft + cone head at the end. */
export function arrow(pts, { radius, head = 3, headLength = 6, color, segs = 8 }) {
  const n = pts.length;
  const end = pts[n - 1];
  const dir = norm(sub(end, pts[n - 2]));
  const hl = radius * headLength;
  // shorten the shaft so the head starts where it ends
  const shaft = [];
  let remaining = hl;
  const rev = [...pts].reverse();
  let cut = end;
  for (let i = 0; i < rev.length - 1; i++) {
    const seg = Math.hypot(...sub(rev[i], rev[i + 1]));
    if (seg >= remaining) {
      cut = add(rev[i], scale(norm(sub(rev[i + 1], rev[i])), remaining));
      shaft.push(...pts.slice(0, n - 1 - i), cut);
      break;
    }
    remaining -= seg;
  }
  const g = tube(shaft.length > 1 ? shaft : [pts[0], cut], { radius, color, segs, capStart: true });
  g.append(cone(cut, { radius: radius * head, height: hl, color, segs, dir, baseCap: true }));
  return g;
}

/**
 * Ribbon draped on y(x, z) along a dense 2D path; width(t) may be a function.
 * `dashes` = [on, off] in samples makes a dashed line.
 */
export function ribbon(path, { width, y, color, normal = () => [0, 1, 0], dashes = null }) {
  const g = new Geo();
  const W = typeof width === 'function' ? width : () => width;
  const Cf = typeof color === 'function' ? color : () => color;
  const n = path.length;
  const L = [];
  const R = [];
  for (let i = 0; i < n; i++) {
    const p = path[Math.max(0, i - 1)];
    const q = path[Math.min(n - 1, i + 1)];
    const tx = q[0] - p[0];
    const tz = q[1] - p[1];
    const l = Math.hypot(tx, tz) || 1;
    const nx = -tz / l;
    const nz = tx / l;
    const t = i / Math.max(1, n - 1);
    const w = W(t, i) / 2;
    const [x, z] = path[i];
    const c = Cf(t, i);
    const lx = x + nx * w;
    const lz = z + nz * w;
    const rx = x - nx * w;
    const rz = z - nz * w;
    L.push(g.v([lx, y(lx, lz), lz], normal(lx, lz), c));
    R.push(g.v([rx, y(rx, rz), rz], normal(rx, rz), c));
  }
  for (let i = 0; i < n - 1; i++) {
    if (dashes && i % (dashes[0] + dashes[1]) >= dashes[0]) continue;
    g.quad(L[i], R[i], R[i + 1], L[i + 1], [0, 1, 0]);
  }
  return g;
}

/** Icosphere, scaled by radii and roughened by `jitter(dir)` (returns a factor). */
export function blob(centre, { radii, color, detail = 2, jitter = null }) {
  const t = (1 + Math.sqrt(5)) / 2;
  let V = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(norm);
  let F = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let d = 0; d < detail; d++) {
    const mid = new Map();
    const m = (a, b) => {
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      if (!mid.has(k)) {
        V.push(norm(scale(add(V[a], V[b]), 0.5)));
        mid.set(k, V.length - 1);
      }
      return mid.get(k);
    };
    F = F.flatMap(([a, b, c]) => {
      const ab = m(a, b);
      const bc = m(b, c);
      const ca = m(c, a);
      return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]];
    });
  }
  const g = new Geo();
  const Cf = typeof color === 'function' ? color : () => color;
  for (const d of V) {
    const k = jitter ? jitter(d) : 1;
    g.v([centre[0] + d[0] * radii[0] * k, centre[1] + d[1] * radii[1] * k, centre[2] + d[2] * radii[2] * k], d, Cf(d));
  }
  for (const [a, b, c] of F) g.I.push(a, b, c);
  return g.smoothNormals();
}

// --- glTF output ------------------------------------------------------------------------------
export function gltf() {
  const doc = new Document();
  const buf = doc.createBuffer();
  const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buf);
  const material = (name, { color = '#ffffff', rough = 0.85, metal = 0, alpha, emissive, ds = false, texture, emissiveTexture } = {}) => {
    const m = doc
      .createMaterial(name)
      .setBaseColorFactor([...rgb(color), alpha ?? 1])
      .setRoughnessFactor(rough)
      .setMetallicFactor(metal)
      .setDoubleSided(ds);
    if (alpha !== undefined && alpha < 1) m.setAlphaMode('BLEND');
    if (emissive) m.setEmissiveFactor(rgb(emissive));
    if (texture) m.setBaseColorTexture(texture);
    if (emissiveTexture) m.setEmissiveTexture(emissiveTexture);
    return m;
  };
  const mesh = (name, geo, mat) => {
    for (const k of ['P', 'N', 'C']) {
      const bad = geo[k].findIndex((v) => !Number.isFinite(v));
      if (bad >= 0) throw new Error(`${name}: non-finite ${k}[${bad}] (vertex ${Math.floor(bad / 3)}: ${geo.P.slice(bad - (bad % 3), bad - (bad % 3) + 3)})`);
    }
    const p = doc
      .createPrimitive()
      .setAttribute('POSITION', acc('VEC3', new Float32Array(geo.P)))
      .setAttribute('NORMAL', acc('VEC3', new Float32Array(geo.N)))
      .setAttribute('COLOR_0', acc('VEC3', new Float32Array(geo.C)))
      .setIndices(acc('SCALAR', new Uint32Array(geo.I)))
      .setMaterial(mat);
    if (geo.UV.length) p.setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array(geo.UV)));
    return doc.createMesh(name).addPrimitive(p);
  };
  const node = (name, geo = null, mat = null, parent = null) => {
    const n = doc.createNode(name);
    if (geo) n.setMesh(mesh(name, geo, mat));
    parent?.addChild(n);
    return n;
  };
  return { doc, material, mesh, node };
}
