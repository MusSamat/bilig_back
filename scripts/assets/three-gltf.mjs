/**
 * Shared helpers for models authored with three.js geometry (our own work,
 * CC0): turn a three.js object graph into a glTF-Transform Document (node
 * names, TRS, PBR materials incl. KHR_materials_clearcoat / _sheen, vertex
 * colours, UVs and a procedural normal map, instanced meshes expanded to
 * nodes sharing one mesh), read concept colours from the content sources so
 * a structure has the same colour in the GLB, in its chip and in its label
 * (scene-core `conceptColor(hue, 62, 62)`), and a small organic-modelling
 * kit: seeded 3D gradient noise + fbm, parametric surfaces (closed, cut open
 * with a thick rim, pillow-shaped sheets, tubes) with per-vertex colour and a
 * cavity term for baked ambient-occlusion-like shading.
 *
 * three.js is used only as a geometry kernel here; nothing is rendered.
 * Everything is deterministic (mulberry32), so a rebuild gives the same bytes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document } from '@gltf-transform/core';
import { KHRMaterialsClearcoat, KHRMaterialsSheen, KHRTextureTransform } from '@gltf-transform/extensions';
import sharp from 'sharp';
import {
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const CONTENT_SRC = new URL('../../content/src/', import.meta.url).pathname;

/** Deterministic PRNG (mulberry32), so a rebuild gives the same bytes. */
export function rng(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const maskRe = (mask) => new RegExp('^' + mask.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');

/**
 * Node name → concept colour for a topic: the topic's `overrides[key].nodes`
 * masks bind names to concepts, the concept dictionary gives the hue.
 */
export function topicColours(topicKey, subject) {
  const { topic } = JSON.parse(readFileSync(join(CONTENT_SRC, 'topics', `${topicKey}.json`), 'utf8'));
  const { concepts } = JSON.parse(readFileSync(join(CONTENT_SRC, 'concepts', `${subject}.json`), 'utf8'));
  const hue = new Map(concepts.map((c) => [c.key, c.hue]));
  const masks = Object.entries(topic.overrides ?? {}).flatMap(([key, o]) => (o.nodes ?? []).map((m) => ({ re: maskRe(m), key })));
  const hueOf = (node) => {
    const hit = masks.find((m) => m.re.test(node));
    return hit ? hue.get(hit.key) : undefined;
  };
  return {
    topic,
    /** Concept colour of a node name (hsl(h, 62%, 62%)), or the fallback. */
    colour(node, fallback) {
      const h = hueOf(node);
      return h === undefined ? fallback : `hsl(${h}, 62%, 62%)`;
    },
    /** Concept hue in degrees, or the fallback. */
    hue(node, fallback) {
      return hueOf(node) ?? fallback;
    },
    conceptOf(node) {
      return masks.find((m) => m.re.test(node))?.key ?? null;
    },
  };
}

/** Shade a CSS colour: lightness / saturation delta in percent. */
export function tint(css, dl, ds = 0) {
  const c = new Color(css);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, Math.min(1, Math.max(0, hsl.s + ds / 100)), Math.min(1, Math.max(0, hsl.l + dl / 100)));
  return `#${c.getHexString()}`;
}

/* ------------------------------------------------------------------ colour */

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const tmpC = new Color();
/** sRGB HSL (h in degrees, s/l 0…1) → linear RGB triple (glTF COLOR_0 is linear). */
export function hsl(h, s, l) {
  tmpC.setHSL((((h % 360) + 360) % 360) / 360, clamp01(s), clamp01(l), SRGBColorSpace);
  return [tmpC.r, tmpC.g, tmpC.b];
}
/** Multiply a linear colour (AO / shading factor). */
export const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/* ------------------------------------------------------------------- noise */

/** Seeded 3D gradient noise (improved Perlin), ≈ −1…1, with fbm / ridged variants. */
export function makeNoise(seed) {
  const R = rng(seed);
  const perm = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(R() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  const p = new Uint8Array(512);
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;
  const grad = (h, x, y, z) => {
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return (h & 1 ? -u : u) + (h & 2 ? -v : v);
  };
  /** Noise with an optional lattice period (tileable in x and y). */
  function n(x, y, z, period = 256) {
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const fz = Math.floor(z);
    x -= fx;
    y -= fy;
    z -= fz;
    const X0 = ((fx % period) + period) % period & 255;
    const Y0 = ((fy % period) + period) % period & 255;
    const X1 = ((X0 + 1) % period) & 255;
    const Y1 = ((Y0 + 1) % period) & 255;
    const Z0 = fz & 255;
    const Z1 = (Z0 + 1) & 255;
    const u = fade(x);
    const v = fade(y);
    const w = fade(z);
    const h = (X, Y, Z) => p[p[p[X] + Y] + Z] & 15;
    return lerp(
      lerp(lerp(grad(h(X0, Y0, Z0), x, y, z), grad(h(X1, Y0, Z0), x - 1, y, z), u), lerp(grad(h(X0, Y1, Z0), x, y - 1, z), grad(h(X1, Y1, Z0), x - 1, y - 1, z), u), v),
      lerp(lerp(grad(h(X0, Y0, Z1), x, y, z - 1), grad(h(X1, Y0, Z1), x - 1, y, z - 1), u), lerp(grad(h(X0, Y1, Z1), x, y - 1, z - 1), grad(h(X1, Y1, Z1), x - 1, y - 1, z - 1), u), v),
      w,
    );
  }
  return {
    n,
    /** Fractal sum, normalised to ≈ −1…1. */
    fbm(x, y, z, oct = 4, lac = 2.03, gain = 0.5) {
      let s = 0;
      let a = 1;
      let f = 1;
      let norm = 0;
      for (let i = 0; i < oct; i++) {
        s += a * n(x * f + i * 17.17, y * f - i * 9.31, z * f + i * 5.73);
        norm += a;
        a *= gain;
        f *= lac;
      }
      return s / norm;
    },
    /** Ridged fbm (sharp creases), 0…1. */
    ridge(x, y, z, oct = 3) {
      let s = 0;
      let a = 1;
      let f = 1;
      let norm = 0;
      for (let i = 0; i < oct; i++) {
        s += a * (1 - Math.abs(n(x * f + i * 31.7, y * f, z * f - i * 11.1)));
        norm += a;
        a *= 0.5;
        f *= 2.1;
      }
      return s / norm;
    },
  };
}

/* ------------------------------------------------------------- geometry */

/** Smooth normals that ignore seams: vertices at the same position share one normal. */
function smoothNormals(P, idx) {
  const N = new Float32Array(P.length);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    const ux = P[b] - P[a];
    const uy = P[b + 1] - P[a + 1];
    const uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a];
    const vy = P[c + 1] - P[a + 1];
    const vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) {
      N[k] += nx;
      N[k + 1] += ny;
      N[k + 2] += nz;
    }
  }
  const groups = new Map();
  const key = (k) => `${Math.round(P[k] * 1e5)},${Math.round(P[k + 1] * 1e5)},${Math.round(P[k + 2] * 1e5)}`;
  for (let k = 0; k < P.length; k += 3) {
    const g = key(k);
    const s = groups.get(g);
    if (s) {
      s[0] += N[k];
      s[1] += N[k + 1];
      s[2] += N[k + 2];
    } else groups.set(g, [N[k], N[k + 1], N[k + 2]]);
  }
  for (let k = 0; k < P.length; k += 3) {
    const s = groups.get(key(k));
    const l = Math.hypot(s[0], s[1], s[2]) || 1;
    N[k] = s[0] / l;
    N[k + 1] = s[1] / l;
    N[k + 2] = s[2] / l;
  }
  return N;
}

function signedVolume(P, idx) {
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return v;
}

/** Grey fallback painter. */
const GREY = () => [0.5, 0.5, 0.5];

/**
 * Parametric surface `f(u, v) → [x, y, z]` on an (nu × nv) grid, u wrapping
 * around (seam welded for normals), v pole to pole or edge to edge. Optional:
 *   cut(u, v)  → true removes that cell (the opening of a cut-away organelle)
 *   thick      → wall thickness: an inner surface plus a rim along the cut
 *   paint(p, n, u, v, cav, side) → linear RGB; side = 'out' | 'in';
 *              cav > 0 in creases, < 0 on ridges (relative to the surface mean)
 *   rim        → [[t, colour], …] stops across the rim, outer (0) → inner (1)
 *   uv         → UV scale [su, sv] (for tiling normal maps)
 * Returns an indexed BufferGeometry with position, normal, color and uv.
 */
export function surface(nu, nv, f, { cut = null, thick = 0, paint = GREY, rim = null, uv = [1, 1] } = {}) {
  const W = nu + 1;
  const NV = (nv + 1) * W;
  const P = new Float32Array(NV * 3);
  for (let j = 0; j <= nv; j++)
    for (let i = 0; i <= nu; i++) {
      const q = f(i / nu, j / nv);
      P.set(q, (j * W + i) * 3);
    }
  const full = [];
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const a = j * W + i;
      full.push(a, a + 1, a + W, a + 1, a + W + 1, a + W);
    }
  // Orientation: outward normals for a positive volume.
  const flip = signedVolume(P, full) < 0;
  if (flip)
    for (let t = 0; t < full.length; t += 3) {
      const x = full[t + 1];
      full[t + 1] = full[t + 2];
      full[t + 2] = x;
    }
  const N = smoothNormals(P, full);
  // Cavity: Laplacian along the grid against the normal, relative to the mean.
  const cav = new Float32Array(NV);
  let mean = 0;
  for (let j = 0; j <= nv; j++)
    for (let i = 0; i <= nu; i++) {
      const k = j * W + i;
      const nb = [];
      nb.push(j * W + (i === 0 ? nu - 1 : i - 1), j * W + (i === nu ? 1 : i + 1));
      if (j > 0) nb.push(k - W);
      if (j < nv) nb.push(k + W);
      let lx = 0;
      let ly = 0;
      let lz = 0;
      let e = 0;
      for (const m of nb) {
        const dx = P[m * 3] - P[k * 3];
        const dy = P[m * 3 + 1] - P[k * 3 + 1];
        const dz = P[m * 3 + 2] - P[k * 3 + 2];
        lx += dx;
        ly += dy;
        lz += dz;
        e += Math.hypot(dx, dy, dz);
      }
      const d = e > 1e-9 ? ((lx * N[k * 3] + ly * N[k * 3 + 1] + lz * N[k * 3 + 2]) / nb.length) / (e / nb.length) : 0;
      cav[k] = d;
      mean += d;
    }
  mean /= NV;
  let sd = 0;
  for (let k = 0; k < NV; k++) {
    cav[k] -= mean;
    sd += cav[k] * cav[k];
  }
  sd = Math.max(0.015, Math.sqrt(sd / NV));
  // In standard deviations, clamped: ≈ −3…3, > 0 in creases.
  for (let k = 0; k < NV; k++) cav[k] = Math.max(-3, Math.min(3, cav[k] / sd));

  const keep = (i, j) => {
    if (j < 0 || j >= nv) return false;
    const ii = ((i % nu) + nu) % nu;
    return !cut || !cut((ii + 0.5) / nu, (j + 0.5) / nv);
  };
  const pos = [];
  const nor = [];
  const col = [];
  const uvs = [];
  const idx = [];
  const add = (p, n, c, u, v) => {
    pos.push(p[0], p[1], p[2]);
    nor.push(n[0], n[1], n[2]);
    col.push(c[0], c[1], c[2]);
    uvs.push(u * uv[0], v * uv[1]);
    return pos.length / 3 - 1;
  };
  const vP = (k) => [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]];
  const vN = (k) => [N[k * 3], N[k * 3 + 1], N[k * 3 + 2]];
  const sides = thick > 0 ? ['out', 'in'] : ['out'];
  const maps = {};
  for (const side of sides) {
    const map = new Int32Array(NV).fill(-1);
    maps[side] = map;
    const vert = (k) => {
      if (map[k] < 0) {
        const i = k % W;
        const j = (k - i) / W;
        let p = vP(k);
        let n = vN(k);
        if (side === 'in') {
          p = [p[0] - n[0] * thick, p[1] - n[1] * thick, p[2] - n[2] * thick];
          n = [-n[0], -n[1], -n[2]];
        }
        map[k] = add(p, n, paint(p, n, i / nu, j / nv, cav[k], side), i / nu, j / nv);
      }
      return map[k];
    };
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        if (!keep(i, j)) continue;
        const t = full.slice((j * nu + i) * 6, (j * nu + i) * 6 + 6);
        const m = t.map(vert);
        if (side === 'out') idx.push(...m);
        else idx.push(m[0], m[2], m[1], m[3], m[5], m[4]);
      }
  }
  // Rim along the cut: strips from the outer to the inner surface.
  if (thick > 0 && cut) {
    const stops = rim ?? [
      [0, [0.5, 0.5, 0.5]],
      [1, [0.5, 0.5, 0.5]],
    ];
    const edge = (a, b, dir) => {
      const pa = vP(a);
      const pb = vP(b);
      if (Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]) < 1e-7) return;
      const na = vN(a);
      const nb = vN(b);
      const e = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
      const nm = [na[0] + nb[0], na[1] + nb[1], na[2] + nb[2]];
      let rn = [e[1] * nm[2] - e[2] * nm[1], e[2] * nm[0] - e[0] * nm[2], e[0] * nm[1] - e[1] * nm[0]];
      if (rn[0] * dir[0] + rn[1] * dir[1] + rn[2] * dir[2] < 0) rn = rn.map((x) => -x);
      const l = Math.hypot(...rn) || 1;
      rn = rn.map((x) => x / l);
      const at = (p, n, t) => [p[0] - n[0] * thick * t, p[1] - n[1] * thick * t, p[2] - n[2] * thick * t];
      let prev = null;
      for (const [t, c] of stops) {
        const A = add(at(pa, na, t), rn, c, 0, 0);
        const B = add(at(pb, nb, t), rn, c, 0, 0);
        if (prev) {
          // Winding so the geometric normal follows rn.
          const p0 = at(pa, na, prev.t);
          const p1 = at(pb, nb, prev.t);
          const p2 = at(pa, na, t);
          const u1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
          const u2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
          const g = [u1[1] * u2[2] - u1[2] * u2[1], u1[2] * u2[0] - u1[0] * u2[2], u1[0] * u2[1] - u1[1] * u2[0]];
          if (g[0] * rn[0] + g[1] * rn[1] + g[2] * rn[2] >= 0) idx.push(prev.A, prev.B, A, prev.B, B, A);
          else idx.push(prev.A, A, prev.B, prev.B, A, B);
        }
        prev = { A, B, t };
      }
    };
    const centre = (i, j) => {
      const ii = ((i % nu) + nu) % nu;
      const ks = [j * W + ii, j * W + ii + 1, (j + 1) * W + ii, (j + 1) * W + ii + 1];
      const s = [0, 0, 0];
      for (const k of ks) for (let d = 0; d < 3; d++) s[d] += P[k * 3 + d] / 4;
      return s;
    };
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        if (!keep(i, j)) continue;
        const c0 = centre(i, j);
        const nbrs = [
          [i - 1, j, j * W + i, (j + 1) * W + i],
          [i + 1, j, j * W + i + 1, (j + 1) * W + i + 1],
          [i, j - 1, j * W + i, j * W + i + 1],
          [i, j + 1, (j + 1) * W + i, (j + 1) * W + i + 1],
        ];
        for (const [ni, nj, a, b] of nbrs) {
          if (keep(ni, nj)) continue;
          if (nj < 0 || nj >= nv) continue; // poles / open ends: no rim
          const c1 = centre(ni, nj);
          edge(a, b, [c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]]);
        }
      }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

/** Disk → square (elliptical grid mapping inverse), so a pillow can have straight edges. */
function diskToSquare(x, z) {
  const a = 2 + x * x - z * z;
  const b = 2 - x * x + z * z;
  const r2 = 2 * Math.SQRT2;
  const U = 0.5 * Math.sqrt(Math.max(0, a + r2 * x)) - 0.5 * Math.sqrt(Math.max(0, a - r2 * x));
  const V = 0.5 * Math.sqrt(Math.max(0, b + r2 * z)) - 0.5 * Math.sqrt(Math.max(0, b - r2 * z));
  return [Math.max(-1, Math.min(1, U)), Math.max(-1, Math.min(1, V))];
}

/**
 * Pillow-shaped sheet (a cisterna, a crista, a thylakoid, a flat cell):
 * mid-surface `S(U, V) → { p: [x,y,z], n: [x,y,z] }` over U, V ∈ −1…1,
 * half-thickness `h(U, V)`, rounded edges (profile < 1 = flatter faces).
 * `square` maps to the whole square (straight edges), otherwise the disk.
 * paint(p, n, U, V, cav, y) gets y = −1…1 across the thickness.
 */
export function pillow(nu, nv, S, h, { square = false, profile = 0.7, paint = GREY, uv = [1, 1] } = {}) {
  const at = (u, v) => {
    const th = u * Math.PI * 2;
    const ph = v * Math.PI;
    const r = Math.sin(ph);
    const y = Math.cos(ph);
    let X = r * Math.cos(th);
    let Z = r * Math.sin(th);
    if (square) [X, Z] = diskToSquare(X, Z);
    return { X, Z, y };
  };
  return surface(
    nu,
    nv,
    (u, v) => {
      const { X, Z, y } = at(u, v);
      const s = S(X, Z);
      const o = Math.sign(y) * Math.abs(y) ** profile * h(X, Z);
      return [s.p[0] + s.n[0] * o, s.p[1] + s.n[1] * o, s.p[2] + s.n[2] * o];
    },
    {
      uv,
      paint: (p, n, u, v, cav) => {
        const { X, Z, y } = at(u, v);
        return paint(p, n, X, Z, cav, y);
      },
    },
  );
}

/**
 * Tube along a curve (points or a Curve), rounded closed ends.
 * radius(t, a) with t 0…1 along, a 0…1 around; paint(p, n, t, a, cav).
 */
export function tube(curve, nAround, nAlong, radius, { paint = GREY, cap = 0.08, uv = [1, 1] } = {}) {
  const c = Array.isArray(curve) ? new CatmullRomCurve3(curve) : curve;
  const fr = c.computeFrenetFrames(nAlong, false);
  return surface(
    nAround,
    nAlong,
    (u, v) => {
      const j = Math.round(v * nAlong);
      const t = j / nAlong;
      const p = c.getPointAt(t);
      const e = Math.min(t, 1 - t);
      const k = e < cap ? Math.sqrt(Math.max(0, 1 - ((cap - e) / cap) ** 2)) : 1;
      const r = radius(t, u) * k;
      const a = u * Math.PI * 2;
      const N = fr.normals[j];
      const B = fr.binormals[j];
      return [p.x + (N.x * Math.cos(a) + B.x * Math.sin(a)) * r, p.y + (N.y * Math.cos(a) + B.y * Math.sin(a)) * r, p.z + (N.z * Math.cos(a) + B.z * Math.sin(a)) * r];
    },
    { paint: (p, n, u, v, cav) => paint(p, n, v, u, cav), uv },
  );
}

/** Bake a transform into a copy of a geometry. */
export function placed(geo, { p = [0, 0, 0], q = null, s = 1 } = {}) {
  const g = geo.clone();
  const m = new Matrix4().compose(new Vector3(...p), q ?? new Quaternion(), typeof s === 'number' ? new Vector3(s, s, s) : new Vector3(...s));
  g.applyMatrix4(m);
  return g;
}

/** Merge geometries that all carry position, normal, color and uv. */
export function merged(list) {
  const g = mergeGeometries(list.filter(Boolean), false);
  if (!g) throw new Error('mergeGeometries failed (attribute mismatch)');
  return g;
}

/** Quaternion turning local axes (x → ax, z ≈ az) into world directions. */
export function frame(ax, az) {
  const x = new Vector3(...ax).normalize();
  const z0 = new Vector3(...az);
  const y = new Vector3().crossVectors(z0, x).normalize();
  const z = new Vector3().crossVectors(x, y).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
}

/**
 * Tileable bump normal map (PNG), for micro-relief on membranes and walls:
 * `kind` 'bumps' (granular) or 'fibres' (stretched along u, cellulose-like).
 */
export async function normalMapPng(seed, { size = 256, kind = 'bumps', strength = 2.2, period = 8 } = {}) {
  const N = makeNoise(seed);
  const H = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = (x / size) * period;
      const v = (y / size) * period;
      let h;
      if (kind === 'fibres') h = 0.6 * N.n(u * 0.5, v * 4, 0.5, period) + 0.4 * N.n(u, v * 8, 3.3, period * 2);
      else h = 0.55 * N.n(u, v, 0.5, period) + 0.3 * N.n(u * 2, v * 2, 2.5, period * 2) + 0.15 * N.n(u * 4, v * 4, 7.5, period * 4);
      H[y * size + x] = h;
    }
  const out = Buffer.alloc(size * size * 3);
  const at = (x, y) => H[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const o = (y * size + x) * 3;
      out[o] = Math.round(((-dx / l) * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round(((dy / l) * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round(((1 / l) * 0.5 + 0.5) * 255);
    }
  return sharp(out, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

/* ---------------------------------------------------------------- export */

/**
 * three.js graph → glTF document. Material properties read: color, opacity,
 * transparent, side (DoubleSide), roughness, metalness, emissive(+Intensity),
 * clearcoat, clearcoatRoughness, sheen (+sheenColor, sheenRoughness),
 * vertexColors (geometry `color` → COLOR_0), userData.normalPng (+normalScale)
 * (+normalRepeat, KHR_texture_transform) as a normal texture on TEXCOORD_0
 * (geometry `uv`, kept in 0…1 so it quantises). BackSide is not
 * representable in glTF and is rejected, so authoring scripts never use it.
 */
export function toDocument(root) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const clearcoatExt = doc.createExtension(KHRMaterialsClearcoat);
  const sheenExt = doc.createExtension(KHRMaterialsSheen);
  const ttExt = doc.createExtension(KHRTextureTransform);
  let usedClearcoat = false;
  let usedSheen = false;
  let usedTT = false;
  const scene = doc.createScene(root.name || 'Scene');
  const materials = new Map();
  const textures = new Map();
  const meshes = new Map();

  const texture = (png) => {
    if (!textures.has(png)) textures.set(png, doc.createTexture('').setImage(png).setMimeType('image/png'));
    return textures.get(png);
  };

  const material = (m) => {
    if (materials.has(m)) return materials.get(m);
    if (m.side === 1) throw new Error(`material on ${m.name || '(unnamed)'}: BackSide is not supported in glTF`);
    const c = m.color ?? new Color(1, 1, 1);
    const g = doc
      .createMaterial(m.name || '')
      .setBaseColorFactor([c.r, c.g, c.b, m.transparent ? m.opacity : 1])
      .setRoughnessFactor(m.roughness ?? 0.5)
      .setMetallicFactor(m.metalness ?? 0)
      .setDoubleSided(m.side === DoubleSide);
    if (m.transparent && m.opacity < 1) g.setAlphaMode('BLEND');
    if (m.emissive && m.emissiveIntensity > 0) {
      const e = m.emissive.clone().multiplyScalar(m.emissiveIntensity);
      g.setEmissiveFactor([Math.min(1, e.r), Math.min(1, e.g), Math.min(1, e.b)]);
    }
    if (m.clearcoat > 0) {
      usedClearcoat = true;
      g.setExtension('KHR_materials_clearcoat', clearcoatExt.createClearcoat().setClearcoatFactor(m.clearcoat).setClearcoatRoughnessFactor(m.clearcoatRoughness ?? 0.3));
    }
    if (m.sheen > 0) {
      usedSheen = true;
      const sc = m.sheenColor ?? new Color(1, 1, 1);
      g.setExtension('KHR_materials_sheen', sheenExt.createSheen().setSheenColorFactor([sc.r * m.sheen, sc.g * m.sheen, sc.b * m.sheen]).setSheenRoughnessFactor(m.sheenRoughness ?? 0.6));
    }
    if (m.userData?.normalPng) {
      g.setNormalTexture(texture(m.userData.normalPng));
      g.setNormalScale(m.userData.normalScale ?? 1);
      const rep = m.userData.normalRepeat ?? 1;
      if (rep !== 1) {
        usedTT = true;
        g.getNormalTextureInfo().setExtension('KHR_texture_transform', ttExt.createTransform().setScale([rep, rep]));
      }
    }
    materials.set(m, g);
    return g;
  };

  const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const mesh = (geo, m, name) => {
    const key = `${geo.uuid}|${m.uuid}`;
    if (meshes.has(key)) return meshes.get(key);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', accessor('VEC3', new Float32Array(geo.attributes.position.array)))
      .setAttribute('NORMAL', accessor('VEC3', new Float32Array(geo.attributes.normal.array)))
      .setMaterial(material(m));
    if (m.vertexColors && geo.attributes.color) {
      const a = geo.attributes.color.array;
      const out = new Float32Array(a.length);
      for (let i = 0; i < a.length; i++) out[i] = clamp01(a[i]);
      prim.setAttribute('COLOR_0', accessor(geo.attributes.color.itemSize === 4 ? 'VEC4' : 'VEC3', out));
    }
    if (m.userData?.normalPng && geo.attributes.uv) prim.setAttribute('TEXCOORD_0', accessor('VEC2', new Float32Array(geo.attributes.uv.array)));
    if (geo.index) {
      const idx = geo.index.array;
      prim.setIndices(accessor('SCALAR', geo.attributes.position.count > 65535 ? new Uint32Array(idx) : new Uint16Array(idx)));
    }
    const out = doc.createMesh(name || '').addPrimitive(prim);
    meshes.set(key, out);
    return out;
  };

  const trs = (node, o) =>
    node
      .setTranslation(o.position.toArray())
      .setRotation(o.quaternion.toArray())
      .setScale(o.scale.toArray());

  const walk = (o) => {
    const node = trs(doc.createNode(o.name || ''), o);
    if (o instanceof InstancedMesh) {
      const m4 = new Matrix4();
      const p = new Vector3();
      const q = new Quaternion();
      const s = new Vector3();
      const shared = mesh(o.geometry, o.material);
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m4);
        m4.decompose(p, q, s);
        node.addChild(doc.createNode('').setTranslation(p.toArray()).setRotation(q.toArray()).setScale(s.toArray()).setMesh(shared));
      }
    } else if (o instanceof Mesh) {
      node.setMesh(mesh(o.geometry, o.material, o.name));
    }
    for (const c of o.children) node.addChild(walk(c));
    return node;
  };
  scene.addChild(walk(root));
  if (!usedClearcoat) clearcoatExt.dispose();
  if (!usedSheen) sheenExt.dispose();
  if (!usedTT) ttExt.dispose();
  return doc;
}
