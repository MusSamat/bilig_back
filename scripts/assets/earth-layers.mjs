#!/usr/bin/env node
/**
 * earth-layers.glb: concentric layers built here (our own geometry, CC0) with
 * NASA's Blue Marble Next Generation (public domain, NASA Earth Observatory /
 * Reto Stöckli, NASA GSFC) as the crust texture:
 *   https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200412.3x5400x2700.jpg
 *
 *   node earth-layers.mjs <blue-marble.jpg> <out.glb> [report.json]
 *
 * No free 3D model of the Earth's interior with separate layers exists in the
 * NASA, NIH or Smithsonian libraries, so the layers are generated:
 *   radii to scale (6371 km → R = 2.4 units): outer core 3480 km, inner core
 *   1220 km; the crust (5–70 km) is exaggerated to 0.1 units (~265 km) so it is
 *   visible, and the mantle surface sits just below it.
 * Two lithospheric plates (Eurasian, Indian) are schematic raised patches over
 * Central / South Asia with their boundary along the Himalaya; two historic
 * Tien Shan earthquakes are epicentre markers (Kemin 1911, Suusamyr 1992).
 * The globe is turned so that longitude 75° E (Kyrgyzstan) faces +Z (camera).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  centreOf,
  checkBudget,
  createIO,
  docTriangles,
  nodeTree,
  optimise,
} from './lib.mjs';
import { Document } from '@gltf-transform/core';

const [texPath, outPath, reportPath] = process.argv.slice(2);
if (!texPath || !outPath) {
  console.error(
    'usage: node earth-layers.mjs <blue-marble.jpg> <out.glb> [report.json]',
  );
  process.exit(2);
}

const R = 2.4;
const KM = R / 6371;
const LON0 = 75; // faces the camera
const R_CRUST = R;
const R_MANTLE = R - 0.1;
const R_OUTER = 3480 * KM;
const R_INNER = 1220 * KM;

const rad = (d) => (d * Math.PI) / 180;
/** lon/lat (degrees) → unit vector; +Y north, lon LON0 → +Z, east → +X. */
const dir = (lon, lat) => [
  Math.cos(rad(lat)) * Math.sin(rad(lon - LON0)),
  Math.sin(rad(lat)),
  Math.cos(rad(lat)) * Math.cos(rad(lon - LON0)),
];
const hex = (h) =>
  [1, 3, 5].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255) ** 2.2);

const doc = new Document();
const buf = doc.createBuffer();
const acc = (type, arr) =>
  doc.createAccessor().setType(type).setArray(arr).setBuffer(buf);
const mat = (name, color, { rough = 0.8, alpha, ds = true } = {}) => {
  const m = doc
    .createMaterial(name)
    .setBaseColorFactor([...hex(color), alpha ?? 1])
    .setRoughnessFactor(rough)
    .setMetallicFactor(0)
    .setDoubleSided(ds);
  if (alpha !== undefined) m.setAlphaMode('BLEND');
  return m;
};
function mesh(name, positions, normals, uvs, indices, material) {
  const p = doc
    .createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array(positions)))
    .setAttribute('NORMAL', acc('VEC3', new Float32Array(normals)));
  if (uvs) p.setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array(uvs)));
  p.setIndices(acc('SCALAR', new Uint32Array(indices))).setMaterial(material);
  return doc.createMesh(name).addPrimitive(p);
}

/** Lon/lat sphere; with `uv` it maps an equirectangular image (glTF v = 0 at the top = north). */
function sphere(name, r, segU, segV, material, uv = false, centre = [0, 0, 0]) {
  const P = [];
  const N = [];
  const T = [];
  const I = [];
  for (let j = 0; j <= segV; j++) {
    const lat = 90 - (180 * j) / segV;
    for (let i = 0; i <= segU; i++) {
      const lon = -180 + (360 * i) / segU;
      const d = dir(lon, lat);
      P.push(...d.map((x, k) => centre[k] + x * r));
      N.push(...d);
      T.push(i / segU, j / segV);
    }
  }
  for (let j = 0; j < segV; j++)
    for (let i = 0; i < segU; i++) {
      const a = j * (segU + 1) + i;
      const b = a + segU + 1;
      if (j > 0) I.push(a, b, a + 1);
      if (j < segV - 1) I.push(a + 1, b, b + 1);
    }
  return mesh(name, P, N, uv ? T : null, I, material);
}

/** Inside test for a lon/lat polygon (ray casting in the lon/lat plane; fine away from the poles). */
function inside(poly, lon, lat) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      c = !c;
  }
  return c;
}
function closestOnOutline(poly, x, y) {
  let best = null;
  let bd = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j];
    const [bx, by] = poly[i];
    const t = Math.max(
      0,
      Math.min(
        1,
        ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) /
          ((bx - ax) ** 2 + (by - ay) ** 2 || 1),
      ),
    );
    const px = ax + t * (bx - ax);
    const py = ay + t * (by - ay);
    const d = (px - x) ** 2 + (py - y) ** 2;
    if (d < bd) ((bd = d), (best = [px, py]));
  }
  return best;
}
/** Thin spherical patch over a lon/lat polygon, at radius r, step degrees per cell. */
function patch(name, poly, r, step, material) {
  const lons = poly.map((p) => p[0]);
  const lats = poly.map((p) => p[1]);
  const [lo0, lo1, la0, la1] = [
    Math.min(...lons),
    Math.max(...lons),
    Math.min(...lats),
    Math.max(...lats),
  ];
  const P = [];
  const N = [];
  const I = [];
  const vid = new Map();
  // Grid vertices outside the outline snap onto it, so the patch edge follows the polygon, not the grid.
  const vert = (lon, lat) => {
    const k = `${lon},${lat}`;
    if (!vid.has(k)) {
      const [sl, sa] = inside(poly, lon, lat)
        ? [lon, lat]
        : closestOnOutline(poly, lon, lat);
      const d = dir(sl, sa);
      vid.set(k, P.length / 3);
      P.push(...d.map((x) => x * r));
      N.push(...d);
    }
    return vid.get(k);
  };
  for (let lon = lo0; lon < lo1; lon += step)
    for (let lat = la0; lat < la1; lat += step) {
      const corners = [
        [lon, lat],
        [lon + step, lat],
        [lon + step, lat + step],
        [lon, lat + step],
      ];
      if (
        !inside(poly, lon + step / 2, lat + step / 2) &&
        !corners.some(([x, y]) => inside(poly, x, y))
      )
        continue;
      const a = vert(lon, lat);
      const b = vert(lon + step, lat);
      const c = vert(lon + step, lat + step);
      const d = vert(lon, lat + step);
      I.push(a, b, c, a, c, d);
    }
  return mesh(name, P, N, null, I, material);
}

// --- texture: Blue Marble JPEG; lib.optimise resizes it to 1024×512 and encodes WebP ----------
const texIn = readFileSync(texPath);
const earthTex = doc
  .createTexture('BlueMarble')
  .setImage(new Uint8Array(texIn))
  .setMimeType('image/jpeg')
  .setURI('blue-marble.jpg');

const crustMat = mat('crust', '#ffffff', { rough: 0.9 }).setBaseColorTexture(
  earthTex,
);
const mantleMat = mat('mantle', '#c4532d', { rough: 0.85 });
const outerMat = mat('outerCore', '#f0a238', { rough: 0.6 });
const innerMat = mat('innerCore', '#ffe3a0', { rough: 0.5 });
const plateEu = mat('plateEurasian', '#5fbf73', { rough: 0.7, alpha: 0.45 });
const plateIn = mat('plateIndian', '#e3b53c', { rough: 0.7, alpha: 0.45 });
const quakeMat = mat('quake', '#e8302a', {
  rough: 0.4,
  ds: false,
}).setEmissiveFactor([0.6, 0.05, 0.03]);

// Schematic plate outlines (lon, lat), boundary along Makran – Himalaya – Burma arc.
const BOUNDARY = [
  [61, 25],
  [66, 29],
  [69, 33],
  [74, 35],
  [78, 33],
  [82, 30],
  [88, 28],
  [94, 28],
  [97, 24],
];
const INDIAN = [
  ...BOUNDARY,
  [95, 15],
  [93, 5],
  [88, -5],
  [72, -8],
  [62, 0],
  [58, 12],
  [58, 22],
];
const EURASIAN = [
  ...BOUNDARY.slice().reverse(),
  [50, 30],
  [42, 38],
  [42, 58],
  [112, 58],
  [112, 34],
  [100, 26],
];
// keep the patches ~0.6° apart along the boundary so they read as two plates
const shift = (poly, dLat) =>
  poly.map(([lo, la], i) => (i < BOUNDARY.length ? [lo, la + dLat] : [lo, la]));

const earth = doc.createNode('Earth');
const add = (name, m) => {
  const n = doc.createNode(name).setMesh(m);
  earth.addChild(n);
  return n;
};
add('Crust', sphere('Crust', R_CRUST, 128, 64, crustMat, true));
add('Mantle', sphere('Mantle', R_MANTLE, 96, 48, mantleMat));
add('OuterCore', sphere('OuterCore', R_OUTER, 64, 32, outerMat));
add('InnerCore', sphere('InnerCore', R_INNER, 48, 24, innerMat));
add('Plate_Eurasian', patch('Plate_Eurasian', EURASIAN, R + 0.012, 1, plateEu));
add(
  'Plate_Indian',
  patch('Plate_Indian', shift(INDIAN, -0.6), R + 0.012, 1, plateIn),
);
// Epicentres (approximate): Kemin 1911 (M ≈ 8.0), Suusamyr 1992 (M 7.3)
const QUAKES = {
  Quake_Kemin1911: [76.9, 42.9],
  Quake_Suusamyr1992: [73.6, 42.1],
};
for (const [name, [lon, lat]] of Object.entries(QUAKES)) {
  const c = dir(lon, lat).map((x) => x * (R + 0.03));
  add(name, sphere(name, 0.05, 16, 10, quakeMat, false, c));
}
doc.createScene('Scene').addChild(earth);

await optimise(doc, { ratio: 1 });
const io = await createIO();
const glb = await io.writeBinary(doc);
const tris = docTriangles(doc);
checkBudget('earth-layers.glb', glb.byteLength, tris);
writeFileSync(outPath, glb);
const anchors = Object.fromEntries(
  [
    'Plate_Eurasian',
    'Plate_Indian',
    'Quake_Kemin1911',
    'Quake_Suusamyr1992',
  ].map((n) => [
    n,
    centreOf(
      doc
        .getRoot()
        .listNodes()
        .find((x) => x.getName() === n),
    ),
  ]),
);
const report = {
  sizeBefore: texIn.byteLength,
  sizeAfter: glb.byteLength,
  trianglesAfter: tris,
  radii: {
    crust: R_CRUST,
    mantle: R_MANTLE,
    outerCore: Number(R_OUTER.toFixed(4)),
    innerCore: Number(R_INNER.toFixed(4)),
  },
  anchors,
  kyrgyzstanDirection: dir(74.6, 41.2).map((x) => Number((x * R).toFixed(2))),
  nodes: nodeTree(doc),
};
if (reportPath)
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
