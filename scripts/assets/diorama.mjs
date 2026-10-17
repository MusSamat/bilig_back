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
import { KHRMaterialsClearcoat } from '@gltf-transform/extensions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

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
export const toSRGB = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.max(0, c) ** (1 / 2.4) - 0.055);
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
    // quintic fade: curvature stays continuous across cells (no grid lines in baked relief shading)
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
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
  // octave rotation (≈37°) hides the value-noise grid
  const R0 = 0.8;
  const R1 = -0.6;
  const R2 = 0.6;
  const R3 = 0.8;
  /**
   * «Eroded» fbm (derivative damping): octaves are suppressed where the sum is
   * already steep, so slopes stay smooth-gullied and detail gathers on flats
   * and crests, like weathered rock. About [-1, 1].
   */
  const eroded = (x, z, oct = 6) => {
    let s = 0;
    let a = 0.5;
    let n = 0;
    let dx = 0;
    let dz = 0;
    let px = x;
    let pz = z;
    // accumulated frame: d(p)/d(x, z) = f · R^o
    let m0 = 1;
    let m1 = 0;
    let m2 = 0;
    let m3 = 1;
    let f = 1;
    for (let o = 0; o < oct; o++) {
      const qx = px + o * 17.3;
      const qz = pz - o * 9.1;
      const i = Math.floor(qx);
      const j = Math.floor(qz);
      const fx = qx - i;
      const fz = qz - j;
      const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
      const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
      const du = 30 * fx * fx * (fx - 1) * (fx - 1);
      const dv = 30 * fz * fz * (fz - 1) * (fz - 1);
      const h00 = hash(i, j);
      const k1 = hash(i + 1, j) - h00;
      const k2 = hash(i, j + 1) - h00;
      const k4 = hash(i + 1, j + 1) - hash(i, j + 1) - k1;
      const val = (h00 + k1 * u + k2 * v + k4 * u * v) * 2 - 1;
      const gx = 2 * du * (k1 + k4 * v);
      const gz = 2 * dv * (k2 + k4 * u);
      // gradient back in the input frame
      dx += a * f * (gx * m0 + gz * m2);
      dz += a * f * (gx * m1 + gz * m3);
      s += (a * val) / (1 + 0.35 * (dx * dx + dz * dz));
      n += a;
      a *= 0.5;
      const npx = 2 * (R0 * px + R1 * pz);
      pz = 2 * (R2 * px + R3 * pz);
      px = npx;
      const t0 = R0 * m0 + R1 * m2;
      const t1 = R0 * m1 + R1 * m3;
      const t2 = R2 * m0 + R3 * m2;
      const t3 = R2 * m1 + R3 * m3;
      m0 = t0;
      m1 = t1;
      m2 = t2;
      m3 = t3;
      f *= 2;
    }
    return s / n;
  };
  /**
   * Ridged multifractal (Musgrave): sharp crests whose detail is weighted by
   * the octave below, so arêtes are crisp and valleys stay smooth. [0, ~1].
   */
  const ridgedMF = (x, z, oct = 6, opts = null) => {
    const gain = opts?.gain ?? 2.2;
    const offset = opts?.offset ?? 1;
    const lac = opts?.lac ?? 2.05;
    const H = opts?.H ?? 0.95;
    let s = 0;
    let w = 1;
    let amp = 1;
    const ampK = lac ** -H;
    let n = 0;
    let px = x;
    let pz = z;
    for (let o = 0; o < oct; o++) {
      let sig = offset - Math.abs(n2(px + o * 31.7, pz + o * 12.9));
      sig *= sig * w;
      w = sig * gain;
      if (w > 1) w = 1;
      else if (w < 0) w = 0;
      s += sig * amp;
      n += amp;
      amp *= ampK;
      const npx = lac * (R0 * px + R1 * pz);
      pz = lac * (R2 * px + R3 * pz);
      px = npx;
    }
    return s / n;
  };
  /** Domain warp: [x', z'] displaced by fbm (amplitude `amt`, frequency `freq`). */
  const warp = (x, z, amt, freq = 1) => [x + amt * fbm(x * freq + 4.1, z * freq - 7.7, 3), z + amt * fbm(x * freq - 2.3, z * freq + 5.9, 3)];
  return { n2, fbm, ridged, ridgedMF, eroded, warp, rand: (i, j = 0) => hash(i, j) };
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
export function surface({ x0, x1, z0, z1, step, h, phi = null, color, normal = null, lift = 0, uv = null }) {
  const g = new Geo();
  const nrm = normal ?? fieldNormal(h, step * 0.5);
  const cache = new Map();
  const vert = (p) => {
    const k = p.id ?? p.edge;
    if (cache.has(k)) return cache.get(k);
    const y = h(p.x, p.z) + lift;
    const n = nrm(p.x, p.z);
    const i = g.v([p.x, y, p.z], n, color ? color(p.x, y, p.z, n) : [1, 1, 1], uv ? uv(p.x, p.z) : null);
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
  if (uv && !color) g.C = [];
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
export function bandWall(path, bandsAt, normal, { dy = null } = {}) {
  const g = new Geo();
  const cols = path.map(([x, z]) => bandsAt(x, z));
  // with `dy`, each band of each segment is split into rows about `dy` high
  // and a band's `shade(x, y, z, f)` (f = 0 at its base, 1 at its top) colours every row
  const colour = (B, x, y, z, f) => (B.shade ? B.shade(x, y, z, f) : f >= 1 ? B.cTop : f <= 0 ? (B.cBottom ?? B.cTop) : mix(B.cBottom ?? B.cTop, B.cTop, f));
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, az] = path[i];
    const [bx, bz] = path[i + 1];
    for (let k = 0; k < cols[i].length; k++) {
      const A = cols[i][k];
      const B = cols[i + 1][k];
      if (A.top - A.bottom < 1e-5 && B.top - B.bottom < 1e-5) continue;
      const n = dy ? Math.max(1, Math.ceil(Math.max(A.top - A.bottom, B.top - B.bottom) / dy)) : 1;
      let prev = null;
      for (let r = 0; r <= n; r++) {
        const f = r / n;
        const ya = lerp(A.bottom, A.top, f);
        const yb = lerp(B.bottom, B.top, f);
        const cur = [g.v([ax, ya, az], normal, colour(A, ax, ya, az, f)), g.v([bx, yb, bz], normal, colour(B, bx, yb, bz, f))];
        if (prev) g.quad(prev[0], prev[1], cur[1], cur[0], normal);
        prev = cur;
      }
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
 * A stack of `count` sedimentary beds from `from` up to `to` (then one last
 * bed up to the surface): bed thickness varies per bed, boundaries undulate
 * (gentle folds + per-boundary noise, never crossing), colours cycle through
 * `palette` with per-bed and along-strike variation; each bed is graded
 * (darker at its base). Returns `strata` layers.
 */
export function sedimentStack(N, { from, to, count, palette, seed = 0, fold = 0.06, wobble = 0.35, fadeFrom = 0.15 }) {
  const w = Array.from({ length: count }, (_, k) => 0.45 + N.rand(k, seed + 1));
  const sum = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  const levels = w.map((v) => (acc += v) / sum).map((f) => from + (to - from) * f);
  const thin = Math.min(...w) / sum * (to - from);
  const folds = (x, z) => fold * (Math.sin(x * 0.55 + 0.8 + 0.4 * Math.sin(z * 0.7)) + 0.6 * N.fbm(x * 0.35 + seed, z * 0.35, 3));
  return levels.map((lv, k) => {
    const base = palette[Math.floor(N.rand(k, seed + 2) * palette.length) % palette.length];
    const tone = 0.82 + 0.3 * N.rand(k, seed + 3);
    const fade = smoothstep(from, from + fadeFrom, lv);
    const at = (x, z) => lv + fade * folds(x, z) + thin * wobble * N.fbm(x * 2.3 + k * 7.1, z * 2.3 + seed, 3);
    const c = (x, z, k2 = 1) => shade(base, tone * k2 * (0.9 + 0.2 * (0.5 + 0.5 * N.fbm(x * 1.7 + k, z * 1.7 - k, 3))));
    // per-bed character: some beds finely laminated (shale), some massive and jointed (sandstone, limestone)
    const lam = N.rand(k, seed + 4);
    const lamF = 90 + 160 * N.rand(k, seed + 5);
    const tint = palette[Math.floor(N.rand(k, seed + 6) * palette.length) % palette.length];
    return {
      to: k === count - 1 ? 99 : at,
      color: (x, z) => c(x, z, 1.04),
      colorBottom: (x, z) => c(x, z, 0.8),
      /** Rich wall colour: grading, laminae, lenses of another tint, joints, grain. */
      shade(x, y, z, f) {
        const h = x + z; // along the wall, whichever wall it is
        let col = c(x, z, lerp(0.8, 1.06, smoothstep(0, 0.55, f)));
        // lenses of a second tint inside the bed
        col = mix(col, shade(tint, tone), 0.45 * smoothstep(0.25, 0.7, N.fbm(h * 1.3 + k * 3.1, y * 6 + k, 3)));
        // laminae: thin light/dark lines following the bed (only in laminated beds)
        const lines = Math.sin((y - lv) * lamF + 2.2 * N.fbm(h * 0.9 + k, k * 1.7, 2));
        col = shade(col, 1 + (lam > 0.45 ? 0.09 : 0.035) * lines);
        // joints: sparse near-vertical dark cracks in massive beds
        const j = 1 - Math.abs(N.n2(h * 9 + 0.6 * N.fbm(h * 3, y * 3, 2) + k * 13.7, y * 1.5 + k));
        col = shade(col, 1 - (lam <= 0.45 ? 0.32 : 0.12) * smoothstep(0.93, 0.99, j));
        // grain
        return shade(col, 0.93 + 0.12 * (0.5 + 0.5 * N.n2(h * 60, y * 60 + k * 7)));
      },
    };
  });
}

/**
 * Horizontal strata between `base` and `top`: `layers` = [{ to: y, color }]
 * bottom-up, plus a skin of `skin` thickness coloured `skinColor(x, z)` under
 * the surface. Returns a bandsAt function for bandWall.
 */
export function strata({ base, top, layers, skin = 0.035, skinColor, skinBottom = null }) {
  return (x, z) => {
    const t = top(x, z);
    const under = t - skin;
    const bands = [];
    let from = base;
    for (const L of layers) {
      const to = typeof L.to === 'function' ? L.to(x, z) : L.to;
      const b = Math.max(base, Math.min(from, under));
      const tt = Math.max(b, Math.min(to, under));
      const col = (c) => (typeof c === 'function' ? c(x, z) : c);
      // `skip` leaves the band empty: another node draws it (an aquifer)
      bands.push({ bottom: b, top: L.skip ? b : tt, cTop: col(L.color) ?? [0, 0, 0], cBottom: col(L.colorBottom), shade: L.shade });
      from = Math.max(from, to);
    }
    const sk = skinColor(x, z);
    bands.push({ bottom: Math.max(base, under), top: Math.max(base, t), cTop: sk, cBottom: skinBottom ? skinBottom(x, z) : shade(sk, 0.8) });
    return bands;
  };
}

// --- sampled fields and baked textures -------------------------------------------------------
/**
 * fn(x, z) sampled on a regular grid over [x0,x1]×[z0,z1] (row j = z): a
 * cache for expensive height functions. at(x, z) interpolates bilinearly,
 * normal(x, z) is the field's surface normal at about one cell.
 */
export function grid(fn, { x0, x1, z0, z1, step }) {
  const nx = Math.round((x1 - x0) / step);
  const nz = Math.round((z1 - z0) / step);
  const W = nx + 1;
  const sx = (x1 - x0) / nx;
  const sz = (z1 - z0) / nz;
  const data = new Float32Array(W * (nz + 1));
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) data[j * W + i] = fn(x0 + sx * i, z0 + sz * j);
  const get = (i, j) => data[clamp(j, 0, nz) * W + clamp(i, 0, nx)];
  const at = (x, z) => {
    const fx = clamp((x - x0) / sx, 0, nx - 1e-9);
    const fz = clamp((z - z0) / sz, 0, nz - 1e-9);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    return lerp(lerp(data[j * W + i], data[j * W + i + 1], u), lerp(data[(j + 1) * W + i], data[(j + 1) * W + i + 1], u), v);
  };
  const normal = (x, z, e = sx) => {
    const dx = (at(x + e, z) - at(x - e, z)) / (2 * e);
    const dz = (at(x, z + e) - at(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz);
    return [-dx / l, 1 / l, -dz / l];
  };
  return { nx, nz, W, sx, sz, x0, z0, x1, z1, data, get, at, normal, x: (i) => x0 + sx * i, z: (j) => z0 + sz * j };
}

/**
 * A top-down colour texture over [x0,x1]×[z0,z1]: texel (i, j) is
 * color(x, z, i, j) in linear RGB at x = x0 + i·step, z = z0 + j·step.
 * Returns { png, uv } where uv(x, z) maps a point to its texel centre.
 */
export async function bakeTexture({ x0, x1, z0, z1, step }, color) {
  const nx = Math.round((x1 - x0) / step);
  const nz = Math.round((z1 - z0) / step);
  const W = nx + 1;
  const H = nz + 1;
  const px = Buffer.alloc(W * H * 3);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const c = color(x0 + ((x1 - x0) * i) / nx, z0 + ((z1 - z0) * j) / nz, i, j);
      for (let d = 0; d < 3; d++) px[(j * W + i) * 3 + d] = Math.round(255 * clamp(toSRGB(clamp(c[d]))));
    }
  const png = await sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const uv = (x, z) => [(((x - x0) / (x1 - x0)) * nx + 0.5) / W, (((z - z0) / (z1 - z0)) * nz + 0.5) / H];
  return { png, uv, width: W, height: H };
}

/**
 * Simplify a mesh (meshoptimizer, positions only) towards `target`
 * triangles without moving any vertex further than `error` (relative to the
 * mesh extent); open borders stay locked so clipped edges still meet.
 * Normals, colours and UVs of the kept vertices are unchanged.
 */
export async function simplifyGeo(g, { target, error = 0.003, lockBorder = true }) {
  await MeshoptSimplifier.ready;
  const tgt = Math.min(g.I.length, Math.floor(target) * 3);
  const [out] = MeshoptSimplifier.simplify(new Uint32Array(g.I), new Float32Array(g.P), 3, tgt, error, lockBorder ? ['LockBorder'] : []);
  const ng = new Geo();
  const map = new Int32Array(g.count).fill(-1);
  const hasC = g.C.length > 0;
  const hasUV = g.UV.length > 0;
  const I = [];
  for (const i of out) {
    if (map[i] < 0) map[i] = ng.v(g.P.slice(3 * i, 3 * i + 3), g.N.slice(3 * i, 3 * i + 3), hasC ? g.C.slice(3 * i, 3 * i + 3) : [1, 1, 1], hasUV ? g.UV.slice(2 * i, 2 * i + 2) : null);
    I.push(map[i]);
  }
  ng.I = I;
  if (!hasC) ng.C = [];
  return ng;
}

// --- baked relief light ------------------------------------------------------------------------
/**
 * Bakes cheap «global illumination» terms of a height field on a grid, so
 * vertex colours carry the shading a renderer without shadows/AO would miss:
 *   ao(x, z)      horizon-based ambient occlusion, 1 = open sky, ~0.4 deep gorge
 *   cavity(x, z)  local convexity in [-1, 1]: + crests and arêtes, − gullies and cirque floors
 *   shadow(x, z)  soft cast shadow from the sun direction, 1 = lit
 *   sunlit(x, z, n)  Lambert term max(0, n·sun)
 * The block's outside is treated as open (no occluders beyond the edges).
 */
export function bakeRelief(h, { x0, x1, z0, z1, step, sun = [0.55, 0.62, -0.35], aoRadius = 0.7, dirs = 12, cavityRadius = null, cavityScale = 0.035 }) {
  const nx = Math.round((x1 - x0) / step);
  const nz = Math.round((z1 - z0) / step);
  const W = nx + 1;
  const H = new Float64Array(W * (nz + 1));
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) H[j * W + i] = h(x0 + ((x1 - x0) * i) / nx, z0 + ((z1 - z0) * j) / nz);
  const sx = (x1 - x0) / nx;
  const sz = (z1 - z0) / nz;
  const bil = (A, x, z) => {
    const fx = clamp((x - x0) / sx, 0, nx - 1e-9);
    const fz = clamp((z - z0) / sz, 0, nz - 1e-9);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const a = A[j * W + i];
    const b = A[j * W + i + 1];
    const c = A[(j + 1) * W + i];
    const d = A[(j + 1) * W + i + 1];
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  };
  const inside = (x, z) => x >= x0 && x <= x1 && z >= z0 && z <= z1;
  const AO = new Float64Array(H.length);
  const CAV = new Float64Array(H.length);
  const SH = new Float64Array(H.length);
  const radii = [];
  for (let r = step * 1.2; r <= aoRadius; r *= 1.35) radii.push(r);
  const cr = cavityRadius ?? step * 2.5;
  const sl = Math.hypot(sun[0], sun[2]) || 1;
  const sdx = sun[0] / sl;
  const sdz = sun[2] / sl;
  const tanE = sun[1] / sl;
  for (let j = 0; j <= nz; j++)
    for (let i = 0; i <= nx; i++) {
      const x = x0 + sx * i;
      const z = z0 + sz * j;
      const h0 = H[j * W + i];
      // ambient occlusion: mean sine of the horizon angle over `dirs` azimuths (cosine-ish weighting)
      let occ = 0;
      for (let d = 0; d < dirs; d++) {
        const a = ((d + 0.5) / dirs) * 2 * Math.PI;
        const cx = Math.cos(a);
        const cz = Math.sin(a);
        let m = 0;
        for (const r of radii) {
          const px = x + cx * r;
          const pz = z + cz * r;
          if (!inside(px, pz)) break;
          const dh = bil(H, px, pz) - h0;
          if (dh > 0) m = Math.max(m, dh / Math.hypot(dh, r));
        }
        occ += m * m * 0.6 + m * 0.4;
      }
      AO[j * W + i] = 1 - occ / dirs;
      // cavity: height above the ring average at two radii
      let ring = 0;
      let ring2 = 0;
      for (let d = 0; d < 8; d++) {
        const a = (d / 8) * 2 * Math.PI;
        ring += bil(H, x + Math.cos(a) * cr, z + Math.sin(a) * cr);
        ring2 += bil(H, x + Math.cos(a) * cr * 3, z + Math.sin(a) * cr * 3);
      }
      CAV[j * W + i] = clamp(((h0 - ring / 8) * 0.65 + (h0 - ring2 / 8) * 0.35 * 0.5) / cavityScale, -1, 1);
      // soft shadow: march towards the sun, keep the smallest clearance/distance ratio
      let lit = 1;
      for (let t = step * 1.5; t < 3.5; t *= 1.12) {
        const px = x + sdx * t;
        const pz = z + sdz * t;
        if (!inside(px, pz)) break;
        const clear = h0 + 0.01 + t * tanE - bil(H, px, pz);
        lit = Math.min(lit, clamp((clear / t) * 6 + 0.5));
        if (lit <= 0) break;
      }
      SH[j * W + i] = lit * lit * (3 - 2 * lit);
    }
  const sn = norm(sun);
  return {
    height: (x, z) => bil(H, x, z),
    ao: (x, z) => bil(AO, x, z),
    cavity: (x, z) => bil(CAV, x, z),
    shadow: (x, z) => bil(SH, x, z),
    sun: sn,
    sunlit: (n) => Math.max(0, n[0] * sn[0] + n[1] * sn[1] + n[2] * sn[2]),
  };
}

/**
 * Apply baked light to an albedo: ambient occlusion and cavity darken,
 * cast shadow cools and darkens (sky-lit), sun-facing slopes warm slightly.
 * `strength` scales everything (1 = default).
 */
export function lightBake(c, { ao = 1, cavity = 0, shadow = 1, sunlit = 0.6, strength = 1, cool = rgb('#9fb6d6') }) {
  const k = strength;
  const occl = lerp(1, 0.38 + 0.62 * ao ** 1.3, k);
  const cav = lerp(1, 1 + 0.22 * clamp(cavity, -1, 1), k);
  const sh = lerp(1, 0.62 + 0.38 * shadow, k);
  // shadowed areas take the blue of the sky; lit sun-facing slopes a warm cast
  const warm = clamp(sunlit * shadow);
  let out = c.map((v, i) => v * occl * cav * sh);
  out = mix(out, out.map((v, i) => v * cool[i] * 1.6), (1 - shadow) * 0.45 * k);
  out = out.map((v, i) => v * lerp(1, [1.05, 1.01, 0.95][i], warm * k));
  return out.map((v) => clamp(v));
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

/**
 * Tien Shan spruce (Picea schrenkiana): a tall, narrow spire of drooping
 * branch tiers on a short trunk. Each tier is a ragged skirt (darker
 * underneath and inside, lighter at the sunlit tips), tiers shrink and
 * lighten towards the slender leader; `rand(k)` in [0, 1) varies it.
 */
export function spruce([x, y, z], { height, radius, color, trunk, tiers = 7, segs = 7, phase = 0, rand = (k) => (((Math.sin(k * 12.9898 + phase * 78.233) * 43758.5453) % 1) + 1) % 1, lean = [0, 0], underside = false }) {
  const g = new Geo();
  g.append(tube([[x, y - 0.02, z], [x, y + height * 0.12, z]], { radius: radius * 0.13, color: trunk, segs: 4 }));
  const off = (h) => [lean[0] * h, lean[1] * h];
  for (let k = 0; k < tiers; k++) {
    const t = k / (tiers - 1);
    const by = y + height * (0.07 + 0.72 * t ** 0.92);
    const top = k === tiers - 1 ? y + height : by + height * (0.27 - 0.1 * t);
    const r = radius * (1 - 0.8 * t) ** 0.85 * (0.85 + 0.3 * rand(k));
    const [ox, oz] = off((by - y) / height);
    const [tx, tz] = off((top - y) / height);
    const apex = [x + tx, top, z + tz];
    const cIn = shade(color, 0.5 + 0.22 * t);
    const cTip = shade(color, 0.92 + 0.3 * t);
    const centre = underside ? g.v([x + ox, by + (top - by) * 0.25, z + oz], [0, -1, 0], cIn) : -1;
    const ring = [];
    for (let s = 0; s < segs; s++) {
      const a = phase + k * 0.9 + (2 * Math.PI * (s + 0.3 * (rand(k * 31 + s) - 0.5))) / segs;
      const rr = r * (0.78 + 0.4 * rand(k * 17 + s + 5));
      // branch tips droop below the tier base
      const droop = (top - by) * (0.12 + 0.18 * rand(k * 7 + s));
      ring.push([x + ox + Math.cos(a) * rr, by - droop, z + oz + Math.sin(a) * rr]);
    }
    const slope = r / (top - by);
    const ai = g.v(apex, [0, 1, 0], cTip);
    for (let s = 0; s < segs; s++) {
      const p = ring[s];
      const q = ring[(s + 1) % segs];
      const mx = (p[0] + q[0]) / 2 - x - ox;
      const mz = (p[2] + q[2]) / 2 - z - oz;
      const l = Math.hypot(mx, mz) || 1;
      const n = norm([mx / l, slope * 0.9, mz / l]);
      const np = norm([p[0] - x - ox, slope * 0.9 * Math.hypot(p[0] - x - ox, p[2] - z - oz) / (r || 1), p[2] - z - oz]);
      const nq = norm([q[0] - x - ox, slope * 0.9 * Math.hypot(q[0] - x - ox, q[2] - z - oz) / (r || 1), q[2] - z - oz]);
      const a = g.v(p, np, shade(cTip, 0.78 + 0.25 * rand(k * 13 + s)));
      const b = g.v(q, nq, shade(cTip, 0.78 + 0.25 * rand(k * 13 + s + 1)));
      g.tri(a, b, ai, n);
      // underside: dark skirt back to the trunk
      if (underside) g.tri(g.v(p, [0, -1, 0], cIn), g.v(q, [0, -1, 0], cIn), centre, [0, -1, 0]);
    }
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
  // `color` may be a function of the arc fraction t (tone gradient along the arrow); the head takes t = 1
  const Cf = typeof color === 'function' ? color : () => color;
  const g = tube(shaft.length > 1 ? shaft : [pts[0], cut], { radius, color: Cf, segs, capStart: true });
  g.append(cone(cut, { radius: radius * head, height: hl, color: Cf(1), segs, dir, baseCap: true }));
  return g;
}

/**
 * Ribbon draped on y(x, z) along a dense 2D path; width(t) may be a function.
 * `dashes` = [on, off] in samples makes a dashed line.
 */
export function ribbon(path, { width, y, color, normal = () => [0, 1, 0], dashes = null, centre = null }) {
  const g = new Geo();
  const W = typeof width === 'function' ? width : () => width;
  const Cf = typeof color === 'function' ? color : () => color;
  const Cc = centre && (typeof centre === 'function' ? centre : () => centre);
  const n = path.length;
  const L = [];
  const R = [];
  const M = [];
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
    if (Cc) M.push(g.v([x, y(x, z), z], normal(x, z), Cc(t, i)));
  }
  for (let i = 0; i < n - 1; i++) {
    if (dashes && i % (dashes[0] + dashes[1]) >= dashes[0]) continue;
    if (Cc) {
      g.quad(L[i], M[i], M[i + 1], L[i + 1], [0, 1, 0]);
      g.quad(M[i], R[i], R[i + 1], M[i + 1], [0, 1, 0]);
    } else g.quad(L[i], R[i], R[i + 1], L[i + 1], [0, 1, 0]);
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
  let clearcoatExt = null;
  const material = (name, { color = '#ffffff', rough = 0.85, metal = 0, alpha, emissive, ds = false, texture, emissiveTexture, clearcoat } = {}) => {
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
    if (clearcoat) {
      clearcoatExt ??= doc.createExtension(KHRMaterialsClearcoat);
      m.setExtension('KHR_materials_clearcoat', clearcoatExt.createClearcoat().setClearcoatFactor(clearcoat[0]).setClearcoatRoughnessFactor(clearcoat[1]));
    }
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
      .setIndices(acc('SCALAR', new Uint32Array(geo.I)))
      .setMaterial(mat);
    // textured surfaces carry no vertex colours (geo.C emptied)
    if (geo.C.length) p.setAttribute('COLOR_0', acc('VEC3', new Float32Array(geo.C)));
    if (geo.UV.length) p.setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array(geo.UV)));
    return p;
  };
  /** Image (PNG/JPEG buffer) as a texture. */
  const texture = (name, png) => doc.createTexture(name).setImage(new Uint8Array(png)).setMimeType('image/png');
  /** A node; `geo` may be a list of [geo, material] pairs (one primitive each). */
  const node = (name, geo = null, mat = null, parent = null) => {
    const n = doc.createNode(name);
    if (geo) {
      const m = doc.createMesh(name);
      for (const [g, mt] of Array.isArray(geo) ? geo : [[geo, mat]]) if (g.I.length) m.addPrimitive(mesh(name, g, mt));
      n.setMesh(m);
    }
    parent?.addChild(n);
    return n;
  };
  return { doc, material, mesh, node, texture };
}
