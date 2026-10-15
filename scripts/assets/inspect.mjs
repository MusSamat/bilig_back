#!/usr/bin/env node
/** node inspect.mjs <file.glb> [nameRegex] — node tree with triangles, plus world-space centres/bounds of matching nodes. */
import { getBounds } from '@gltf-transform/core';
import { createIO, docTriangles, nodeTree } from './lib.mjs';

const [file, pattern] = process.argv.slice(2);
if (!file) {
  console.error('usage: node inspect.mjs <file.glb> [nameRegex]');
  process.exit(2);
}
const doc = await (await createIO()).read(file);
console.log(nodeTree(doc).join('\n'));
console.log(`triangles: ${docTriangles(doc)}`);
if (pattern) {
  const re = new RegExp(pattern);
  for (const n of doc
    .getRoot()
    .listNodes()
    .filter((x) => re.test(x.getName()))) {
    const { min, max } = getBounds(n);
    const f = (v) => v.map((x) => x.toFixed(2)).join(', ');
    console.log(
      `${n.getName().padEnd(32)} centre [${f(min.map((v, i) => (v + max[i]) / 2))}]  min [${f(min)}]  max [${f(max)}]`,
    );
  }
}
