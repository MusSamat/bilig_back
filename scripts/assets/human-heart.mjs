#!/usr/bin/env node
/**
 * human-heart.glb from the Human Reference Atlas (HRA) 3D reference organs,
 * both CC BY 4.0, by Kristen Browne and Heidi Schlehlein (NIH HuBMAP), made
 * from the Visible Human Male (NLM):
 *   heart:       https://cdn.humanatlas.io/digital-objects/ref-organ/heart-male/v1.3/assets/3d-vh-m-heart.glb
 *   vasculature: https://cdn.humanatlas.io/digital-objects/ref-organ/blood-vasculature-male/v1.3/assets/3d-vh-m-blood-vasculature.glb
 * Both files share one body coordinate frame (metres), so the great vessels
 * line up with the heart without any fitting.
 *
 *   node human-heart.mjs <heart.glb> <vasculature.glb> <out.glb> [report.json]
 *
 * What it does: keeps the heart + the great vessels and the coronary
 * vessels on its surface, renames the nodes to the topic's concept masks
 * (RightAtrium, Valve_*, Aorta_*), adds a schematic pericardium shell
 * (PCA-fitted ellipsoid, it is not in the source), gives each tissue an
 * atlas-style wet-tissue material (myocardium red-brown with clearcoat,
 * arteries red, veins blue-purple, groove fat painted as vertex colour along
 * the coronary vessels), simplifies each part to its own triangle budget,
 * caps the closed walls where the client's «section» plane cuts them (world
 * z = 0, so the cut myocardium reads as a solid wall, not a hollow shell),
 * centres and scales the model to ~3.4 scene units and meshopt-compresses it.
 */
import { writeFileSync } from 'node:fs';
import { getBounds } from '@gltf-transform/core';
import { KHRMaterialsClearcoat } from '@gltf-transform/extensions';
import {
  clearNodeTransform,
  mergeDocuments,
  prune,
  simplifyPrimitive,
  unpartition,
  weld,
} from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { ShapeUtils, Vector2 } from 'three';
import {
  centreOf,
  checkBudget,
  createIO,
  docTriangles,
  nodeTree,
  optimise,
} from './lib.mjs';

const [heartPath, vascPath, outPath, reportPath] = process.argv.slice(2);
if (!heartPath || !vascPath || !outPath) {
  console.error(
    'usage: node human-heart.mjs <heart.glb> <vasculature.glb> <out.glb> [report.json]',
  );
  process.exit(2);
}

/** source node → [new name, material key]. Order = draw/tree order. */
const HEART = {
  VH_M_right_cardiac_atrium: ['RightAtrium', 'atrium'],
  VH_M_left_cardiac_atrium: ['LeftAtrium', 'atrium'],
  VH_M_heart_right_ventricle: ['RightVentricle', 'ventricle'],
  VH_M_heart_left_ventricle: ['LeftVentricle', 'ventricle'],
  VH_M_interventricular_septum: ['InterventricularSeptum', 'septum'],
  VH_M_tricuspid_valve: ['Valve_Tricuspid', 'valve'],
  VH_M_mitral_valve: ['Valve_Mitral', 'valve'],
  VH_M_aortic_valve: ['Valve_Aortic', 'valve'],
  VH_M_pulmonary_valve: ['Valve_Pulmonary', 'valve'],
};
/** Papillary muscles belong to a ventricle: they become its children (concept = nearest named ancestor). */
const PAPILLARY = {
  VH_M_papillary_muscle_of_heart_anterolateral: [
    'LeftVentricle',
    'Papillary_Anterolateral',
  ],
  VH_M_papillary_muscle_of_heart_posteromedial: [
    'LeftVentricle',
    'Papillary_Posteromedial',
  ],
  VH_M_papillary_muscle_of_heart_anterior: [
    'RightVentricle',
    'Papillary_Anterior',
  ],
  VH_M_papillary_muscle_of_heart_posterior: [
    'RightVentricle',
    'Papillary_Posterior',
  ],
  VH_M_papillary_muscle_of_heart_medial: ['RightVentricle', 'Papillary_Septal'],
};
const VESSELS = {
  VH_M_ascending_aorta: ['Aorta_Ascending', 'aorta'],
  VH_M_aortic_arch: ['Aorta_Arch', 'aorta'],
  VH_M_descending_aorta_a: ['Aorta_Descending', 'aorta'],
  VH_M_brachiocephalic_artery_a: ['Aorta_Branch_Brachiocephalic', 'aorta'],
  VH_M_left_common_carotid_artery_a: ['Aorta_Branch_LeftCarotid', 'aorta'],
  VH_M_left_subclavian_artery_a: ['Aorta_Branch_LeftSubclavian', 'aorta'],
  VH_M_pulmonary_trunk: ['PulmonaryTrunk', 'pulmArtery'],
  VH_M_pulmonary_artery_L: ['PulmonaryArtery_Left', 'pulmArtery'],
  VH_M_pulmonary_artery_R: ['PulmonaryArtery_Right', 'pulmArtery'],
  VH_M_pulmonary_vein_L_sup: ['PulmonaryVein_LeftSuperior', 'pulmVein'],
  VH_M_pulmonary_vein_L_inf: ['PulmonaryVein_LeftInferior', 'pulmVein'],
  VH_M_pulmonary_vein_R_sup: ['PulmonaryVein_RightSuperior', 'pulmVein'],
  VH_M_pulmonary_vein_R_inf: ['PulmonaryVein_RightInferior', 'pulmVein'],
  VH_M_superior_vena_cava: ['VenaCava_Superior', 'vein'],
  VH_M_inferior_vena_cava_a: ['VenaCava_Inferior', 'vein'],
  VH_M_left_coronary_artery: ['Coronary_Left', 'coronary'],
  VH_M_right_coronary_artery: ['Coronary_Right', 'coronary'],
  VH_M_diagonal_branch_of_anterior_descending_branch_of_left_coronary_artery: [
    'Coronary_Diagonal',
    'coronary',
  ],
  VH_M_left_marginal_branch: ['Coronary_LeftMarginal', 'coronary'],
  VH_M_right_marginal_artery: ['Coronary_RightMarginal', 'coronary'],
  VH_M_coronary_sinus: ['CoronarySinus', 'cardiacVein'],
  VH_M_great_cardiac_vein: ['CardiacVein_Great', 'cardiacVein'],
  VH_M_middle_cardiac_vein: ['CardiacVein_Middle', 'cardiacVein'],
  VH_M_small_cardiac_vein: ['CardiacVein_Small', 'cardiacVein'],
  VH_M_anterior_cardiac_vein: ['CardiacVein_Anterior', 'cardiacVein'],
};
/**
 * Atlas palette (linear-ish sRGB hex; the client tone-maps with Neutral).
 * Myocardium is a deep red-brown and carries vertex colours (groove fat), so
 * its factor stays white and the colour lives in MYO below.
 * `cc` = clearcoat (wet serous surface), `cut` = colour of the section cap.
 */
const MATERIALS = {
  atrium: { color: '#ffffff', roughness: 0.55, cc: 0.6, vc: true },
  ventricle: { color: '#ffffff', roughness: 0.55, cc: 0.6, vc: true },
  septum: { color: '#7c2622', roughness: 0.6, cc: 0.3 },
  papillary: { color: '#8a2c27', roughness: 0.6, cc: 0.3 },
  valve: { color: '#e9dcc0', roughness: 0.45, cc: 0.5 },
  aorta: { color: '#c42a22', roughness: 0.42, cc: 0.7 },
  pulmArtery: { color: '#3d58b8', roughness: 0.42, cc: 0.7 },
  pulmVein: { color: '#c23a33', roughness: 0.42, cc: 0.7 },
  vein: { color: '#4a3f9e', roughness: 0.42, cc: 0.7 },
  coronary: { color: '#d8332a', roughness: 0.38, cc: 0.8 },
  cardiacVein: { color: '#43409c', roughness: 0.38, cc: 0.8 },
  pericardium: { color: '#c99a8e', roughness: 0.25, alpha: 0.3, cc: 0.6 },
  // Section caps: cut tissue, a little lighter than the surface.
  cutMuscle: { color: '#b4554a', roughness: 0.8 },
  cutArtery: { color: '#d4554a', roughness: 0.7 },
  cutVein: { color: '#5d57ad', roughness: 0.7 },
  cutValve: { color: '#efe4cc', roughness: 0.7 },
};
/** Myocardium surface colours (vertex colours, sRGB). */
const MYO = {
  atrium: '#7c2e29',
  ventricle: '#6c221e',
  fat: '#d4ad5c',
};
/** Section cap material per source material. */
const CUT_OF = {
  atrium: 'cutMuscle',
  ventricle: 'cutMuscle',
  septum: 'cutMuscle',
  papillary: 'cutMuscle',
  valve: 'cutValve',
  aorta: 'cutArtery',
  pulmArtery: 'cutVein',
  pulmVein: 'cutArtery',
  vein: 'cutVein',
  coronary: 'cutArtery',
  cardiacVein: 'cutVein',
};
/** Share of source triangles kept, per material group (budget ≤ 150k in total). */
const KEEP = {
  atrium: 0.5,
  ventricle: 0.7,
  septum: 0.7,
  papillary: 1,
  valve: 0.3,
  aorta: 0.6,
  pulmArtery: 0.45,
  pulmVein: 0.5,
  vein: 0.3,
  coronary: 0.5,
  cardiacVein: 1,
};
/** Heart size in scene units (the topic camera frames ~±2.5). */
const TARGET_SIZE = 3.4;
/** The client's «section» plane is world z = 0 (z ≤ 0 kept); caps sit just behind it. */
const CAP_Z = -0.004;

const srgb = (h) =>
  [1, 3, 5].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255) ** 2.2);

const io = await createIO();
const heartDoc = await io.read(heartPath);
const vascDoc = await io.read(vascPath);
const sizeIn =
  (await io.writeBinary(heartDoc)).byteLength +
  (await io.writeBinary(vascDoc)).byteLength;
const trisIn = docTriangles(heartDoc) + docTriangles(vascDoc);

// Keep only the wanted vessels in the vasculature document before merging.
const wanted = new Set([
  ...Object.keys(HEART),
  ...Object.keys(PAPILLARY),
  ...Object.keys(VESSELS),
]);
for (const n of vascDoc.getRoot().listNodes())
  if (n.getMesh() && !wanted.has(n.getName())) n.setMesh(null);
await vascDoc.transform(prune());

const doc = heartDoc;
mergeDocuments(doc, vascDoc);
await doc.transform(unpartition());
const root = doc.getRoot();
const byName = new Map(
  root
    .listNodes()
    .filter((n) => n.getMesh())
    .map((n) => [n.getName(), n]),
);

const clearcoat = doc.createExtension(KHRMaterialsClearcoat);
const mats = Object.fromEntries(
  Object.entries(MATERIALS).map(([k, m]) => {
    const mat = doc
      .createMaterial(k)
      .setBaseColorFactor([...srgb(m.color), m.alpha ?? 1])
      .setRoughnessFactor(m.roughness)
      .setMetallicFactor(0);
    if (m.alpha) mat.setAlphaMode('BLEND').setDoubleSided(true);
    if (m.cc)
      mat.setExtension(
        'KHR_materials_clearcoat',
        clearcoat
          .createClearcoat()
          .setClearcoatFactor(m.cc)
          .setClearcoatRoughnessFactor(0.22),
      );
    return [k, mat];
  }),
);

const scene = root.listScenes()[0];
const heart = doc.createNode('Heart');
const missing = [];
/** node → material key, for budgets, caps and colours. */
const groupOf = new Map();
/** Re-parent a source node under `parent` with its world transform baked into its vertices. */
function adopt(srcName, name, matKey, parent) {
  const n = byName.get(srcName);
  if (!n) return missing.push(srcName);
  const world = n.getWorldMatrix();
  for (const p of n.listParents())
    if (p.propertyType === 'Node' || p.propertyType === 'Scene')
      p.removeChild(n);
  n.listChildren().forEach((c) => n.removeChild(c));
  // Detached → local = world; bake it into the vertices so every adopted node is identity.
  n.setMatrix(world).setName(name);
  clearNodeTransform(n);
  n.getMesh()
    .setName(name)
    .listPrimitives()
    .forEach((p) => {
      // Source vertex colours / UVs would tint our palette: drop them.
      for (const sem of p.listSemantics())
        if (sem !== 'POSITION' && sem !== 'NORMAL') p.setAttribute(sem, null);
      p.setMaterial(mats[matKey]);
    });
  parent.addChild(n);
  groupOf.set(n, matKey);
  return n;
}
const created = new Map();
for (const [src, [name, mat]] of [
  ...Object.entries(HEART),
  ...Object.entries(VESSELS),
]) {
  const n = adopt(src, name, mat, heart);
  if (n) created.set(name, n);
}
for (const [src, [ventricle, name]] of Object.entries(PAPILLARY)) {
  // The ventricle node is identity (baked), so the papillary muscle keeps its place.
  adopt(src, `${ventricle}_${name}`, 'papillary', created.get(ventricle));
}
if (missing.length)
  throw new Error(`source nodes not found: ${missing.join(', ')}`);

// Drop the source scene roots (now empty groups), keep only our tree.
scene.listChildren().forEach((c) => scene.removeChild(c));
scene.addChild(heart);
const keep = new Set();
heart.traverse((n) => keep.add(n));
for (const n of root.listNodes()) if (!keep.has(n)) n.dispose();

// --- schematic pericardium: PCA-fitted ellipsoid around the four chambers -----------------
const CHAMBERS = [
  'RightAtrium',
  'LeftAtrium',
  'RightVentricle',
  'LeftVentricle',
  'InterventricularSeptum',
];
const chamberPts = [];
for (const name of CHAMBERS) {
  const pos = created
    .get(name)
    .getMesh()
    .listPrimitives()[0]
    .getAttribute('POSITION');
  const v = [0, 0, 0];
  for (let i = 0; i < pos.getCount(); i += 3)
    chamberPts.push([...pos.getElement(i, v)]);
}
const mean = [0, 1, 2].map(
  (k) => chamberPts.reduce((s, p) => s + p[k], 0) / chamberPts.length,
);
const cov = [0, 1, 2].map((a) =>
  [0, 1, 2].map(
    (b) =>
      chamberPts.reduce((s, p) => s + (p[a] - mean[a]) * (p[b] - mean[b]), 0) /
      chamberPts.length,
  ),
);
const axes = jacobiEigenvectors(cov);
const proj = chamberPts.map((p) =>
  axes.map((ax) => ax.reduce((s, c, k) => s + c * (p[k] - mean[k]), 0)),
);
const ext = [0, 1, 2].map((k) => Math.max(...proj.map((q) => Math.abs(q[k]))));
const k = Math.max(
  ...proj.map((q) => Math.hypot(q[0] / ext[0], q[1] / ext[1], q[2] / ext[2])),
);
const semi = ext.map((e) => e * k * 0.93); // the apex may poke through slightly: a tighter sac reads better than a loose bubble
const peri = doc
  .createNode('Pericardium')
  .setMesh(
    ellipsoid(doc, 'Pericardium', mean, axes, semi, 64, 40, mats.pericardium),
  );
heart.addChild(peri);

// --- centre + scale -----------------------------------------------------------------------
const b = getBounds(scene);
const chamberBox = boundsOfPoints(chamberPts);
const centre = chamberBox.min.map((v, i) => (v + chamberBox.max[i]) / 2);
const size = Math.max(...chamberBox.max.map((v, i) => v - chamberBox.min[i]));
const s = TARGET_SIZE / size;
heart.setScale([s, s, s]).setTranslation(centre.map((c) => -c * s));

// --- clean + per-part simplification ------------------------------------------------------
await doc.transform(weld());
for (const [node, group] of groupOf) {
  for (const prim of node.getMesh().listPrimitives()) {
    dropDuplicateTriangles(prim);
    const ratio = KEEP[group];
    if (ratio < 1)
      simplifyPrimitive(prim, {
        simplifier: MeshoptSimplifier,
        ratio,
        error: 0.0015,
        lockBorder: false,
      });
  }
}

// --- groove fat + muscle mottling as vertex colours on the chamber walls -------------------
const vesselPts = [];
for (const [node, group] of groupOf)
  if (group === 'coronary' || group === 'cardiacVein') {
    const pos = node.getMesh().listPrimitives()[0].getAttribute('POSITION');
    const v = [0, 0, 0];
    for (let i = 0; i < pos.getCount(); i++)
      vesselPts.push([...pos.getElement(i, v)]);
  }
const vesselGrid = pointGrid(vesselPts, 0.008);
for (const [node, group] of groupOf) {
  if (group !== 'atrium' && group !== 'ventricle') continue;
  for (const prim of node.getMesh().listPrimitives())
    paintMyocardium(prim, MYO[group]);
}

// --- section caps at world z = 0 ------------------------------------------------------------
const capZ = (CAP_Z - heart.getTranslation()[2]) / s; // source frame (metres)
const capReport = {};
for (const [node, group] of groupOf) {
  if (group === 'valve') continue; // thin leaflets: a cap would fill the orifice
  const prim = node.getMesh().listPrimitives()[0];
  const cap = sectionCap(prim, capZ);
  if (!cap) continue;
  const p = doc
    .createPrimitive()
    .setAttribute(
      'POSITION',
      accessor('VEC3', new Float32Array(cap.positions)),
    )
    .setAttribute(
      'NORMAL',
      accessor(
        'VEC3',
        new Float32Array(cap.positions.length).map((_, i) =>
          i % 3 === 2 ? 1 : 0,
        ),
      ),
    )
    .setIndices(
      accessor('SCALAR', new Uint32Array(cap.indices)),
    )
    .setMaterial(mats[CUT_OF[group]]);
  node.getMesh().addPrimitive(p);
  capReport[node.getName()] = cap.indices.length / 3;
}

await optimise(doc, { ratio: 1 });
const glb = await io.writeBinary(doc);
const tris = docTriangles(doc);
checkBudget('human-heart.glb', glb.byteLength, tris);
writeFileSync(outPath, glb);

const anchors = Object.fromEntries(
  [
    'RightAtrium',
    'LeftAtrium',
    'RightVentricle',
    'LeftVentricle',
    'Valve_Mitral',
    'Aorta_Arch',
    'Aorta_Ascending',
    'Pericardium',
  ].map((n) => [n, centreOf(root.listNodes().find((x) => x.getName() === n))]),
);
const report = {
  sizeBefore: sizeIn,
  sizeAfter: glb.byteLength,
  trianglesBefore: trisIn,
  trianglesAfter: tris,
  sourceBounds: b,
  scale: s,
  capTriangles: capReport,
  anchors,
  nodes: nodeTree(doc),
};
if (reportPath)
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, nodes: report.nodes.length }, null, 2));

// --- helpers -----------------------------------------------------------------------------

function accessor(type, array) {
  return doc
    .createAccessor()
    .setType(type)
    .setArray(array)
    .setBuffer(root.listBuffers()[0]);
}

/** Remove repeated triangles (same three vertices in any order); the source coronary mesh has many. */
function dropDuplicateTriangles(prim) {
  const idx = prim.getIndices();
  if (!idx) return;
  const a = idx.getArray();
  const seen = new Set();
  const out = [];
  for (let t = 0; t < a.length; t += 3) {
    const tri = [a[t], a[t + 1], a[t + 2]];
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue;
    const key = [...tri].sort((x, y) => x - y).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(...tri);
  }
  if (out.length !== a.length) idx.setArray(new Uint32Array(out));
}

/** Uniform hash grid over points, for nearest-point queries within `cell`. */
function pointGrid(pts, cell) {
  const g = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  for (const p of pts) {
    const kk = key(...p.map((c) => Math.floor(c / cell)));
    if (!g.has(kk)) g.set(kk, []);
    g.get(kk).push(p);
  }
  return {
    /** Nearest point within one cell ring, or null. */
    nearest(p) {
      const c = p.map((x) => Math.floor(x / cell));
      let best = null;
      let bd = Infinity;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const list = g.get(key(c[0] + dx, c[1] + dy, c[2] + dz));
            if (!list) continue;
            for (const q of list) {
              const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
              if (d < bd) ((bd = d), (best = q));
            }
          }
      return best ? { point: best, dist: Math.sqrt(bd) } : null;
    },
  };
}

/**
 * COLOR_0 for a chamber wall: the myocardium colour, a soft low-frequency
 * mottling, and subepicardial fat (yellow) where a coronary vessel runs over
 * the outer surface (the vessel must lie on the side the normal faces, so the
 * inner wall of the chamber stays muscle-coloured).
 */
function paintMyocardium(prim, hex) {
  const pos = prim.getAttribute('POSITION');
  const nrm = prim.getAttribute('NORMAL');
  const base = srgb(hex);
  const fat = srgb(MYO.fat);
  const out = new Float32Array(pos.getCount() * 4);
  const v = [0, 0, 0];
  const n = [0, 0, 0];
  for (let i = 0; i < pos.getCount(); i++) {
    pos.getElement(i, v);
    if (nrm) nrm.getElement(i, n);
    let w = 0;
    const hit = vesselGrid.nearest(v);
    if (hit) {
      const d = hit.point.map((c, kk) => c - v[kk]);
      const facing = nrm ? d[0] * n[0] + d[1] * n[1] + d[2] * n[2] : 1;
      if (facing > -0.0005) w = 0.85 * smoothstep(0.0055, 0.0018, hit.dist);
    }
    // ±7 % mottling, 1–2 cm wavelength (deterministic)
    const m =
      1 +
      0.045 * Math.sin(v[0] * 410 + Math.sin(v[1] * 230) * 2.1) +
      0.03 * Math.sin(v[1] * 520 + v[2] * 310);
    for (let c = 0; c < 3; c++)
      out[i * 4 + c] = (base[c] * (1 - w) + fat[c] * w) * (w > 0.5 ? 1 : m);
    out[i * 4 + 3] = 1;
  }
  prim.setAttribute('COLOR_0', accessor('VEC4', out));
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Flat cap where the plane z = z0 cuts a closed mesh: the cut edges are
 * chained into loops, nested loops alternate solid / hole (even-odd), and the
 * regions are triangulated facing +z. Open chains (holes in the source
 * surface) are dropped. Returns null when nothing closed is cut.
 */
function sectionCap(prim, z0) {
  const pos = prim.getAttribute('POSITION');
  const idx = prim.getIndices().getArray();
  const P = [];
  const v = [0, 0, 0];
  // Weld by position so edges shared across UV/normal seams match.
  const weldKey = new Map();
  const id = new Int32Array(pos.getCount());
  for (let i = 0; i < pos.getCount(); i++) {
    pos.getElement(i, v);
    const kk = v.map((x) => Math.round(x * 1e6)).join(',');
    if (!weldKey.has(kk)) {
      weldKey.set(kk, P.length);
      P.push([...v]);
    }
    id[i] = weldKey.get(kk);
  }
  // Nudge the plane off any vertex so every crossing is a proper edge crossing.
  let z = z0;
  for (let guard = 0; guard < 20; guard++) {
    if (!P.some((p) => Math.abs(p[2] - z) < 1e-9)) break;
    z += 3.7e-8;
  }
  const point = new Map(); // edge key → [x, y]
  const adj = new Map(); // edge key → neighbouring edge keys
  const link = (a, c) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(c);
  };
  for (let t = 0; t < idx.length; t += 3) {
    const tri = [id[idx[t]], id[idx[t + 1]], id[idx[t + 2]]];
    const ks = [];
    for (let e = 0; e < 3; e++) {
      const a = tri[e];
      const c = tri[(e + 1) % 3];
      const da = P[a][2] - z;
      const dc = P[c][2] - z;
      if (da < 0 === dc < 0) continue;
      const kk = a < c ? `${a}_${c}` : `${c}_${a}`;
      if (!point.has(kk)) {
        const f = da / (da - dc);
        point.set(kk, [
          P[a][0] + f * (P[c][0] - P[a][0]),
          P[a][1] + f * (P[c][1] - P[a][1]),
        ]);
      }
      ks.push(kk);
    }
    if (ks.length === 2) {
      link(ks[0], ks[1]);
      link(ks[1], ks[0]);
    }
  }
  // Chain into closed loops.
  const used = new Set();
  const loops = [];
  for (const start of adj.keys()) {
    if (used.has(start)) continue;
    const loop = [start];
    used.add(start);
    let prev = null;
    let cur = start;
    let closed = false;
    for (;;) {
      const next = (adj.get(cur) ?? []).find(
        (x) => x !== prev && (!used.has(x) || (x === start && loop.length > 2)),
      );
      if (next === undefined) break;
      if (next === start) {
        closed = true;
        break;
      }
      used.add(next);
      loop.push(next);
      prev = cur;
      cur = next;
    }
    if (closed && loop.length >= 3 && adj.get(start).length === 2)
      loops.push(loop.map((kk) => point.get(kk)));
  }
  if (!loops.length) return null;
  const area = (l) =>
    l.reduce((acc, p, i) => {
      const q = l[(i + 1) % l.length];
      return acc + p[0] * q[1] - q[0] * p[1];
    }, 0) / 2;
  const insidePoly = (poly, [x, y]) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
        c = !c;
    }
    return c;
  };
  const info = loops
    .map((l) => ({ l, a: Math.abs(area(l)) }))
    .filter((o) => o.a > 1e-9)
    .sort((p, q) => q.a - p.a);
  for (const o of info) {
    o.parents = info.filter((p) => p !== o && p.a > o.a && insidePoly(p.l, o.l[0]));
    o.depth = o.parents.length;
  }
  const positions = [];
  const indices = [];
  for (const o of info) {
    if (o.depth % 2) continue; // holes
    const holes = info.filter(
      (h) => h.depth === o.depth + 1 && h.parents.includes(o),
    );
    const contour = o.l.map(([x, y]) => new Vector2(x, y));
    const hs = holes.map((h) => h.l.map(([x, y]) => new Vector2(x, y)));
    const tris = ShapeUtils.triangulateShape(contour, hs);
    const all = [...contour, ...hs.flat()];
    const base = positions.length / 3;
    for (const p of all) positions.push(p.x, p.y, z);
    for (const [a, c, d] of tris) {
      const A = all[a];
      const B = all[c];
      const C = all[d];
      const nz = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
      if (nz >= 0) indices.push(base + a, base + c, base + d);
      else indices.push(base + a, base + d, base + c);
    }
  }
  return indices.length ? { positions, indices } : null;
}

function boundsOfPoints(pts) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of pts)
    for (let i = 0; i < 3; i++)
      ((min[i] = Math.min(min[i], p[i])), (max[i] = Math.max(max[i], p[i])));
  return { min, max };
}

/** Eigenvectors of a symmetric 3×3 matrix (cyclic Jacobi), as rows. */
function jacobiEigenvectors(A) {
  const a = A.map((r) => [...r]);
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (Math.abs(a[p][q]) < 1e-15) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t =
        Math.sign(theta || 1) /
        (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const sn = t * c;
      for (let r = 0; r < 3; r++) {
        const arp = a[r][p];
        const arq = a[r][q];
        a[r][p] = c * arp - sn * arq;
        a[r][q] = sn * arp + c * arq;
      }
      for (let r = 0; r < 3; r++) {
        const apr = a[p][r];
        const aqr = a[q][r];
        a[p][r] = c * apr - sn * aqr;
        a[q][r] = sn * apr + c * aqr;
      }
      for (let r = 0; r < 3; r++) {
        const vrp = v[r][p];
        const vrq = v[r][q];
        v[r][p] = c * vrp - sn * vrq;
        v[r][q] = sn * vrp + c * vrq;
      }
    }
  }
  return [0, 1, 2].map((col) => [v[0][col], v[1][col], v[2][col]]);
}

/** UV-sphere scaled to an oriented ellipsoid (centre, unit axes as rows, semi-axes). */
function ellipsoid(document, name, c, ax, r, segU, segV, material) {
  const pos = [];
  const nrm = [];
  const idx = [];
  for (let j = 0; j <= segV; j++) {
    const th = (j / segV) * Math.PI;
    for (let i = 0; i <= segU; i++) {
      const ph = (i / segU) * Math.PI * 2;
      const u = [
        Math.sin(th) * Math.cos(ph),
        Math.cos(th),
        Math.sin(th) * Math.sin(ph),
      ];
      const p = [0, 1, 2].map(
        (d) =>
          c[d] +
          ax[0][d] * u[0] * r[0] +
          ax[1][d] * u[1] * r[1] +
          ax[2][d] * u[2] * r[2],
      );
      const nl = [0, 1, 2].map(
        (d) =>
          ax[0][d] * (u[0] / r[0]) +
          ax[1][d] * (u[1] / r[1]) +
          ax[2][d] * (u[2] / r[2]),
      );
      const l = Math.hypot(...nl) || 1;
      pos.push(...p);
      nrm.push(...nl.map((x) => x / l));
    }
  }
  for (let j = 0; j < segV; j++)
    for (let i = 0; i < segU; i++) {
      const a = j * (segU + 1) + i;
      const b2 = a + segU + 1;
      idx.push(a, a + 1, b2, a + 1, b2 + 1, b2);
    }
  const buf = document.getRoot().listBuffers()[0] ?? document.createBuffer();
  const prim = document
    .createPrimitive()
    .setAttribute(
      'POSITION',
      document
        .createAccessor()
        .setType('VEC3')
        .setArray(new Float32Array(pos))
        .setBuffer(buf),
    )
    .setAttribute(
      'NORMAL',
      document
        .createAccessor()
        .setType('VEC3')
        .setArray(new Float32Array(nrm))
        .setBuffer(buf),
    )
    .setIndices(
      document
        .createAccessor()
        .setType('SCALAR')
        .setArray(new Uint32Array(idx))
        .setBuffer(buf),
    )
    .setMaterial(material);
  return document.createMesh(name).addPrimitive(prim);
}
