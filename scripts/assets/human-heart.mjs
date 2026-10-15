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
 * What it does: keeps the heart + the great vessels at its base, renames the
 * nodes to the topic's concept masks (RightAtrium, Valve_*, Aorta_*), adds a
 * schematic pericardium shell (PCA-fitted ellipsoid, it is not in the source),
 * gives each tissue its own material, centres and scales the model to ~3.4
 * scene units, then simplifies + meshopt-compresses it (lib.optimise).
 */
import { writeFileSync } from 'node:fs';
import { getBounds } from '@gltf-transform/core';
import {
  clearNodeTransform,
  mergeDocuments,
  prune,
  unpartition,
} from '@gltf-transform/functions';
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
  VH_M_coronary_sinus: ['CoronarySinus', 'vein'],
};
const MATERIALS = {
  atrium: { color: '#c65a60', roughness: 0.6 },
  ventricle: { color: '#a8323c', roughness: 0.6 },
  septum: { color: '#93303a', roughness: 0.65 },
  papillary: { color: '#9a2f38', roughness: 0.65 },
  valve: { color: '#ead9a6', roughness: 0.5 },
  aorta: { color: '#d8403f', roughness: 0.45 },
  pulmArtery: { color: '#4a6fc4', roughness: 0.45 },
  pulmVein: { color: '#d96a6a', roughness: 0.45 },
  vein: { color: '#3b55a8', roughness: 0.45 },
  coronary: { color: '#e5534b', roughness: 0.45 },
  pericardium: { color: '#f3c9c4', roughness: 0.3, alpha: 0.3 },
};
/** Heart size in scene units (the topic camera frames ~±2.5). */
const TARGET_SIZE = 3.4;

const hex = (h) =>
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

const mats = Object.fromEntries(
  Object.entries(MATERIALS).map(([k, m]) => {
    const mat = doc
      .createMaterial(k)
      .setBaseColorFactor([...hex(m.color), m.alpha ?? 1])
      .setRoughnessFactor(m.roughness)
      .setMetallicFactor(0);
    if (m.alpha) mat.setAlphaMode('BLEND').setDoubleSided(true);
    return [k, mat];
  }),
);

const scene = root.listScenes()[0];
const heart = doc.createNode('Heart');
const missing = [];
/** Re-parent a source node under `parent` with its world transform baked into its matrix. */
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
    .forEach((p) => p.setMaterial(mats[matKey]));
  parent.addChild(n);
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
const chamberPts = [];
for (const name of [
  'RightAtrium',
  'LeftAtrium',
  'RightVentricle',
  'LeftVentricle',
  'InterventricularSeptum',
]) {
  const n = created.get(name);
  const m = n.getMatrix();
  const pos = n.getMesh().listPrimitives()[0].getAttribute('POSITION');
  const v = [0, 0, 0];
  for (let i = 0; i < pos.getCount(); i += 3) {
    pos.getElement(i, v);
    chamberPts.push([
      m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
      m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
      m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
    ]);
  }
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
    ellipsoid(doc, 'Pericardium', mean, axes, semi, 48, 32, mats.pericardium),
  );
heart.addChild(peri);

// --- centre + scale -----------------------------------------------------------------------
const b = getBounds(scene);
const chamberBox = boundsOfPoints(chamberPts);
const centre = chamberBox.min.map((v, i) => (v + chamberBox.max[i]) / 2);
const size = Math.max(...chamberBox.max.map((v, i) => v - chamberBox.min[i]));
const s = TARGET_SIZE / size;
heart.setScale([s, s, s]).setTranslation(centre.map((c) => -c * s));

await optimise(doc, { ratio: 0.35, error: 0.0008 });
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
  anchors,
  nodes: nodeTree(doc),
};
if (reportPath)
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, nodes: report.nodes.length }, null, 2));

// --- helpers -----------------------------------------------------------------------------
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
