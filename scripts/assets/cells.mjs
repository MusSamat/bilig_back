#!/usr/bin/env node
/**
 * animal-cell.glb and plant-cell.glb: textbook-style cell models authored here
 * with three.js geometry (our own work, CC0), extending the procedural cells
 * of the approved «Bilig Workbench» prototype (bilig_ft plugin-gltf cells.ts).
 *
 *   node cells.mjs <animal|plant> <out.glb> [report.json]
 *
 * No free (CC0 / CC BY / public domain) cell model with separate, named
 * organelles was found: NIH 3D's "Animal Cell" is CC BY-NC-SA, the rest are
 * paid marketplace models or physical teaching models.
 *
 * Node names follow the topic's node masks (overrides[...].nodes), so the
 * GLB binds to the same concepts as the procedural stand-in:
 *   animal: Membrane, Cytoplasm, Nucleus (+ Nucleolus), Mito_1…4, Ribo_1…2, Golgi
 *   plant:  CellWall, Membrane, Cytoplasm, Vacuole, Nucleus (+ Nucleolus), Chloro_1…7, Mito_1…3
 * Structures without a concept in the topic (ER, lysosomes, centrioles,
 * plasmodesmata, membrane proteins) are unnamed decorative nodes. Organelles
 * sit at the topic's concept anchors, so labels and tour cameras need no change.
 *
 * Look: organic shapes from seeded 3D noise (fbm); nucleus, mitochondria and
 * chloroplasts are cut open towards the default camera, like a textbook
 * illustration, showing a double-membrane rim, cristae, grana and nucleolus.
 * Colour is per vertex (COLOR_0): the concept hue (UI chip hsl(h, 62%, 62%))
 * with noise tone variation and cavity / depth darkening baked in. Only the
 * cell's shells (wall, membrane, cytoplasm, vacuole) are translucent.
 */
import { writeFileSync } from 'node:fs';
import { Color, DoubleSide, FrontSide, Group, Mesh, MeshPhysicalMaterial, Quaternion, SRGBColorSpace, Vector3 } from 'three';
import { checkBudget, createIO, docTriangles, nodeTree, optimise } from './lib.mjs';
import { frame, hsl, makeNoise, merged, mix, normalMapPng, pillow, placed, rng, shade, surface, toDocument, topicColours, tube } from './three-gltf.mjs';

const [kind, outPath, reportPath] = process.argv.slice(2);
if (!['animal', 'plant'].includes(kind) || !outPath) {
  console.error('usage: node cells.mjs <animal|plant> <out.glb> [report.json]');
  process.exit(2);
}
const T = topicColours(kind === 'animal' ? 'animal-cell' : 'plant-cell', 'bio');
/** Default camera of the topic: cut-away organelles open towards it. */
const CAM = kind === 'animal' ? new Vector3(0, 1.5, 6) : new Vector3(0, 2, 7);

const BUMPS = await normalMapPng(7, { kind: 'bumps', strength: 2.0 });
const FIBRES = await normalMapPng(8, { kind: 'fibres', strength: 2.4 });

/** Vertex-coloured PBR material (white factor; the colour lives in COLOR_0). */
const MATS = new Map();
function mat(key, { o = 1, r = 0.5, cc = 0, ccr = 0.4, ds = false, normal = null, ns = 0.6, rep = 6, sheen = 0 } = {}) {
  if (MATS.has(key)) return MATS.get(key);
  const m = new MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: r, metalness: 0, transparent: o < 1, opacity: o, clearcoat: cc, clearcoatRoughness: ccr, side: ds ? DoubleSide : FrontSide });
  if (sheen) {
    m.sheen = sheen;
    m.sheenRoughness = 0.5;
  }
  if (normal) {
    m.userData.normalPng = normal;
    m.userData.normalScale = ns;
    m.userData.normalRepeat = rep;
  }
  MATS.set(key, m);
  return m;
}
const ORG = () => mat('organelle', { r: 0.48, cc: 0.35, ccr: 0.45, normal: BUMPS, ns: 0.35 });
const SOFT = () => mat('soft', { r: 0.6, cc: 0.15 });

function named(name, parent) {
  const g = new Group();
  g.name = name;
  parent.add(g);
  return g;
}
/**
 * Opaque organelles are seen through the translucent cell shells, which lift
 * and grey them: their vertex colours get a little more saturation and depth.
 */
const PC = new Color();
const PH = { h: 0, s: 0, l: 0 };
function punch(geo, m) {
  if (m.transparent || geo.userData.punched) return geo;
  const c = geo.attributes.color;
  for (let i = 0; i < c.count; i++) {
    PC.setRGB(c.getX(i), c.getY(i), c.getZ(i)).getHSL(PH, SRGBColorSpace);
    PC.setHSL(PH.h, Math.min(1, PH.s * 1.15), PH.l * 0.94, SRGBColorSpace);
    c.setXYZ(i, PC.r, PC.g, PC.b);
  }
  geo.userData.punched = true;
  return geo;
}
/** Decorative part: unnamed, so it binds to no concept. */
function decor(parent, geo, m) {
  const o = new Mesh(punch(geo, m), m);
  o.name = '';
  parent.add(o);
  return o;
}
const add = (parent, geo, m) => {
  const o = new Mesh(punch(geo, m), m);
  parent.add(o);
  return o;
};

const sph = (u, v) => {
  const t = u * Math.PI * 2;
  const f = v * Math.PI;
  return [Math.sin(f) * Math.cos(t), Math.cos(f), Math.sin(f) * Math.sin(t)];
};
const uvOf = (d) => {
  const l = Math.hypot(...d);
  return [(((Math.atan2(d[2], d[0]) / (Math.PI * 2)) % 1) + 1) % 1, Math.acos(Math.max(-1, Math.min(1, d[1] / l))) / Math.PI];
};
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * Tone painter: hue / saturation / lightness varied by noise, darkened in
 * creases (cav) — a baked ambient-occlusion look.
 */
function tone(N, h, s, l, { hv = 5, sv = 0.06, lv = 0.07, f = 1.8, cav = 0.06 } = {}) {
  return (p, n, u, v, c) => {
    const a = N.fbm(p[0] * f, p[1] * f, p[2] * f, 3);
    const b = N.n(p[0] * f * 3.7 + 11, p[1] * f * 3.7, p[2] * f * 3.7);
    return shade(hsl(h + hv * a, s + sv * b, l + lv * a + lv * 0.4 * b), clamp(1 - cav * c, 0.6, 1.15));
  };
}

/** Lumpy ellipsoid. */
function blob(nu, nv, N, { ax = [1, 1, 1], amp = 0.05, f = 1.5, bump = 0, bf = 6, paint, uv = [1, 1] }) {
  return surface(
    nu,
    nv,
    (u, v) => {
      const d = sph(u, v);
      const k = 1 + amp * N.fbm(d[0] * f, d[1] * f, d[2] * f, 3) + bump * N.n(d[0] * bf + 3, d[1] * bf, d[2] * bf);
      return [d[0] * ax[0] * k, d[1] * ax[1] * k, d[2] * ax[2] * k];
    },
    { paint, uv },
  );
}

/** Opening direction (world) of an organelle at `pos`: towards the camera, a bit from above. */
const facing = (pos) => CAM.clone().sub(pos).normalize().toArray();

/* ------------------------------------------------------------- nucleus */

function nucleus(root, pos, sc, { res = 1, pores = 64 } = {}) {
  const hN = T.hue('Nucleus', 280);
  const g = named('Nucleus', root);
  g.position.copy(pos);
  g.scale.setScalar(sc);
  // The cut-away octant (u < ¼, v < ½: x, y, z > 0) faces the camera.
  const view = CAM.clone().sub(pos);
  // Turn the octant's bisector (1, 0, 1) towards the camera, around y.
  g.rotation.set(0, Math.atan2(view.x, view.z) - Math.PI / 4, 0);
  const N = makeNoise(31);
  const AX = [0.95, 0.88, 0.93];
  const shape = (u, v) => {
    const d = sph(u, v);
    const k = 1 + 0.035 * N.fbm(d[0] * 1.6, d[1] * 1.6, d[2] * 1.6, 3) + 0.008 * N.n(d[0] * 9, d[1] * 9, d[2] * 9);
    return [d[0] * AX[0] * k, d[1] * AX[1] * k, d[2] * AX[2] * k];
  };
  const W = new Vector3(1, 1.15, 1).normalize();
  const outer = tone(N, hN, 0.42, 0.5, { hv: 6, lv: 0.06, f: 2.2, cav: 0.08 });
  const env = surface(Math.round(72 * res), Math.round(48 * res), shape, {
    cut: (u, v) => u < 0.25 && v < 0.5,
    thick: 0.075,
    rim: [
      [0, hsl(hN, 0.45, 0.38)],
      [0.3, hsl(hN, 0.45, 0.4)],
      [0.3, hsl(hN - 10, 0.35, 0.76)],
      [0.7, hsl(hN - 10, 0.35, 0.76)],
      [0.7, hsl(hN, 0.45, 0.4)],
      [1, hsl(hN, 0.45, 0.38)],
    ],
    paint: (p, n, u, v, c, side) => {
      if (side === 'out') return outer(p, n, u, v, c);
      const l = Math.hypot(...p);
      const depth = (p[0] * W.x + p[1] * W.y + p[2] * W.z) / l; // 1 at the opening, −1 deep inside
      const ao = 0.5 + 0.5 * smooth(-1.2, 0.8, depth);
      const het = smooth(0.05, 0.35, N.fbm(p[0] * 4, p[1] * 4, p[2] * 4, 3));
      return shade(mix(hsl(hN + 8, 0.36, 0.7), hsl(hN + 4, 0.42, 0.42), het), ao);
    },
  });
  add(g, env, ORG());
  // Nuclear pores: rings on the outer membrane.
  const R = rng(33);
  const poreGeo = surface(8, 4, (u, v) => {
    const a = u * Math.PI * 2;
    const b = v * Math.PI * 2;
    const r = 0.052 + 0.02 * Math.cos(b);
    return [Math.cos(a) * r, 0.02 * Math.sin(b), Math.sin(a) * r];
  }, { paint: () => hsl(hN - 6, 0.4, 0.33) });
  const ps = [];
  for (let i = 0; i < pores; i++) {
    const y = 1 - (2 * (i + 0.5)) / pores;
    const rr = Math.sqrt(1 - y * y);
    const t = i * 2.39996 + R() * 0.3;
    const d = [Math.cos(t) * rr, y, Math.sin(t) * rr];
    const [u, v] = uvOf(d);
    if (u < 0.27 && v < 0.52) continue;
    if ((u < 0.27 || u > 0.98) && v < 0.52) continue;
    const p = shape(u, v);
    const nrm = new Vector3(p[0] / AX[0] ** 2, p[1] / AX[1] ** 2, p[2] / AX[2] ** 2).normalize();
    ps.push(placed(poreGeo, { p: p.map((x, k) => x + nrm.getComponent(k) * 0.004), q: new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), nrm) }));
  }
  decor(g, merged(ps), SOFT());
  // Chromatin: threads winding through the nucleoplasm.
  const cm = [];
  const RC = rng(11);
  for (let k = 0; k < 9; k++) {
    const pts = [];
    let v = new Vector3((RC() - 0.5) * 0.9, (RC() - 0.5) * 0.9, (RC() - 0.5) * 0.9).clampLength(0, 0.6);
    for (let i = 0; i < 8; i++) {
      pts.push(v.clone());
      v = v.add(new Vector3((RC() - 0.5) * 0.4, (RC() - 0.5) * 0.4, (RC() - 0.5) * 0.4)).clampLength(0, 0.68);
    }
    const NC = makeNoise(100 + k);
    cm.push(tube(pts, 6, 40, (t) => 0.024 + 0.01 * NC.n(t * 6, k, 0), { paint: tone(NC, hN + 6, 0.48, 0.36, { lv: 0.05, f: 3 }) }));
  }
  decor(g, merged(cm), SOFT());
  // Nucleolus: dense granular body, in view through the opening.
  const nl = named('Nucleolus', g);
  const NN = makeNoise(4);
  const ng = blob(36, 26, NN, {
    ax: [0.3, 0.28, 0.3],
    amp: 0.12,
    f: 2.3,
    bump: 0.05,
    bf: 9,
    paint: (p, n, u, v, c) => {
      const f = smooth(0.15, 0.45, NN.fbm(p[0] * 9, p[1] * 9, p[2] * 9, 2));
      return shade(mix(hsl(hN + 12, 0.48, 0.32), hsl(hN + 18, 0.45, 0.5), f), clamp(1 - 0.1 * c, 0.6, 1.1));
    },
  });
  const nm = add(nl, ng, ORG());
  nm.position.set(0.27, 0.28, 0.27);
}

/* -------------------------------------------------------- mitochondrion */

function mito(root, name, pos, axis, sc, seed, { res = 1 } = {}) {
  const h = T.hue(name, 20);
  const g = named(name, root);
  g.position.copy(pos);
  g.quaternion.copy(frame(axis, facing(pos)));
  g.scale.setScalar(sc);
  const N = makeNoise(seed);
  const L = 1.5;
  const Rm = 0.33;
  const bend = 0.1;
  const spine = (s) => [(s - 0.5) * L, bend * (1 - (2 * s - 1) ** 2), 0];
  const rad = (s) => Rm * Math.cbrt(Math.max(0, 1 - Math.abs(2 * s - 1) ** 3));
  const sOf = (v) => 0.5 - 0.5 * Math.cos(Math.PI * v);
  const shape = (u, v) => {
    const s = sOf(v);
    const a = u * Math.PI * 2;
    const c = spine(s);
    const r = rad(s) * (1 + 0.06 * N.fbm(c[0] * 2.2, Math.cos(a) * 0.8, Math.sin(a) * 0.8, 3));
    return [c[0], c[1] + Math.cos(a) * r, c[2] + Math.sin(a) * r * 0.86];
  };
  const thick = 0.07;
  const open = 0.16; // half-width of the opening, in turns
  const outer = tone(N, h - 4, 0.74, 0.5, { hv: 5, lv: 0.06, f: 2.5, cav: 0.09 });
  const shell = surface(Math.round(36 * res), Math.round(30 * res), shape, {
    cut: (u) => Math.abs(u - 0.25) < open,
    thick,
    rim: [
      [0, hsl(h - 6, 0.62, 0.42)],
      [0.32, hsl(h - 6, 0.62, 0.44)],
      [0.32, hsl(h + 10, 0.55, 0.78)],
      [0.62, hsl(h + 10, 0.55, 0.78)],
      [0.62, hsl(h + 2, 0.66, 0.5)],
      [1, hsl(h + 2, 0.66, 0.5)],
    ],
    paint: (p, n, u, v, c, side) => {
      if (side === 'out') return outer(p, n, u, v, c);
      const depth = clamp((p[2] / (Rm * 0.86) + 1) / 1.5);
      const ends = smooth(0.0, 0.25, Math.min(sOf(v), 1 - sOf(v)));
      const gr = N.fbm(p[0] * 7, p[1] * 7, p[2] * 7, 2);
      return shade(hsl(h - 10 + 4 * gr, 0.6, 0.34 + 0.05 * gr), 0.5 + 0.5 * depth * (0.6 + 0.4 * ends));
    },
  });
  add(g, shell, ORG());
  // Cristae: shelves of the inner membrane, alternately from either wall.
  const cr = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const s = 0.17 + (i * 0.66) / (n - 1);
    const side = i % 2 ? 1 : -1;
    const [a0, a1] = side > 0 ? [-1.45, 0.42] : [Math.PI - 0.42, Math.PI + 1.45];
    const c = spine(s);
    const rIn = rad(s) - thick * 1.1;
    const NC = makeNoise(seed * 10 + i);
    cr.push(
      pillow(
        16,
        10,
        (U, V) => {
          const ta = (U + 1) / 2;
          const w = (V + 1) / 2;
          const a = a0 + (a1 - a0) * ta;
          const f = 1.08 - w * 0.62 * (0.85 + 0.3 * Math.sin(ta * Math.PI));
          const fold = 0.04 * Math.sin(Math.PI * w * 1.7 + i) + 0.025 * Math.sin(ta * Math.PI * 3 + i);
          return { p: [c[0] + fold, c[1] + Math.cos(a) * rIn * f, c[2] + Math.sin(a) * rIn * 0.86 * f], n: [1, 0, 0] };
        },
        (U, V) => 0.032 * (1 - 0.25 * ((V + 1) / 2)),
        {
          square: true,
          profile: 0.6,
          paint: (p, nn, U, V, cv, y) => {
            const w = (V + 1) / 2;
            const t = NC.fbm(p[0] * 6, p[1] * 6, p[2] * 6, 2);
            return shade(hsl(h + 6 + 4 * t, 0.8, 0.6 + 0.05 * t), (0.6 + 0.4 * w) * (0.8 + 0.2 * Math.abs(y)));
          },
        },
      ),
    );
  }
  add(g, merged(cr), ORG());
}

/* ----------------------------------------------------------- chloroplast */

function chloro(root, name, pos, axis, sc, seed) {
  const h = T.hue(name, 120);
  const g = named(name, root);
  g.position.copy(pos);
  g.quaternion.copy(frame(axis, facing(pos)));
  g.scale.setScalar(sc);
  const N = makeNoise(seed);
  const A = 0.74;
  const B = 0.43;
  const C = 0.32;
  const sOf = (v) => 0.5 - 0.5 * Math.cos(Math.PI * v);
  const shape = (u, v) => {
    const s = sOf(v);
    const a = u * Math.PI * 2;
    const x = (s - 0.5) * 2;
    const r = Math.sqrt(Math.max(0, 1 - x * x)) ** 0.9 * (1 + 0.04 * N.fbm(x * 2, Math.cos(a), Math.sin(a), 3));
    return [x * A, Math.cos(a) * B * r, Math.sin(a) * C * r];
  };
  const thick = 0.05;
  const open = 0.15;
  const outer = tone(N, h, 0.56, 0.38, { hv: 6, lv: 0.06, f: 2.5, cav: 0.08 });
  const shell = surface(34, 24, shape, {
    cut: (u) => Math.abs(u - 0.25) < open,
    thick,
    rim: [
      [0, hsl(h, 0.5, 0.34)],
      [0.32, hsl(h, 0.5, 0.36)],
      [0.32, hsl(h - 25, 0.45, 0.78)],
      [0.62, hsl(h - 25, 0.45, 0.78)],
      [0.62, hsl(h, 0.5, 0.38)],
      [1, hsl(h, 0.5, 0.38)],
    ],
    paint: (p, n, u, v, c, side) => {
      if (side === 'out') return outer(p, n, u, v, c);
      const depth = clamp((p[2] / C + 1) / 1.4);
      const t = N.fbm(p[0] * 5, p[1] * 5, p[2] * 5, 2);
      return shade(hsl(h - 35 + 6 * t, 0.55, 0.56 + 0.05 * t), 0.6 + 0.4 * depth);
    },
  });
  add(g, shell, ORG());
  // Grana: stacks of thylakoid discs, stacked across the width so the cut shows them side-on.
  const R = rng(seed);
  const disc = (shadeK) =>
    pillow(
      10,
      4,
      (U, V) => ({ p: [U, 0, V], n: [0, 1, 0] }),
      () => 0.5,
      { profile: 0.3, paint: (p, n, U, V, c, y) => shade(hsl(h + 6, 0.7, 0.27 + 0.07 * shadeK), 0.65 + 0.35 * Math.abs(y)) },
    );
  const discs = [disc(0), disc(1)];
  const parts = [];
  const stacks = [];
  const Ai = A - thick * 1.6;
  const Bi = B - thick * 1.6;
  const Ci = C - thick * 1.6;
  const inner = (x, y) => Ci * Math.sqrt(Math.max(0, 1 - (x / Ai) ** 2 - (y / Bi) ** 2));
  const dz = 0.03;
  for (const gx of [-0.4, 0, 0.4]) {
    const x = gx + (R() - 0.5) * 0.07;
    const zc = -0.07 - R() * 0.03;
    const wy = Bi * Math.sqrt(Math.max(0, 1 - (x / Ai) ** 2 - (zc / Ci) ** 2)) - 0.04;
    const across = wy > 0.22 ? 2 : 1;
    for (let k = 0; k < across; k++) {
      const n = Math.min(5 + Math.floor(R() * 4), Math.floor(((2 * wy) / across) / dz));
      const yc = across === 1 ? (R() - 0.5) * 0.06 : (k ? 1 : -1) * (wy / 2 + 0.01);
      const r = Math.min(0.115, 0.09 + R() * 0.025, Math.sqrt(Math.max(0.0001, 1 - (x / Ai) ** 2)) * Ci + zc - 0.01);
      const y0 = yc - ((n - 1) * dz) / 2;
      for (let i = 0; i < n; i++) parts.push(placed(discs[i % 2], { p: [x + (R() - 0.5) * 0.01, y0 + i * dz, zc + (R() - 0.5) * 0.01], s: [r, 0.012, r] }));
      stacks.push({ x, zc, y0, n, r });
    }
  }
  const thy = merged(parts);
  // Stroma lamellae: thin sheets joining neighbouring grana.
  const lam = [];
  for (let i = 0; i < stacks.length; i++)
    for (let j = i + 1; j < stacks.length; j++) {
      const a = stacks[i];
      const b = stacks[j];
      if (Math.abs(a.x - b.x) < 0.1 || Math.abs(a.x - b.x) > 0.5) continue;
      for (let m = 0; m < 2; m++) {
        const pa = [a.x, a.y0 + Math.floor(R() * a.n) * dz, a.zc];
        const pb = [b.x, b.y0 + Math.floor(R() * b.n) * dz, b.zc];
        lam.push(
          pillow(8, 6, (U, V) => {
            const t = (U + 1) / 2;
            return { p: [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t + V * 0.045], n: [0, 1, 0] };
          }, () => 0.006, { square: true, paint: () => hsl(h + 4, 0.55, 0.38) }),
        );
      }
    }
  // Starch grain and plastoglobuli.
  const extra = [];
  const NS = makeNoise(seed + 5);
  const sx = (R() < 0.5 ? -1 : 1) * 0.28;
  extra.push(placed(blob(14, 10, NS, { ax: [0.11, 0.07, 0.05], amp: 0.06, paint: tone(NS, 45, 0.3, 0.86, { lv: 0.03 }) }), { p: [sx, 0, -inner(sx, 0) + 0.05] }));
  for (let k = 0; k < 4; k++) {
    const x = (R() - 0.5) * 0.9;
    const y = (R() - 0.5) * 0.5;
    extra.push(placed(blob(8, 6, NS, { ax: [0.025, 0.025, 0.025], amp: 0, paint: () => hsl(48, 0.75, 0.5) }), { p: [x, y, -inner(x, y) + 0.03] }));
  }
  add(g, merged([thy, ...lam, ...extra]), ORG());
}

/* ---------------------------------------------------------------- Golgi */

function golgiStack(parent, pos, q, sc, seed, hue) {
  const g = new Group();
  g.position.copy(pos);
  g.quaternion.copy(q);
  g.scale.setScalar(sc);
  parent.add(g);
  const N = makeNoise(seed);
  const R = rng(seed);
  const parts = [];
  const ves = [];
  const vesGeo = (k) => blob(10, 8, N, { ax: [1, 1, 1], amp: 0.05, paint: tone(N, hue + 4 + k, 0.72, 0.6, { lv: 0.05 }) });
  const K = 6;
  for (let k = 0; k < K; k++) {
    const y0 = (k - (K - 1) / 2) * 0.15;
    const a = 0.66 * (1 - 0.07 * Math.abs(k - (K - 1) / 2)) * (k === K - 1 ? 0.85 : 1);
    const b = 0.38 * (1 - 0.05 * Math.abs(k - (K - 1) / 2));
    const curv = 0.42;
    const hk = hue - 10 + k * 4;
    const out = (U, V) => {
      const th = Math.atan2(V, U);
      return 1 + 0.13 * N.n(Math.cos(th) * 1.4 + k * 3.1, Math.sin(th) * 1.4, k);
    };
    const S = (U, V) => {
      const rho = out(U, V);
      const x = U * a * rho;
      const z = V * b * rho;
      const y = y0 + curv * x * x + 0.15 * z * z + 0.025 * N.n(x * 3, z * 3, k);
      const n = new Vector3(-2 * curv * x, 1, -0.3 * z).normalize();
      return { p: [x, y, z], n: n.toArray() };
    };
    parts.push(
      pillow(40, 12, S, (U, V) => 0.026 * (0.6 + 0.7 * (U * U + V * V) ** 3), {
        profile: 0.55,
        paint: (p, n, U, V, c, y) => {
          const t = N.fbm(p[0] * 4, p[1] * 4, p[2] * 4, 2);
          return shade(hsl(hk + 4 * t, 0.84, (k % 2 ? 0.58 : 0.5) + 0.04 * t), 0.62 + 0.38 * Math.abs(y));
        },
      }),
    );
    // Vesicles budding off the swollen rims.
    for (const sgn of [-1, 1]) {
      if (R() < 0.35) continue;
      const e = S(sgn * 0.98, (R() - 0.5) * 0.6);
      const r = 0.05 + R() * 0.025;
      ves.push(placed(vesGeo(k), { p: [e.p[0] + sgn * r * 0.9, e.p[1], e.p[2]], s: r }));
    }
  }
  // Free transport vesicles near the trans face.
  for (let i = 0; i < 9; i++) {
    const a = R() * Math.PI * 2;
    const r = 0.04 + R() * 0.035;
    ves.push(placed(vesGeo(6), { p: [Math.cos(a) * (0.45 + R() * 0.35), 0.45 + R() * 0.25, Math.sin(a) * (0.3 + R() * 0.2)], s: r }));
  }
  return { g, geo: merged([...parts, ...ves]) };
}

/* ----------------------------------------------------------------- ER */

/** Rough ER: folded, stacked sheets hugging the nucleus. Returns the sheet geometry and ribosome studs. */
function roughER(centre, dir, radii, span, seed, hue) {
  const N = makeNoise(seed);
  const R = rng(seed);
  const d = new Vector3(...dir).normalize();
  const up0 = new Vector3(0, 1, 0);
  const side = new Vector3().crossVectors(up0, d).normalize();
  const up = new Vector3().crossVectors(d, side).normalize();
  const sheets = [];
  const studs = [];
  radii.forEach((r0, k) => {
    const h = 0.032;
    const S = (U, V) => {
      const a = U * span[0] * (1 + 0.1 * N.n(V * 2, k, 1));
      const b = V * span[1];
      const fold = 0.075 * Math.sin(U * 7 + V * 1.2) + 0.03 * N.fbm(U * 1.6, V * 1.6, k * 0.4, 2);
      const rr = r0 + fold;
      const dirv = d.clone().multiplyScalar(Math.cos(a) * Math.cos(b)).addScaledVector(side, Math.sin(a) * Math.cos(b)).addScaledVector(up, Math.sin(b));
      const p = dirv.clone().multiplyScalar(rr).add(centre);
      return { p: p.toArray(), n: dirv.toArray() };
    };
    sheets.push(
      pillow(44, 14, S, (U, V) => h * (0.75 + 0.5 * (U * U + V * V) ** 2), {
        profile: 0.6,
        paint: (p, n, U, V, c, y) => {
          const t = N.fbm(p[0] * 3, p[1] * 3, p[2] * 3, 2);
          return shade(hsl(hue + 6 * t + k * 3, 0.4, 0.58 + 0.05 * t), (0.7 + 0.3 * Math.abs(y)) * (0.86 + 0.06 * k));
        },
      }),
    );
    const n = Math.round(30 + 12 * k);
    for (let i = 0; i < n; i++) {
      const U = (R() * 2 - 1) * 0.86;
      const V = (R() * 2 - 1) * 0.8;
      if (U * U + V * V > 0.85) continue;
      const s = S(U, V);
      const o = h * (0.75 + 0.5 * (U * U + V * V) ** 2) + 0.022;
      studs.push(new Vector3(s.p[0] + s.n[0] * o, s.p[1] + s.n[1] * o, s.p[2] + s.n[2] * o));
    }
  });
  return { geo: merged(sheets), studs };
}

function smoothER(centre, spread, seed, hue, n = 6) {
  const R = rng(seed);
  const N = makeNoise(seed);
  const parts = [];
  for (let k = 0; k < n; k++) {
    const pts = [];
    let v = centre.clone().add(new Vector3((R() - 0.5) * spread * 0.4, (R() - 0.5) * spread * 0.4, (R() - 0.5) * spread * 0.4));
    let dir = new Vector3(R() - 0.5, R() - 0.5, R() - 0.5).normalize();
    for (let i = 0; i < 7; i++) {
      pts.push(v.clone());
      dir = dir.add(new Vector3((R() - 0.5) * 1.2, (R() - 0.5) * 1.2, (R() - 0.5) * 1.2)).normalize();
      v = v.clone().addScaledVector(dir, spread * 0.22);
    }
    parts.push(tube(pts, 7, 48, (t) => 0.045 * (1 + 0.35 * N.n(t * 7, k, 0.5)), { paint: tone(N, hue, 0.32, 0.64, { lv: 0.06, f: 3 }) }));
  }
  return merged(parts);
}

/** Ribosomes: small two-lobed granules merged into one mesh. */
function ribosomeGeo(points, size, seed, hue) {
  const R = rng(seed);
  const N = makeNoise(seed);
  const variants = [0, 1, 2].map((k) => {
    const big = blob(6, 4, N, { ax: [1, 0.8, 0.9], amp: 0.1, paint: () => hsl(hue - 2 + k * 3, 0.56, 0.46 + k * 0.03) });
    const small = placed(blob(5, 3, N, { ax: [0.75, 0.55, 0.7], amp: 0.1, paint: () => hsl(hue + 4, 0.5, 0.56) }), { p: [0, 0.62, 0] });
    return merged([big, small]);
  });
  return merged(
    points.map((p, i) =>
      placed(variants[i % 3], {
        p: p.toArray(),
        q: new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(R() - 0.5, R() - 0.5, R() - 0.5).normalize()),
        s: size * (0.85 + R() * 0.3),
      }),
    ),
  );
}

/* --------------------------------------------------------------- utils */

function insideEllipsoid(ax, margin = 1) {
  return (v) => (v.x * v.x) / (ax[0] * ax[0]) + (v.y * v.y) / (ax[1] * ax[1]) + (v.z * v.z) / (ax[2] * ax[2]) <= margin;
}
function scatter(n, extent, ok, seed) {
  const R = rng(seed);
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 400) {
    const v = new Vector3((R() * 2 - 1) * extent[0], (R() * 2 - 1) * extent[1], (R() * 2 - 1) * extent[2]);
    if (ok(v)) out.push(v);
  }
  return out;
}

/** Cell shell (membrane / cytoplasm / wall): displaced superellipsoid. */
function shellGeo(nu, nv, ax, n, N, { amp = 0.02, f = 1.2, bump = 0.006, bf = 8, paint, uv = [1, 1], thick = 0 }) {
  return surface(
    nu,
    nv,
    (u, v) => {
      const d = sph(u, v);
      const e = d.map((x) => Math.sign(x) * Math.abs(x) ** n);
      const k = 1 + amp * N.fbm(d[0] * f, d[1] * f, d[2] * f, 3) + bump * N.n(d[0] * bf, d[1] * bf, d[2] * bf);
      return [e[0] * ax[0] * k, e[1] * ax[1] * k, e[2] * ax[2] * k];
    },
    { paint, uv, thick },
  );
}

/** Lysosome-like vesicles with granular content (decorative). */
function lysosomes(points, seed, hue) {
  const N = makeNoise(seed);
  return merged(
    points.map(([p, r], i) =>
      placed(
        blob(18, 12, N, {
          ax: [1, 0.92, 0.96],
          amp: 0.08,
          bump: 0.03,
          bf: 7 + i,
          paint: (q, n, u, v, c) => {
            const t = smooth(0.1, 0.4, N.fbm(q[0] * 5 + i, q[1] * 5, q[2] * 5, 2));
            return shade(mix(hsl(hue, 0.34, 0.5), hsl(hue - 8, 0.4, 0.34), t), clamp(1 - 0.1 * c, 0.6, 1.1));
          },
        }),
        { p, s: r },
      ),
    ),
  );
}

/* ---------------------------------------------------------------- cells */

function animalCell() {
  const root = new Group();
  root.name = 'AnimalCell';
  const AX = [2.85, 2.3, 2.4];
  const hMem = T.hue('Membrane', 200);
  const NM = makeNoise(2);
  const mem = named('Membrane', root);
  add(
    mem,
    shellGeo(120, 80, AX, 1, NM, {
      amp: 0.03,
      f: 1.2,
      bump: 0.006,
      paint: (p, n, u, v, c) => {
        const t = NM.fbm(p[0] * 1.5, p[1] * 1.5, p[2] * 1.5, 3);
        return shade(hsl(hMem - 4 + 6 * t, 0.55, 0.55 + 0.06 * t), clamp(1 - 0.08 * c, 0.7, 1.1));
      },
    }),
    mat('membrane', { o: 0.24, r: 0.3, cc: 0.4, ccr: 0.25, ds: true, normal: BUMPS, ns: 0.4, rep: 14 }),
  );
  const cy = named('Cytoplasm', root);
  const NCy = makeNoise(5);
  add(
    cy,
    shellGeo(64, 44, AX.map((x) => x * 0.95), 1, NCy, { amp: 0.02, paint: tone(NCy, T.hue('Cytoplasm', 185), 0.45, 0.62, { lv: 0.05 }) }),
    mat('cytoplasm', { o: 0.1, r: 0.5, ds: true }),
  );

  const NUC = new Vector3(0, 0.2, 0);
  nucleus(root, NUC, 1);
  mito(root, 'Mito_1', new Vector3(1.4, -0.3, 0.6), [1, -0.55, -0.3], 0.85, 41);
  mito(root, 'Mito_2', new Vector3(-1.55, -1.0, 0.35), [1, 0.5, 0.35], 0.85, 42);
  mito(root, 'Mito_3', new Vector3(0.55, -1.45, -0.85), [1, 0.15, 0.4], 0.8, 43);
  mito(root, 'Mito_4', new Vector3(1.6, 0.95, -0.65), [0.45, 1, -0.2], 0.8, 44);

  const hG = T.hue('Golgi', 50);
  const GP = new Vector3(-1.25, -0.9, -0.6);
  const golgi = named('Golgi', root);
  const gs = golgiStack(golgi, GP, frame([1, 0.1, 0], [0.03, -0.3, 0.96]), 0.95, 51, hG - 10);
  add(gs.g, gs.geo, ORG());

  // Rough ER wraps the left-front of the nucleus (the Ribo_1 anchor); ribosomes stud it, more float free.
  const hER = 228;
  const er = roughER(NUC, [-1, 0.2, 0.25], [1.2, 1.36, 1.52, 1.68], [0.8, 0.3], 21, hER);
  decor(root, er.geo, ORG());
  const hR = T.hue('Ribo_1', 330);
  const ok = insideEllipsoid(AX, 0.78);
  const avoid = [
    [NUC, 1.65],
    [GP, 0.85],
    [new Vector3(1.4, -0.3, 0.6), 0.75],
    [new Vector3(-1.55, -1.0, 0.35), 0.75],
    [new Vector3(0.55, -1.45, -0.85), 0.7],
    [new Vector3(1.6, 0.95, -0.65), 0.7],
  ];
  const free = scatter(70, AX, (v) => ok(v) && avoid.every(([c, r]) => v.distanceTo(c) >= r), 7);
  const r1 = named('Ribo_1', root);
  add(r1, ribosomeGeo(er.studs, 0.034, 61, hR), ORG());
  const r2 = named('Ribo_2', root);
  add(r2, ribosomeGeo(free, 0.046, 62, hR), ORG());
  decor(root, smoothER(new Vector3(1.0, 0.3, -1.2), 1.0, 33, hER + 8, 6), ORG());

  // Lysosomes and a centriole pair (decorative).
  decor(
    root,
    lysosomes(
      [
        [[-0.45, 1.7, -0.5], 0.17],
        [[1.2, 1.5, 0.55], 0.15],
        [[-2.05, 0.45, -0.8], 0.18],
        [[0.95, -1.85, 0.2], 0.15],
        [[-1.0, -0.4, 1.75], 0.16],
        [[2.0, -0.4, -0.6], 0.13],
      ],
      71,
      300,
    ),
    ORG(),
  );
  {
    const parts = [];
    const NT = makeNoise(80);
    const mt = tube([new Vector3(0, -0.17, 0), new Vector3(0, 0.17, 0)], 6, 4, () => 0.017, { paint: tone(NT, 40, 0.22, 0.66, { lv: 0.04 }), cap: 0.12 });
    for (const [q, off] of [
      [new Quaternion(), [0, 0, 0]],
      [new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(0, 0, 1)), [0.24, 0.02, 0.06]],
    ]) {
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        for (let j = 0; j < 3; j++) {
          const rr = 0.075 + j * 0.022;
          const aa = a + j * 0.16;
          const p = new Vector3(Math.cos(aa) * rr, 0, Math.sin(aa) * rr).applyQuaternion(q);
          parts.push(placed(placed(mt, { q }), { p: [p.x + off[0], p.y + off[1], p.z + off[2]] }));
        }
      }
    }
    const cen = decor(root, merged(parts), SOFT());
    cen.position.set(0.95, 1.25, 0.3);
  }
  return root;
}

/** Superellipsoid helper for the plant cell's rounded-box shells. */
function plantCell() {
  const root = new Group();
  root.name = 'PlantCell';
  const hW = T.hue('CellWall', 95);
  const NW = makeNoise(12);
  const wall = named('CellWall', root);
  add(
    wall,
    shellGeo(64, 44, [3.42, 2.32, 2.32], 0.5, NW, {
      amp: 0.012,
      f: 1,
      bump: 0.004,
      paint: (p, n, u, v, c, side) => {
        const fib = NW.n(p[0] * 1.2, p[1] * 9, p[2] * 9);
        const t = NW.fbm(p[0] * 1.4, p[1] * 1.4, p[2] * 1.4, 3);
        return shade(hsl(hW + 5 * t, 0.42, 0.5 + 0.05 * t + 0.04 * fib), clamp(1 - 0.06 * c, 0.75, 1.1));
      },
    }),
    mat('wall', { o: 0.3, r: 0.65, ds: true }),
  );
  const mem = named('Membrane', root);
  const NM = makeNoise(13);
  add(mem, shellGeo(64, 44, [3.12, 2.05, 2.05], 0.5, NM, { amp: 0.015, paint: tone(NM, T.hue('Membrane', 200), 0.5, 0.55, { lv: 0.05 }) }), mat('membrane', { o: 0.2, r: 0.3, cc: 0.4, ccr: 0.25, ds: true, normal: BUMPS, ns: 0.4, rep: 14 }));
  const cy = named('Cytoplasm', root);
  const NC = makeNoise(14);
  add(cy, shellGeo(56, 40, [2.98, 1.92, 1.92], 0.5, NC, { amp: 0.015, paint: tone(NC, T.hue('Cytoplasm', 185), 0.3, 0.6, { lv: 0.05 }) }), mat('cytoplasm', { o: 0.1, r: 0.5, ds: true }));

  const vac = named('Vacuole', root);
  const NV = makeNoise(16);
  const hV = T.hue('Vacuole', 210);
  const vg = blob(64, 44, NV, {
    ax: [1.45, 1.0, 0.95],
    amp: 0.07,
    f: 1.3,
    bump: 0.008,
    bf: 6,
    paint: (p, n, u, v, c) => {
      const t = NV.fbm(p[0] * 1.6, p[1] * 1.6, p[2] * 1.6, 3);
      return shade(hsl(hV + 6 * t, 0.7, 0.5 + 0.06 * t), clamp(1 - 0.08 * c, 0.7, 1.1));
    },
  });
  const vm = add(vac, vg, mat('vacuole', { o: 0.66, r: 0.15, cc: 0.8, ccr: 0.12, ds: true }));
  vm.position.set(0.2, -0.1, -0.1);

  nucleus(root, new Vector3(-1.3, 0.6, 0.4), 0.62, { res: 0.8, pores: 48 });
  const ch = [
    [[1.5, 0.8, 0.6], [1, -0.15, 0.1]],
    [[-0.3, 1.5, 0.75], [1, 0.1, -0.1]],
    [[0.7, -1.5, 0.85], [1, 0.05, 0.2]],
    [[2.3, -0.75, 0.55], [0.35, 1, 0]],
    [[-2.45, -1.0, 0.45], [-0.3, 1, 0.1]],
    [[-1.9, 1.2, -0.95], [1, -0.4, 0]],
    [[1.0, 1.45, -0.95], [1, 0.2, 0.1]],
  ];
  ch.forEach(([p, a], i) => chloro(root, `Chloro_${i + 1}`, new Vector3(...p), a, 0.95, 90 + i));
  mito(root, 'Mito_1', new Vector3(1.2, -1.0, 0.5), [1, 0.6, 0], 0.6, 141, { res: 0.8 });
  mito(root, 'Mito_2', new Vector3(-0.9, -1.3, -0.9), [1, -0.3, 0.3], 0.6, 142, { res: 0.8 });
  mito(root, 'Mito_3', new Vector3(2.45, 0.6, -0.7), [0.3, 1, 0], 0.55, 143, { res: 0.8 });
  // A small Golgi stack and smooth ER near the nucleus (no concept in this topic: decorative).
  decor(root, smoothER(new Vector3(-2.1, -0.1, -0.2), 0.8, 41, 258, 4), ORG());
  const gs = golgiStack(root, new Vector3(-0.6, -0.2, 1.25), frame([1, 0.1, 0], [0, 1, 0.6]), 0.55, 52, T.hue('Golgi', 50) - 8);
  gs.g.name = '';
  decor(gs.g, gs.geo, ORG());
  return root;
}

const root = kind === 'animal' ? animalCell() : plantCell();
const doc = toDocument(root);
const io = await createIO();
const before = (await io.writeBinary(doc)).byteLength;
await optimise(doc, { ratio: 1 });
const glb = await io.writeBinary(doc);
const tris = docTriangles(doc);
checkBudget(outPath, glb.byteLength, tris);
writeFileSync(outPath, glb);
const report = { sizeBefore: before, sizeAfter: glb.byteLength, trianglesAfter: tris, textures: doc.getRoot().listTextures().length, nodes: nodeTree(doc).filter((l) => !/^\s*(_Mesh)?( \[\d+\])?$/.test(l)) };
if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`${outPath}: ${glb.byteLength} bytes, ${tris} triangles`);
