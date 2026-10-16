/**
 * Shared helpers for models authored with three.js geometry (our own work,
 * CC0): turn a three.js object graph into a glTF-Transform Document (node
 * names, TRS, PBR materials incl. KHR_materials_clearcoat, instanced meshes
 * expanded to nodes sharing one mesh), and read concept colours from the
 * content sources so a structure has the same colour in the GLB, in its chip
 * and in its label (scene-core `conceptColor(hue, 62, 62)`).
 *
 * three.js is used only as a geometry kernel here; nothing is rendered.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document } from '@gltf-transform/core';
import { KHRMaterialsClearcoat } from '@gltf-transform/extensions';
import { Color, DoubleSide, InstancedMesh, Matrix4, Mesh, Quaternion, Vector3 } from 'three';

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
  return {
    topic,
    /** Concept colour of a node name (hsl(h, 62%, 62%)), or the fallback. */
    colour(node, fallback) {
      const hit = masks.find((m) => m.re.test(node));
      const h = hit ? hue.get(hit.key) : undefined;
      return h === undefined ? fallback : `hsl(${h}, 62%, 62%)`;
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

/**
 * three.js graph → glTF document. Material properties read: color, opacity,
 * transparent, side (DoubleSide), roughness, metalness, emissive(+Intensity),
 * clearcoat, clearcoatRoughness. BackSide is not representable in glTF and is
 * rejected, so authoring scripts never use it.
 */
export function toDocument(root) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const clearcoatExt = doc.createExtension(KHRMaterialsClearcoat);
  let usedClearcoat = false;
  const scene = doc.createScene(root.name || 'Scene');
  const materials = new Map();
  const meshes = new Map();

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
    materials.set(m, g);
    return g;
  };

  const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const mesh = (geometry, m, name) => {
    const key = `${geometry.uuid}|${m.uuid}`;
    if (meshes.has(key)) return meshes.get(key);
    const geo = geometry.index ? geometry : geometry; // indexed or not, both fine
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', accessor('VEC3', new Float32Array(geo.attributes.position.array)))
      .setAttribute('NORMAL', accessor('VEC3', new Float32Array(geo.attributes.normal.array)))
      .setMaterial(material(m));
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
  return doc;
}
