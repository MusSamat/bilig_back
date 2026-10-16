#!/usr/bin/env node
/**
 * animal-cell.glb and plant-cell.glb: schoolbook cell models authored here
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
 * plasmodesmata) are unnamed decorative nodes. Organelles sit at the topic's
 * concept anchors, so labels and tour cameras need no change.
 * Colours: concept hue, hsl(h, 62%, 62%) (scene-core conceptColor), details tinted.
 */
import { writeFileSync } from 'node:fs';
import {
  CapsuleGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Mesh,
  MeshPhysicalMaterial,
  Object3D,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
  Color,
} from 'three';
import { checkBudget, createIO, docTriangles, nodeTree, optimise } from './lib.mjs';
import { rng, tint, toDocument, topicColours } from './three-gltf.mjs';

const [kind, outPath, reportPath] = process.argv.slice(2);
if (!['animal', 'plant'].includes(kind) || !outPath) {
  console.error('usage: node cells.mjs <animal|plant> <out.glb> [report.json]');
  process.exit(2);
}
const T = topicColours(kind === 'animal' ? 'animal-cell' : 'plant-cell', 'bio');

/** PBR material (three r169 converts the sRGB colour to linear). */
function M(color, { o = 1, r = 0.42, cc = 0, ds = false, em, ei = 0 } = {}) {
  const m = new MeshPhysicalMaterial({ color: new Color(color), roughness: r, metalness: 0, transparent: o < 1, opacity: o, clearcoat: cc, clearcoatRoughness: 0.3, side: ds ? DoubleSide : 0 });
  if (em) {
    m.emissive = new Color(em);
    m.emissiveIntensity = ei;
  }
  return m;
}
const mesh = (g, m) => new Mesh(g, m);
function named(name, parent) {
  const g = new Group();
  g.name = name;
  parent.add(g);
  return g;
}
/** Decorative part: unnamed, so it binds to no concept. */
function decor(parent, o) {
  o.name = '';
  parent.add(o);
  return o;
}

/** Lumpy sphere (organic outline). */
function blob(r, amp, seed, w = 48, h = 36) {
  const g = new SphereGeometry(r, w, h);
  const p = g.attributes.position;
  const v = new Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = 1 + amp * Math.sin((3 * v.x) / r + seed) * Math.sin((4 * v.y) / r + 1) * Math.sin((5 * v.z) / r + 2);
    p.setXYZ(i, v.x * k, v.y * k, v.z * k);
  }
  g.computeVertexNormals();
  return g;
}
/** Rounded box (superellipsoid), the plant cell's shape. */
function squircle(sx, sy, sz, n, w = 56, h = 40) {
  const g = new SphereGeometry(1, w, h);
  const p = g.attributes.position;
  const v = new Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    p.setXYZ(i, Math.sign(v.x) * Math.abs(v.x) ** n * sx, Math.sign(v.y) * Math.abs(v.y) ** n * sy, Math.sign(v.z) * Math.abs(v.z) ** n * sz);
  }
  g.computeVertexNormals();
  return g;
}
function fib(n, r) {
  const a = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const rr = Math.sqrt(1 - y * y);
    const t = i * 2.39996;
    a.push(new Vector3(Math.cos(t) * rr * r, y * r, Math.sin(t) * rr * r));
  }
  return a;
}

function nucleus(root, pos, sc) {
  const col = T.colour('Nucleus', '#8a63d2');
  const g = named('Nucleus', root);
  g.position.copy(pos);
  g.scale.setScalar(sc);
  g.add(mesh(blob(0.95, 0.03, 1), M(col, { o: 0.72, r: 0.45, cc: 0.5, ds: true })));
  // Nuclear pores on the envelope.
  const pm = M(tint(col, -20), { r: 0.5 });
  const tg = new TorusGeometry(0.075, 0.024, 6, 14);
  for (const p of fib(36, 0.965)) {
    const t = mesh(tg, pm);
    t.position.copy(p);
    t.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), p.clone().normalize());
    g.add(t);
  }
  // Chromatin: loose dark threads inside.
  const R = rng(11);
  const cm = M(tint(col, -30, -10), { r: 0.7 });
  for (let k = 0; k < 7; k++) {
    const pts = [];
    let v = new Vector3((R() - 0.5) * 0.9, (R() - 0.5) * 0.9, (R() - 0.5) * 0.9);
    for (let i = 0; i < 7; i++) {
      pts.push(v.clone());
      v = v.add(new Vector3((R() - 0.5) * 0.45, (R() - 0.5) * 0.45, (R() - 0.5) * 0.45)).clampLength(0, 0.75);
    }
    g.add(mesh(new TubeGeometry(new CatmullRomCurve3(pts), 28, 0.025, 5, false), cm));
  }
  const nl = named('Nucleolus', g);
  const n = mesh(blob(0.34, 0.09, 4, 32, 24), M(tint(col, -28), { r: 0.6, cc: 0.3 }));
  n.position.set(0.18, 0.12, 0.28);
  nl.add(n);
}

function mito(root, name, pos, rot, sc) {
  const col = T.colour(name, '#f08a5d');
  const g = named(name, root);
  g.position.copy(pos);
  g.rotation.set(...rot);
  g.scale.setScalar(sc);
  g.add(mesh(new CapsuleGeometry(0.3, 0.85, 8, 24), M(col, { o: 0.68, r: 0.35, cc: 0.8, ds: true })));
  // Cristae: folded inner membrane as alternating plates.
  const cm = M(tint(col, 16), { r: 0.5 });
  for (let i = 0; i < 7; i++) {
    const d = mesh(new CylinderGeometry(0.22, 0.22, 0.028, 20, 1), cm);
    d.position.y = -0.48 + i * 0.16;
    d.position.x = i % 2 ? 0.04 : -0.04;
    d.rotation.z = i % 2 ? 0.14 : -0.14;
    d.scale.x = 0.88;
    g.add(d);
  }
  g.add(mesh(new CapsuleGeometry(0.24, 0.8, 6, 18), M(tint(col, -10), { o: 0.35, r: 0.6 })));
}

function chloro(root, name, pos, rot, sc = 1) {
  const col = T.colour(name, '#4fae5b');
  const g = named(name, root);
  g.position.copy(pos);
  g.rotation.set(...rot);
  g.scale.setScalar(sc);
  const e = mesh(new SphereGeometry(0.42, 36, 24), M(col, { o: 0.7, r: 0.35, cc: 0.7, ds: true }));
  e.scale.set(1.75, 1, 0.95);
  g.add(e);
  // Grana: stacks of thylakoid discs joined by stroma lamellae.
  const gm = M(tint(col, -22), { r: 0.45 });
  const disc = new CylinderGeometry(0.13, 0.13, 0.034, 18, 1);
  for (const x of [-0.46, 0, 0.46]) {
    for (let i = 0; i < 5; i++) {
      const d = mesh(disc, gm);
      d.position.set(x, -0.19 + i * 0.085, x === 0 ? 0.05 : -0.04);
      g.add(d);
    }
  }
  const st = mesh(new CylinderGeometry(0.018, 0.018, 0.95, 6), gm);
  st.rotation.z = Math.PI / 2;
  st.position.y = -0.02;
  g.add(st);
}

function golgi(root, pos, rotZ, sc = 1) {
  const col = T.colour('Golgi', '#f2b84b');
  const g = named('Golgi', root);
  g.position.copy(pos);
  g.rotation.set(0.3, 0.4, rotZ);
  g.scale.setScalar(sc);
  for (let i = 0; i < 6; i++) {
    const tr = mesh(new TorusGeometry(0.62 - 0.045 * Math.abs(i - 2.5), 0.06, 10, 40, Math.PI * 1.15), M(col, { r: 0.35, cc: 0.5 }));
    tr.rotation.x = Math.PI / 2;
    tr.position.y = i * 0.17 - 0.42;
    g.add(tr);
  }
  const vm = M(tint(col, 8), { cc: 0.5 });
  const vg = new SphereGeometry(0.085, 14, 10);
  for (const p of [[0.75, 0.1, 0.3], [-0.55, 0.05, 0.55], [0.1, 0.4, -0.68], [0.85, -0.2, -0.3], [0.95, 0.35, 0.05]]) {
    const v = mesh(vg, vm);
    v.position.set(p[0], p[1] - 0.5, p[2]);
    g.add(v);
  }
}

/** Ribosomes as instances (one named group = one concept node). */
function ribosomes(root, name, points, size = 0.05) {
  const col = T.colour(name, '#c0587e');
  const g = named(name, root);
  const im = new InstancedMesh(new SphereGeometry(size, 10, 8), M(tint(col, -4), { r: 0.45, cc: 0.4 }), points.length);
  const d = new Object3D();
  points.forEach((p, i) => {
    d.position.copy(p);
    d.updateMatrix();
    im.setMatrixAt(i, d.matrix);
  });
  g.add(im);
}

/** Rough ER: curved partial shells around the nucleus, studded with ribosomes. Returns the stud points. */
function roughER(root, centre, radii, phi, theta, colour, seed) {
  const R = rng(seed);
  const studs = [];
  const m = M(colour, { o: 0.55, r: 0.4, cc: 0.3, ds: true });
  for (const r of radii) {
    const geo = new SphereGeometry(r, 40, 20, phi[0], phi[1] - phi[0], theta[0], theta[1] - theta[0]);
    const s = mesh(geo, m);
    s.position.copy(centre);
    decor(root, s);
    for (let i = 0; i < 26; i++) {
      const a = phi[0] + R() * (phi[1] - phi[0]);
      const b = theta[0] + R() * (theta[1] - theta[0]);
      const rr = r + 0.06;
      studs.push(new Vector3(-rr * Math.cos(a) * Math.sin(b), rr * Math.cos(b), rr * Math.sin(a) * Math.sin(b)).add(centre));
    }
  }
  return studs;
}

/** Smooth ER: a tangle of tubules (decorative). */
function smoothER(root, centre, spread, colour, seed) {
  const R = rng(seed);
  const m = M(colour, { o: 0.75, r: 0.4, cc: 0.3 });
  for (let k = 0; k < 5; k++) {
    const pts = [];
    let v = centre.clone();
    for (let i = 0; i < 6; i++) {
      pts.push(v.clone());
      v = v.clone().add(new Vector3((R() - 0.5) * spread, (R() - 0.5) * spread, (R() - 0.5) * spread));
    }
    decor(root, mesh(new TubeGeometry(new CatmullRomCurve3(pts), 40, 0.05, 8, false), m));
  }
}

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
const far = (c, r) => (v) => v.distanceTo(c) >= r;

function animalCell() {
  const root = new Group();
  root.name = 'AnimalCell';
  const AX = [2.85, 2.3, 2.4];
  const memCol = T.colour('Membrane', '#7fd6c2');
  const mem = named('Membrane', root);
  const sh = mesh(blob(1, 0.025, 2, 72, 54), M(memCol, { o: 0.22, r: 0.18, cc: 1, ds: true }));
  sh.scale.set(...AX);
  mem.add(sh);
  const cy = named('Cytoplasm', root);
  const cg = mesh(blob(1, 0.02, 5, 48, 36), M(T.colour('Cytoplasm', '#c4f1e6'), { o: 0.08, r: 0.4, ds: true }));
  cg.scale.set(AX[0] * 0.95, AX[1] * 0.95, AX[2] * 0.95);
  cy.add(cg);

  const NUC = new Vector3(0, 0.2, 0);
  nucleus(root, NUC, 1);
  mito(root, 'Mito_1', new Vector3(1.4, -0.3, 0.6), [0.3, 0.2, -0.75], 0.85);
  mito(root, 'Mito_2', new Vector3(-1.55, -1.0, 0.35), [0.9, 0, 0.5], 0.85);
  mito(root, 'Mito_3', new Vector3(0.55, -1.45, -0.85), [1.1, 0.3, 1.4], 0.8);
  mito(root, 'Mito_4', new Vector3(1.6, 0.95, -0.65), [0.3, 0.5, 1.3], 0.8);
  golgi(root, new Vector3(-0.9, -0.5, -1.0), 0.35, 0.85);

  // Rough ER wraps the upper-left-front of the nucleus; ribosomes stud it, more float free.
  const er = roughER(root, NUC, [1.22, 1.38], [0.3, 1.9], [0.45, 1.75], '#b48cf2', 21);
  const ok = insideEllipsoid(AX, 0.8);
  const free = scatter(46, AX, (v) => ok(v) && far(NUC, 1.6)(v) && far(new Vector3(-0.9, -0.5, -1), 0.8)(v), 7);
  ribosomes(root, 'Ribo_1', er);
  ribosomes(root, 'Ribo_2', free);
  smoothER(root, new Vector3(1.05, 0.25, -1.1), 0.7, '#c6a8f5', 33);

  // Lysosomes and a centriole pair (decorative).
  const lm = M('#9b6fd6', { o: 0.9, cc: 0.6 });
  const lg = new SphereGeometry(0.16, 18, 12);
  for (const p of [[-0.4, 1.65, -0.5], [1.15, 1.45, 0.55], [-2.05, 0.45, -0.8], [0.95, -1.85, 0.2], [-1.0, -0.4, 1.75]]) {
    const l = mesh(lg, lm);
    l.position.set(...p);
    decor(root, l);
  }
  const cen = new Group();
  cen.position.set(0.95, 1.2, 0.25);
  const tm = M('#d9c27a', { r: 0.5 });
  const tube = new CylinderGeometry(0.022, 0.022, 0.32, 6);
  for (const [rot, off] of [[[0, 0, 0], 0], [[Math.PI / 2, 0, 0], 0.22]]) {
    const c = new Group();
    c.rotation.set(...rot);
    c.position.x = off;
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const t = mesh(tube, tm);
      t.position.set(Math.cos(a) * 0.085, 0, Math.sin(a) * 0.085);
      c.add(t);
    }
    cen.add(c);
  }
  decor(root, cen);
  return root;
}

function plantCell() {
  const root = new Group();
  root.name = 'PlantCell';
  const wallCol = T.colour('CellWall', '#9dbf5a');
  const wall = named('CellWall', root);
  wall.add(mesh(squircle(3.35, 2.25, 2.25, 0.5), M(wallCol, { o: 0.3, r: 0.6, ds: true })));
  wall.add(mesh(squircle(3.47, 2.37, 2.37, 0.5), M(tint(wallCol, 18), { o: 0.12, r: 0.55, ds: true })));
  const mem = named('Membrane', root);
  mem.add(mesh(squircle(3.12, 2.05, 2.05, 0.5), M(T.colour('Membrane', '#7fd6c2'), { o: 0.16, r: 0.2, cc: 1, ds: true })));
  const cy = named('Cytoplasm', root);
  cy.add(mesh(squircle(2.98, 1.92, 1.92, 0.5), M(T.colour('Cytoplasm', '#c4f1e6'), { o: 0.08, r: 0.4, ds: true })));

  // Plasmodesmata: thin channels through the wall (decorative).
  const pm = M(tint(wallCol, -20), { r: 0.6 });
  for (const [x, z] of [[-1.6, 0.6], [-0.4, -0.7], [0.9, 0.5], [2.0, -0.4]]) {
    const t = mesh(new CylinderGeometry(0.035, 0.035, 0.3, 8), pm);
    t.position.set(x, 2.2, z);
    decor(root, t);
  }

  const vac = named('Vacuole', root);
  const vc = mesh(new SphereGeometry(1, 56, 40), M(T.colour('Vacuole', '#8ccbf5'), { o: 0.5, r: 0.08, cc: 1, ds: true }));
  vc.scale.set(1.45, 1.0, 0.95);
  vc.position.set(0.2, -0.1, -0.1);
  vac.add(vc);

  nucleus(root, new Vector3(-1.3, 0.6, 0.4), 0.62);
  const ch = [
    [[1.5, 0.8, 0.6], [0, 0.3, 0.2]],
    [[-0.3, 1.5, 0.75], [0, 0.3, 0.1]],
    [[0.7, -1.5, 0.85], [0, -0.2, -0.1]],
    [[2.3, -0.75, 0.55], [0.4, 0, 0.6]],
    [[-2.45, -1.0, 0.45], [0, 0.5, -0.4]],
    [[-1.9, 1.2, -0.95], [0.2, 0, 0.2]],
    [[1.0, 1.45, -0.95], [0, -0.4, 0.2]],
  ];
  ch.forEach(([p, r], i) => chloro(root, `Chloro_${i + 1}`, new Vector3(...p), r, 0.95));
  mito(root, 'Mito_1', new Vector3(1.2, -1.0, 0.5), [0, 0, 1.2], 0.6);
  mito(root, 'Mito_2', new Vector3(-0.9, -1.3, -0.9), [0.8, 0, 0.4], 0.6);
  mito(root, 'Mito_3', new Vector3(2.45, 0.6, -0.7), [0.4, 0.6, 0.2], 0.55);
  // A small Golgi and ER near the nucleus (no concept in this topic: decorative).
  smoothER(root, new Vector3(-2.1, -0.1, -0.2), 0.6, '#c6a8f5', 41);
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
const report = { sizeBefore: before, sizeAfter: glb.byteLength, trianglesAfter: tris, textures: 0, nodes: nodeTree(doc).filter((l) => !/^\s*(_Mesh)?( \[\d+\])?$/.test(l)) };
if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`${outPath}: ${glb.byteLength} bytes, ${tris} triangles`);
