/**
 * Shared helpers for the offline asset pipeline (TZ A-05): one glTF IO with
 * meshopt + WebP support, the optimisation pass every topic GLB goes through,
 * and a small report (size, triangles, node tree) for ASSET.json.
 *
 * Downloaded source files are untrusted data: these scripts only parse them
 * as glTF / images and never execute anything from them.
 */
import { NodeIO, getBounds } from '@gltf-transform/core';
import {
  ALL_EXTENSIONS,
  EXTMeshoptCompression,
  EXTTextureWebP,
} from '@gltf-transform/extensions';
import {
  dedup,
  meshopt,
  prune,
  simplify,
  textureCompress,
  weld,
} from '@gltf-transform/functions';
import {
  MeshoptDecoder,
  MeshoptEncoder,
  MeshoptSimplifier,
} from 'meshoptimizer';
import sharp from 'sharp';

export async function createIO() {
  await Promise.all([
    MeshoptDecoder.ready,
    MeshoptEncoder.ready,
    MeshoptSimplifier.ready,
  ]);
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    });
}

/** Triangles of one mesh (indexed or not). */
export function meshTriangles(mesh) {
  let t = 0;
  for (const p of mesh.listPrimitives()) {
    const idx = p.getIndices();
    t += (idx ? idx.getCount() : p.getAttribute('POSITION').getCount()) / 3;
  }
  return t;
}

export function docTriangles(doc) {
  let t = 0;
  for (const n of doc.getRoot().listNodes())
    if (n.getMesh()) t += meshTriangles(n.getMesh());
  return t;
}

/** Node tree as `name [tris]` lines, for the ASSET.json report. */
export function nodeTree(doc) {
  const out = [];
  const walk = (n, d) => {
    const m = n.getMesh();
    out.push(
      `${'  '.repeat(d)}${n.getName()}${m ? ` [${meshTriangles(m)}]` : ''}`,
    );
    n.listChildren().forEach((c) => walk(c, d + 1));
  };
  for (const s of doc.getRoot().listScenes())
    s.listChildren().forEach((n) => walk(n, 0));
  return out;
}

/** World-space centre of a node's bounds, rounded for topic anchors. */
export function centreOf(node, digits = 2) {
  const { min, max } = getBounds(node);
  return min.map((v, i) => Number(((v + max[i]) / 2).toFixed(digits)));
}

/**
 * dedup → prune → weld → simplify (meshoptimizer) → textures ≤ maxTexture px
 * (WebP; KTX2 needs the external `toktx` binary, not available here) →
 * meshopt compression (EXT_meshopt_compression + quantisation).
 */
export async function optimise(
  doc,
  { ratio = 0.5, error = 0.001, maxTexture = 1024, webpQuality = 82 } = {},
) {
  await doc.transform(dedup(), prune(), weld());
  if (ratio < 1)
    await doc.transform(
      simplify({
        simplifier: MeshoptSimplifier,
        ratio,
        error,
        lockBorder: false,
      }),
    );
  if (doc.getRoot().listTextures().length) {
    doc.createExtension(EXTTextureWebP).setRequired(true);
    await doc.transform(
      textureCompress({
        encoder: sharp,
        targetFormat: 'webp',
        resize: [maxTexture, maxTexture],
        quality: webpQuality,
      }),
    );
  }
  await doc.transform(
    prune(),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  doc.createExtension(EXTMeshoptCompression).setRequired(true);
  // Quantisation moves the mesh of a node that has children into a new unnamed
  // child (so the dequantisation transform does not reach the children). Name
  // it after its parent: concept binding walks up to the nearest matching name.
  for (const n of doc.getRoot().listNodes()) {
    if (n.getName() || !n.getMesh()) continue;
    const parent = n.getParentNode();
    if (parent?.getName()) n.setName(`${parent.getName()}_Mesh`);
  }
  return doc;
}

/** Fail loudly when a GLB is over its budget (TZ §10: package ≤ 5 MB; GLB ≤ 3 MB, ≤ 150k triangles). */
export function checkBudget(
  name,
  bytes,
  tris,
  { maxBytes = 3 * 1024 * 1024, maxTris = 150_000 } = {},
) {
  const problems = [];
  if (bytes > maxBytes) problems.push(`${name}: ${bytes} bytes > ${maxBytes}`);
  if (tris > maxTris) problems.push(`${name}: ${tris} triangles > ${maxTris}`);
  if (problems.length)
    throw new Error(`budget exceeded\n${problems.join('\n')}`);
}
