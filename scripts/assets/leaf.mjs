#!/usr/bin/env node
/**
 * leaf.glb: a schoolbook block diagram of a leaf cross-section (dicot),
 * authored here with three.js geometry (our own work, CC0).
 *
 *   node leaf.mjs <out.glb> [report.json]
 *
 * No free (CC0 / CC BY / public domain) leaf cross-section model was found:
 * the ones that exist are paid marketplace models, login-gated templates or
 * physical teaching models.
 *
 * Layers, top to bottom (y up, the block spans x ±2.4, z ±1.3):
 *   Cuticle (wax, top and bottom) · Epidermis_Upper · Palisade_1…n (columnar
 *   cells, chloroplasts along their walls) · Spongy_1…n (loose cells with air
 *   spaces) · Epidermis_Lower with stomata (GuardCell_*a/b around Stoma_* =
 *   pore + substomatal air chamber) · Cuticle.
 * Every mesophyll cell has its chloroplasts in Chloro_<cell> and their grana
 * (thylakoid stacks, where chlorophyll sits) in Thylakoid_<cell>. The vein
 * (xylem, phloem, bundle sheath) has no concept in the topic: decorative.
 * Node names follow the topic's masks; the stoma, chloroplast and mesophyll
 * anchors of the topic sit on real parts.
 */
import { writeFileSync } from 'node:fs';
import { CapsuleGeometry, Color, CylinderGeometry, DoubleSide, Group, InstancedMesh, Mesh, MeshPhysicalMaterial, Object3D, SphereGeometry, TorusGeometry, Vector3 } from 'three';
import { checkBudget, createIO, docTriangles, nodeTree, optimise } from './lib.mjs';
import { rng, tint, toDocument, topicColours } from './three-gltf.mjs';

const [outPath, reportPath] = process.argv.slice(2);
if (!outPath) {
  console.error('usage: node leaf.mjs <out.glb> [report.json]');
  process.exit(2);
}
const T = topicColours('photosynthesis', 'bio');

function M(color, { o = 1, r = 0.45, cc = 0, ds = false } = {}) {
  return new MeshPhysicalMaterial({ color: new Color(color), roughness: r, metalness: 0, transparent: o < 1, opacity: o, clearcoat: cc, clearcoatRoughness: 0.3, side: ds ? DoubleSide : 0 });
}
const mesh = (g, m) => new Mesh(g, m);
function named(name, parent) {
  const g = new Group();
  g.name = name;
  parent.add(g);
  return g;
}
function decor(parent, o) {
  o.name = '';
  parent.add(o);
  return o;
}
/** Rounded box (superellipsoid). */
function squircle(sx, sy, sz, n = 0.35, w = 18, h = 12) {
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
function blob(r, amp, seed, w = 18, h = 12) {
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

const X = 2.4;
const Z = 1.3;
const Y_CUT_TOP = 1.04;
const Y_EPI_TOP = 0.9;
const Y_EPI_BOT = -0.9;
const STOMATA = [new Vector3(0.8, -0.9, 0.4), new Vector3(-0.85, -0.9, -0.55), new Vector3(1.95, -0.9, -0.75), new Vector3(-1.95, -0.9, 0.75)];
const VEIN = { x: -1.55, y: -0.38, r: 0.36 };

const root = new Group();
root.name = 'LeafSection';

const epiCol = T.colour('Epidermis_Upper', '#c7d96b');
const mesCol = T.colour('Palisade_1', '#6fbf5a');
const chlCol = T.colour('Chloro_1', '#3e9e48');
const thyCol = T.colour('Thylakoid_1', '#2f8a46');
const stoCol = T.colour('Stoma_1', '#4fc4a8');

/* ---------- cuticle (top and bottom), one concept node ---------- */
const cut = named('Cuticle', root);
const cutM = M(tint(epiCol, 18), { o: 0.45, r: 0.15, cc: 1, ds: true });
for (const y of [Y_CUT_TOP, -Y_CUT_TOP]) {
  const s = mesh(squircle(X + 0.04, 0.035, Z + 0.04, 0.2, 32, 8), cutM);
  s.position.y = y;
  cut.add(s);
}

/* ---------- epidermis: flat tabular cells, gaps for stomata below ---------- */
function epidermis(name, y, skip) {
  const g = named(name, root);
  const m = M(epiCol, { o: 0.6, r: 0.4, cc: 0.4, ds: true });
  const nx = 10;
  const nz = 5;
  const w = (2 * X) / nx;
  const d = (2 * Z) / nz;
  const geo = squircle(w / 2 - 0.012, 0.1, d / 2 - 0.012, 0.35, 12, 8);
  for (let i = 0; i < nx; i++)
    for (let k = 0; k < nz; k++) {
      const p = new Vector3(-X + w * (i + 0.5), y, -Z + d * (k + 0.5));
      if (skip(p)) continue;
      const c = mesh(geo, m);
      c.position.copy(p);
      g.add(c);
    }
  return g;
}
epidermis('Epidermis_Upper', Y_EPI_TOP, () => false);
const nearStoma = (p) => STOMATA.some((s) => Math.hypot(p.x - s.x, p.z - s.z) < 0.26);
epidermis('Epidermis_Lower', Y_EPI_BOT, nearStoma);

/* ---------- chloroplasts + grana for one cell ---------- */
const chlGeo = new SphereGeometry(1, 9, 6);
const chlM = M(chlCol, { o: 0.78, r: 0.35, cc: 0.6 });
const granumGeo = new CylinderGeometry(1, 1, 1, 7, 1);
const thyM = M(thyCol, { r: 0.4 });
function chloroplasts(id, centres, size) {
  const env = named(`Chloro_${id}`, root);
  const thy = named(`Thylakoid_${id}`, root);
  const ie = new InstancedMesh(chlGeo, chlM, centres.length);
  const it = new InstancedMesh(granumGeo, thyM, centres.length * 2);
  const d = new Object3D();
  centres.forEach(({ p, q }, i) => {
    d.position.copy(p);
    d.quaternion.copy(q);
    d.scale.set(size * 1.6, size * 0.75, size);
    d.updateMatrix();
    ie.setMatrixAt(i, d.matrix);
    for (let k = 0; k < 2; k++) {
      const off = new Vector3((k - 0.5) * size * 1.1, 0, 0).applyQuaternion(q);
      d.position.copy(p).add(off);
      d.quaternion.copy(q);
      d.scale.set(size * 0.42, size * 0.9, size * 0.42);
      d.updateMatrix();
      it.setMatrixAt(i * 2 + k, d.matrix);
    }
  });
  env.add(ie);
  thy.add(it);
}

/* ---------- palisade mesophyll: columns, chloroplasts along the walls ---------- */
const R = rng(5);
const palM = M(mesCol, { o: 0.42, r: 0.35, cc: 0.4, ds: true });
const palGeo = new CapsuleGeometry(0.17, 0.5, 4, 12);
const PAL_Y = 0.4;
let n = 0;
const nx = 11;
const nz = 5;
for (let i = 0; i < nx; i++)
  for (let k = 0; k < nz; k++) {
    const id = ++n;
    const p = new Vector3(-X + 0.2 + ((2 * X - 0.4) * i) / (nx - 1) + (R() - 0.5) * 0.04, PAL_Y + (R() - 0.5) * 0.04, -Z + 0.22 + ((2 * Z - 0.44) * k) / (nz - 1) + (R() - 0.5) * 0.04);
    const cell = named(`Palisade_${id}`, root);
    const body = mesh(palGeo, palM);
    body.position.copy(p);
    cell.add(body);
    const cs = [];
    for (let j = 0; j < 7; j++) {
      const a = (j / 7) * Math.PI * 2 + R();
      const y = p.y - 0.33 + (j % 4) * 0.22 + (R() - 0.5) * 0.08;
      const pos = new Vector3(p.x + Math.cos(a) * 0.105, y, p.z + Math.sin(a) * 0.105);
      // Lying flat against the wall: long axis vertical-ish, facing outwards.
      const q = new Object3D();
      q.lookAt(new Vector3(Math.cos(a), 0, Math.sin(a)));
      q.rotateZ(Math.PI / 2 + (R() - 0.5) * 0.4);
      cs.push({ p: pos, q: q.quaternion.clone() });
    }
    chloroplasts(`P${id}`, cs, 0.058);
  }

/* ---------- spongy mesophyll: loose irregular cells, air spaces, room for vein and stomata ---------- */
const spoM = M(tint(mesCol, 8, -8), { o: 0.45, r: 0.4, cc: 0.3, ds: true });
const R2 = rng(17);
let s = 0;
const spongyOk = (p) =>
  Math.hypot(p.x - VEIN.x, p.y - VEIN.y) > VEIN.r + 0.2 &&
  !STOMATA.some((st) => Math.hypot(p.x - st.x, p.z - st.z) < 0.3 && p.y < -0.45);
for (let i = 0; i < 9; i++)
  for (let k = 0; k < 5; k++)
    for (const layer of [0, 1]) {
      const p = new Vector3(-X + 0.27 + i * 0.54 + (R2() - 0.5) * 0.18 + layer * 0.27, -0.62 + layer * 0.38 + (R2() - 0.5) * 0.1, -Z + 0.26 + k * 0.52 + (R2() - 0.5) * 0.16);
      if (Math.abs(p.x) > X - 0.18 || !spongyOk(p)) continue;
      const id = ++s;
      const cell = named(`Spongy_${id}`, root);
      const r = 0.16 + R2() * 0.05;
      const b = mesh(blob(r, 0.22, id, 14, 10), spoM);
      b.position.copy(p);
      b.scale.set(1.15, 0.85, 1);
      cell.add(b);
      const cs = [];
      for (let j = 0; j < 3; j++) {
        const dir = new Vector3(R2() - 0.5, R2() - 0.5, R2() - 0.5).normalize();
        const q = new Object3D();
        q.lookAt(dir);
        cs.push({ p: p.clone().add(dir.multiplyScalar(r * 0.72)), q: q.quaternion.clone() });
      }
      chloroplasts(`S${id}`, cs, 0.05);
    }

/* ---------- stomata: two guard cells around a pore, substomatal air chamber above ---------- */
const guardM = M(tint(stoCol, -4), { o: 0.9, r: 0.35, cc: 0.6 });
const poreM = M(tint(stoCol, -35, -20), { r: 0.8 });
const chamberM = M(tint(stoCol, 25, -25), { o: 0.22, r: 0.2, ds: true });
STOMATA.forEach((c, i) => {
  const id = i + 1;
  const st = named(`Stoma_${id}`, root);
  const pore = mesh(new SphereGeometry(1, 20, 10), poreM);
  pore.position.copy(c);
  pore.scale.set(0.035, 0.07, 0.12);
  st.add(pore);
  const ch = mesh(new SphereGeometry(1, 20, 14), chamberM);
  ch.position.set(c.x, c.y + 0.3, c.z);
  ch.scale.set(0.24, 0.18, 0.24);
  st.add(ch);
  for (const side of [-1, 1]) {
    // Two kidney-shaped halves of one lens around the slit (long axis along z).
    const g = named(`GuardCell_${id}${side < 0 ? 'a' : 'b'}`, root);
    g.position.set(c.x + side * 0.012, c.y, c.z);
    g.scale.set(1, 1, 1.4);
    const t = mesh(new TorusGeometry(0.12, 0.055, 10, 18, Math.PI), guardM);
    t.rotation.set(Math.PI / 2, (side * Math.PI) / 2, 0, 'YXZ');
    g.add(t);
  }
});

/* ---------- vein (vascular bundle) along z: decorative ---------- */
const vein = new Group();
vein.name = '';
const sheath = mesh(new CylinderGeometry(VEIN.r, VEIN.r, 2 * Z, 24, 1, true), M('#d9c98b', { o: 0.35, r: 0.5, ds: true }));
sheath.rotation.x = Math.PI / 2;
vein.add(sheath);
const xyM = M('#5d7fc8', { r: 0.4, cc: 0.3 });
const phM = M('#d38b4a', { r: 0.5 });
const tube = (r, x, y, m) => {
  const t = mesh(new CylinderGeometry(r, r, 2 * Z - 0.02, 12, 1), m);
  t.rotation.x = Math.PI / 2;
  t.position.set(x, y, 0);
  vein.add(t);
};
for (const [x, y, r] of [[-0.12, 0.12, 0.06], [0.04, 0.16, 0.07], [0.17, 0.08, 0.05], [-0.04, 0.0, 0.05], [0.12, -0.04, 0.045]]) tube(r, x, y, xyM);
for (const [x, y] of [[-0.14, -0.17], [0.0, -0.2], [0.14, -0.18], [-0.07, -0.08]]) tube(0.04, x, y, phM);
vein.position.set(VEIN.x, VEIN.y, 0);
decor(root, vein);

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
