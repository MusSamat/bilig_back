#!/usr/bin/env node
/**
 * earth-layers.glb: concentric layers built here (our own geometry, CC0) with
 * NASA imagery (public domain, NASA Earth Observatory / Reto Stöckli, NASA
 * GSFC) on the crust:
 *   colour: https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200412.3x5400x2700.jpg
 *   relief: https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73934/gebco_08_rev_elev_21600x10800.png
 *           (Blue Marble topography, greyscale elevation; turned into a normal map here)
 *
 *   node earth-layers.mjs <blue-marble.jpg> <topography.png> <out.glb> [report.json]
 *
 * No free 3D model of the Earth's interior with separate layers exists in the
 * NASA, NIH or Smithsonian libraries, so the layers are generated:
 *   radii to scale (6371 km → R = 2.4 units): outer core 3480 km, inner core
 *   1220 km; the crust (5–70 km) is exaggerated to 0.1 units (~265 km) so it is
 *   visible, and the mantle surface sits just below it.
 * Each layer carries a flat cap where the client's «section» plane (world
 * z = 0, z ≤ 0 kept) cuts it, so the cut-away reads as a textbook cross-section:
 * rocky crust, a red-orange mantle with convection cells, a liquid orange-yellow
 * outer core with flow streaks and a glowing inner core (one procedural texture,
 * generated here). In «whole» view the caps are hidden inside the globe.
 * A thin atmosphere halo (three inward-facing translucent shells, not
 * pickable) rims the globe.
 * Two lithospheric plates (Eurasian, Indian) are schematic translucent patches
 * over Central / South Asia with solid outlines and an arrow for the Indian
 * plate's northward motion; their boundary runs along the Himalaya. Two
 * historic Tien Shan earthquakes are epicentre markers with a ring
 * (Kemin 1911, Suusamyr 1992).
 * The globe is turned so that longitude 75° E (Kyrgyzstan) faces +Z (camera).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import {
  KHRMaterialsClearcoat,
  KHRMaterialsEmissiveStrength,
} from '@gltf-transform/extensions';
import {
  centreOf,
  checkBudget,
  createIO,
  docTriangles,
  nodeTree,
  optimise,
} from './lib.mjs';
import { Document } from '@gltf-transform/core';

const [texPath, topoPath, outPath, reportPath] = process.argv.slice(2);
if (!texPath || !topoPath || !outPath) {
  console.error(
    'usage: node earth-layers.mjs <blue-marble.jpg> <topography.png> <out.glb> [report.json]',
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
/** Section caps sit just behind the client's clipping plane (world z = 0). */
const CAP_Z = -0.003;
/** Crust textures (colour, relief, roughness): 2048 × 1024. */
const TEX_W = 2048;
const TEX_H = 1024;
/** Relief exaggeration of the normal map (grey levels per pixel → slope). */
const RELIEF = 0.045;

const rad = (d) => (d * Math.PI) / 180;
/** lon/lat (degrees) → unit vector; +Y north, lon LON0 → +Z, east → +X. */
const dir = (lon, lat) => [
  Math.cos(rad(lat)) * Math.sin(rad(lon - LON0)),
  Math.sin(rad(lat)),
  Math.cos(rad(lat)) * Math.cos(rad(lon - LON0)),
];
const hex = (h) =>
  [1, 3, 5].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255) ** 2.2);
const hex8 = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

const doc = new Document();
const buf = doc.createBuffer();
const clearcoat = doc.createExtension(KHRMaterialsClearcoat);
const emissiveStrength = doc.createExtension(KHRMaterialsEmissiveStrength);
const acc = (type, arr) =>
  doc.createAccessor().setType(type).setArray(arr).setBuffer(buf);
const mat = (
  name,
  color,
  { rough = 0.8, alpha, ds = true, emissive, glow = 1, cc } = {},
) => {
  const m = doc
    .createMaterial(name)
    .setBaseColorFactor([...hex(color), alpha ?? 1])
    .setRoughnessFactor(rough)
    .setMetallicFactor(0)
    .setDoubleSided(ds);
  if (alpha !== undefined) m.setAlphaMode('BLEND');
  if (emissive) m.setEmissiveFactor(hex(emissive));
  if (glow !== 1)
    m.setExtension(
      'KHR_materials_emissive_strength',
      emissiveStrength.createEmissiveStrength().setEmissiveStrength(glow),
    );
  if (cc)
    m.setExtension(
      'KHR_materials_clearcoat',
      clearcoat
        .createClearcoat()
        .setClearcoatFactor(cc)
        .setClearcoatRoughnessFactor(0.15),
    );
  return m;
};
function prim(positions, normals, uvs, indices, material) {
  const p = doc
    .createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array(positions)))
    .setAttribute('NORMAL', acc('VEC3', new Float32Array(normals)));
  if (uvs) p.setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array(uvs)));
  return p.setIndices(acc('SCALAR', new Uint32Array(indices))).setMaterial(material);
}
function mesh(name, ...prims) {
  const m = doc.createMesh(name);
  prims.forEach((p) => m.addPrimitive(p));
  return m;
}

/** Lon/lat sphere; with `uv` it maps an equirectangular image (glTF v = 0 at the top = north). `inward` flips it (seen from outside only at the rim). */
function sphere(r, segU, segV, material, { uv = false, centre = [0, 0, 0], inward = false } = {}) {
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
      N.push(...d.map((x) => (inward ? -x : x)));
      T.push(i / segU, j / segV);
    }
  }
  for (let j = 0; j < segV; j++)
    for (let i = 0; i < segU; i++) {
      const a = j * (segU + 1) + i;
      const b = a + segU + 1;
      const tris = [];
      if (j > 0) tris.push([a, b, a + 1]);
      if (j < segV - 1) tris.push([a + 1, b, b + 1]);
      for (const [x, y, z] of tris) I.push(...(inward ? [x, z, y] : [x, y, z]));
    }
  return prim(P, N, uv ? T : null, I, material);
}

/** Flat ring (r0 = 0: disc) in the plane z = CAP_Z facing +z, UVs = the cross-section texture (disc of radius R). */
function cap(r0, r1, seg, material) {
  const P = [];
  const N = [];
  const T = [];
  const I = [];
  const rings = r0 > 0 ? [r0, r1] : [r1];
  if (r0 === 0) {
    P.push(0, 0, CAP_Z);
    N.push(0, 0, 1);
    T.push(0.5, 0.5);
  }
  for (const r of rings)
    for (let i = 0; i <= seg; i++) {
      const a = (2 * Math.PI * i) / seg;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      P.push(x, y, CAP_Z);
      N.push(0, 0, 1);
      T.push(0.5 + x / (2 * R), 0.5 - y / (2 * R));
    }
  for (let i = 0; i < seg; i++) {
    if (r0 === 0) I.push(0, 1 + i, 2 + i);
    else {
      const a = i;
      const b = seg + 1 + i;
      I.push(a, b + 1, a + 1, a, b, b + 1);
    }
  }
  return prim(P, N, T, I, material);
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
function patch(poly, r, step, material) {
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
  return prim(P, N, null, I, material);
}

const norm = (v) => {
  const l = Math.hypot(...v) || 1;
  return v.map((x) => x / l);
};
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
/** Ribbon along a closed lon/lat outline, `width` scene units wide, at radius r. */
function outline(poly, r, width, material) {
  const pts = [];
  for (let i = 0; i < poly.length; i++) {
    const [a0, a1] = poly[i];
    const [b0, b1] = poly[(i + 1) % poly.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b0 - a0, b1 - a1) / 0.5));
    for (let k = 0; k < n; k++)
      pts.push(dir(a0 + ((b0 - a0) * k) / n, a1 + ((b1 - a1) * k) / n));
  }
  const P = [];
  const N = [];
  const I = [];
  const m = pts.length;
  for (let i = 0; i < m; i++) {
    const prev = pts[(i - 1 + m) % m];
    const next = pts[(i + 1) % m];
    const t = norm(next.map((x, k) => x - prev[k]));
    const side = norm(cross(pts[i], t));
    for (const sgn of [-1, 1]) {
      P.push(...pts[i].map((x, k) => x * r + side[k] * sgn * (width / 2)));
      N.push(...pts[i]);
    }
  }
  for (let i = 0; i < m; i++) {
    const a = 2 * i;
    const b = 2 * ((i + 1) % m);
    I.push(a, b, a + 1, a + 1, b, b + 1);
  }
  return prim(P, N, null, I, material);
}
/** Flat arrow on the sphere from (lon, lat) `len` degrees towards `bearing` (0 = north). */
function arrow([lon, lat], len, r, material) {
  const up = dir(lon, lat);
  const north = norm([
    -Math.sin(rad(lat)) * Math.sin(rad(lon - LON0)),
    Math.cos(rad(lat)),
    -Math.sin(rad(lat)) * Math.cos(rad(lon - LON0)),
  ]);
  const east = norm(cross(north, up));
  const L = rad(len) * R;
  // outline in (east, north) units, tail at 0
  const shape = [
    [-0.045, 0],
    [0.045, 0],
    [0.045, L * 0.62],
    [0.12, L * 0.62],
    [0, L],
    [-0.12, L * 0.62],
    [-0.045, L * 0.62],
  ];
  const P = [];
  const N = [];
  for (const [e, n] of shape) {
    const p = up.map((x, k) => x * r + east[k] * e + north[k] * n);
    const l = Math.hypot(...p);
    P.push(...p.map((x) => (x / l) * r));
    N.push(...up);
  }
  const I = [0, 1, 2, 0, 2, 6, 3, 4, 5];
  return prim(P, N, null, I, material);
}
/** Flat ring around a surface point (tangent plane), radius r0..r1. */
function surfaceRing([lon, lat], rr, r0, r1, seg, material) {
  const up = dir(lon, lat);
  const east = norm(cross([0, 1, 0], up));
  const north = cross(up, east);
  const P = [];
  const N = [];
  const I = [];
  for (const r of [r0, r1])
    for (let i = 0; i <= seg; i++) {
      const a = (2 * Math.PI * i) / seg;
      P.push(
        ...up.map(
          (x, k) => x * rr + (east[k] * Math.cos(a) + north[k] * Math.sin(a)) * r,
        ),
      );
      N.push(...up);
    }
  for (let i = 0; i < seg; i++) {
    const a = i;
    const b = seg + 1 + i;
    I.push(a, b + 1, a + 1, a, b, b + 1);
  }
  return prim(P, N, null, I, material);
}

// --- crust textures: Blue Marble colour, relief normal map and an ocean-gloss roughness map ----
const texIn = readFileSync(texPath);
const topoIn = readFileSync(topoPath);
const colourPng = await sharp(texIn)
  .resize(TEX_W, TEX_H, { kernel: 'lanczos3' })
  .png()
  .toBuffer();
const { data: rgb } = await sharp(texIn)
  .resize(TEX_W, TEX_H, { kernel: 'lanczos3' })
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const { data: height } = await sharp(topoIn, { limitInputPixels: false })
  .greyscale()
  .resize(TEX_W, TEX_H, { kernel: 'lanczos3' })
  .blur(0.8)
  .raw()
  .toBuffer({ resolveWithObject: true });

const normalRaw = Buffer.alloc(TEX_W * TEX_H * 3);
const roughRaw = Buffer.alloc(TEX_W * TEX_H * 3);
const H = (x, y) =>
  height[((y + TEX_H) % TEX_H) * TEX_W + ((x + TEX_W) % TEX_W)];
for (let y = 0; y < TEX_H; y++) {
  const lat = 90 - ((y + 0.5) / TEX_H) * 180;
  const cosLat = Math.max(0.15, Math.cos(rad(lat)));
  for (let x = 0; x < TEX_W; x++) {
    // +X = east (u grows), +Y = north (towards v = 0), glTF tangent-space convention
    const dEast = ((H(x + 1, y) - H(x - 1, y)) / 2) / cosLat;
    const dNorth = (H(x, Math.max(0, y - 1)) - H(x, Math.min(TEX_H - 1, y + 1))) / 2;
    const n = norm([-RELIEF * dEast, -RELIEF * dNorth, 1]);
    const o = (y * TEX_W + x) * 3;
    normalRaw[o] = Math.round((n[0] * 0.5 + 0.5) * 255);
    normalRaw[o + 1] = Math.round((n[1] * 0.5 + 0.5) * 255);
    normalRaw[o + 2] = Math.round((n[2] * 0.5 + 0.5) * 255);
    // Open water (blue-dominant, no elevation) is glossy; land and ice are matte.
    const [r, g, b] = [rgb[o], rgb[o + 1], rgb[o + 2]];
    const water = H(x, y) < 2 && b > r * 1.25 && b > g * 1.02 ? 1 : 0;
    roughRaw[o] = 255;
    roughRaw[o + 1] = Math.round((water ? 0.42 : 0.92) * 255);
    roughRaw[o + 2] = 0;
  }
}
const toPng = (raw, w, h) =>
  sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
const roughPng = await sharp(roughRaw, {
  raw: { width: TEX_W, height: TEX_H, channels: 3 },
})
  .resize(TEX_W / 2, TEX_H / 2)
  .blur(1)
  .png()
  .toBuffer();
const texture = (name, png) =>
  doc
    .createTexture(name)
    .setImage(new Uint8Array(png))
    .setMimeType('image/png')
    .setURI(`${name}.png`);
const earthTex = texture('BlueMarble', colourPng);
const reliefTex = texture('Relief', await toPng(normalRaw, TEX_W, TEX_H));
const roughTex = texture('OceanGloss', roughPng);

// --- cross-section texture (caps): disc of radius R, centre = (0.5, 0.5) -----------------
const SEC = 1024;
const secRaw = Buffer.alloc(SEC * SEC * 3);
const lerp = (a, b, t) => a + (b - a) * t;
const ramp = (stops, t) => {
  t = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++)
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (t - t0) / (t1 - t0 || 1);
      return c0.map((c, k) => lerp(c, c1[k], f));
    }
  return stops[stops.length - 1][1];
};
const hash = (x, y) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const vnoise = (x, y) => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  return lerp(
    lerp(hash(xi, yi), hash(xi + 1, yi), u),
    lerp(hash(xi, yi + 1), hash(xi + 1, yi + 1), u),
    v,
  );
};
const fbm = (x, y) =>
  vnoise(x, y) * 0.55 + vnoise(x * 2.1, y * 2.1) * 0.3 + vnoise(x * 4.3, y * 4.3) * 0.15;
const CRUST_RAMP = [
  [0, hex8('#5a4636')],
  [0.6, hex8('#7d6249')],
  [1, hex8('#9c8466')],
];
const MANTLE_RAMP = [
  [0, hex8('#5c140c')],
  [0.3, hex8('#8e2412')],
  [0.62, hex8('#c8461a')],
  [0.85, hex8('#e8702a')],
  [1, hex8('#f79a3a')],
];
const OUTER_RAMP = [
  [0, hex8('#f08a1c')],
  [0.5, hex8('#f8b030')],
  [1, hex8('#ffd65a')],
];
const INNER_RAMP = [
  [0, hex8('#fff9e0')],
  [0.7, hex8('#ffefb0')],
  [1, hex8('#ffd873')],
];
const CELLS = 7; // convection cells around the mantle
for (let py = 0; py < SEC; py++)
  for (let px = 0; px < SEC; px++) {
    const x = ((px + 0.5) / SEC - 0.5) * 2 * R;
    const y = (0.5 - (py + 0.5) / SEC) * 2 * R;
    const r = Math.hypot(x, y);
    const th = Math.atan2(y, x);
    const n = fbm(x * 6 + 11, y * 6 + 5);
    let c;
    if (r > R_MANTLE) {
      c = ramp(CRUST_RAMP, (r - R_MANTLE) / (R - R_MANTLE) + (n - 0.5) * 0.6);
    } else if (r > R_OUTER) {
      // t: 0 at the top of the mantle (cooler), 1 at the core (hot); cells = rolls of a stream function
      const t = (R_MANTLE - r) / (R_MANTLE - R_OUTER);
      const psi = Math.sin(CELLS * th + 0.35 * Math.sin(Math.PI * t)) * Math.sin(Math.PI * t);
      const up = Math.cos(CELLS * th) * Math.sin(Math.PI * t); // + rising hot, − sinking cool
      const streak = 0.5 + 0.5 * Math.cos(2 * Math.PI * psi * 2.4);
      const T = 0.18 + 0.66 * t + 0.2 * up + 0.045 * (streak - 0.5) + (n - 0.5) * 0.12;
      c = ramp(MANTLE_RAMP, T);
    } else if (r > R_INNER) {
      const t = (r - R_INNER) / (R_OUTER - R_INNER);
      const swirl = Math.sin(10 * th + 22 * t + 3 * fbm(x * 3, y * 3));
      c = ramp(OUTER_RAMP, 1 - t * 0.85 + 0.12 * swirl + (n - 0.5) * 0.1);
    } else {
      c = ramp(INNER_RAMP, r / R_INNER + (n - 0.5) * 0.15);
    }
    // thin dark seams at the layer boundaries
    let seam = 1;
    for (const b of [R_MANTLE, R_OUTER, R_INNER])
      seam = Math.min(seam, 0.55 + 0.45 * Math.min(1, Math.abs(r - b) / 0.012));
    const o = (py * SEC + px) * 3;
    for (let k = 0; k < 3; k++)
      secRaw[o + k] = Math.max(0, Math.min(255, Math.round(c[k] * seam)));
  }
const secTex = texture('CrossSection', await toPng(secRaw, SEC, SEC));

// --- materials -------------------------------------------------------------------------------
const crustMat = mat('crust', '#ffffff', { rough: 1 })
  .setBaseColorTexture(earthTex)
  .setNormalTexture(reliefTex)
  .setMetallicRoughnessTexture(roughTex);
const capMat = (name, glow, emissive) => {
  const m = mat(name, '#ffffff', { rough: 0.85, ds: false, emissive, glow })
    .setBaseColorTexture(secTex);
  if (emissive) m.setEmissiveTexture(secTex);
  return m;
};
const crustCut = capMat('crustCut');
const mantleCut = capMat('mantleCut', 1, '#4d4d4d');
const outerCut = capMat('outerCoreCut', 1, '#a6a6a6');
const innerCut = capMat('innerCoreCut', 1.6, '#ffffff');
const mantleMat = mat('mantle', '#b23a18', { rough: 0.8, emissive: '#3a0c04' });
const outerMat = mat('outerCore', '#f39a2a', {
  rough: 0.25,
  emissive: '#7a3d08',
  cc: 0.8,
});
const innerMat = mat('innerCore', '#fff0b8', {
  rough: 0.4,
  emissive: '#ffd36b',
  glow: 1.4,
});
const plateEu = mat('plateEurasian', '#5fd27a', { rough: 0.7, alpha: 0.26 });
const plateIn = mat('plateIndian', '#ffcc40', { rough: 0.7, alpha: 0.2 });
const lineEu = mat('plateEurasianEdge', '#3fcf62', {
  rough: 0.5,
  ds: false,
  emissive: '#1d6b2e',
});
const lineIn = mat('plateIndianEdge', '#ffbe2e', {
  rough: 0.5,
  ds: false,
  emissive: '#7a5410',
});
const quakeMat = mat('quake', '#ff3426', {
  rough: 0.35,
  ds: false,
  emissive: '#ff2a1a',
  glow: 0.8,
});
const quakeRing = mat('quakeRing', '#ff6a3a', {
  rough: 0.5,
  alpha: 0.75,
  emissive: '#c8301c',
});
const atmo = [
  [1.012, 0.28],
  [1.028, 0.14],
  [1.05, 0.06],
].map(([k, a], i) => [
  k,
  mat(`atmosphere${i + 1}`, '#79b8ff', {
    rough: 1,
    alpha: a,
    ds: false,
    emissive: '#4f95ff',
  }),
]);

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
const indian = shift(INDIAN, -0.6);

const earth = doc.createNode('Earth');
const add = (name, m) => {
  const n = doc.createNode(name).setMesh(m);
  earth.addChild(n);
  return n;
};
add(
  'Crust',
  mesh(
    'Crust',
    sphere(R_CRUST, 192, 96, crustMat, { uv: true }),
    cap(R_MANTLE, R_CRUST, 256, crustCut),
  ),
);
add(
  'Mantle',
  mesh(
    'Mantle',
    sphere(R_MANTLE, 128, 64, mantleMat),
    cap(R_OUTER, R_MANTLE, 256, mantleCut),
  ),
);
add(
  'OuterCore',
  mesh(
    'OuterCore',
    sphere(R_OUTER, 96, 48, outerMat),
    cap(R_INNER, R_OUTER, 192, outerCut),
  ),
);
add(
  'InnerCore',
  mesh('InnerCore', sphere(R_INNER, 64, 32, innerMat), cap(0, R_INNER, 128, innerCut)),
);
add(
  'Plate_Eurasian',
  mesh(
    'Plate_Eurasian',
    patch(EURASIAN, R + 0.012, 1, plateEu),
    outline(EURASIAN, R + 0.016, 0.022, lineEu),
  ),
);
add(
  'Plate_Indian',
  mesh(
    'Plate_Indian',
    patch(indian, R + 0.012, 1, plateIn),
    outline(indian, R + 0.016, 0.022, lineIn),
    arrow([79, 8], 13, R + 0.02, lineIn),
  ),
);
// Epicentres (approximate): Kemin 1911 (M ≈ 8.0), Suusamyr 1992 (M 7.3)
const QUAKES = {
  Quake_Kemin1911: [76.9, 42.9],
  Quake_Suusamyr1992: [73.6, 42.1],
};
for (const [name, [lon, lat]] of Object.entries(QUAKES)) {
  const c = dir(lon, lat).map((x) => x * (R + 0.03));
  add(
    name,
    mesh(
      name,
      sphere(0.036, 20, 12, quakeMat, { centre: c }),
      surfaceRing([lon, lat], R + 0.02, 0.052, 0.064, 48, quakeRing),
    ),
  );
}
// Atmosphere halo: decorative, never picked (userData.noPick via extras).
const halo = doc
  .createNode('AtmosphereHalo')
  .setExtras({ noPick: true })
  .setMesh(
    mesh(
      'AtmosphereHalo',
      ...atmo.map(([k, m]) => sphere(R * k, 72, 36, m, { inward: true })),
    ),
  );
earth.addChild(halo);
doc.createScene('Scene').addChild(earth);

await optimise(doc, { ratio: 1, maxTexture: TEX_W, webpQuality: 80 });
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
  sizeBefore: texIn.byteLength + topoIn.byteLength,
  sizeAfter: glb.byteLength,
  trianglesAfter: tris,
  textures: doc
    .getRoot()
    .listTextures()
    .map((t) => `${t.getName()} ${t.getSize()?.join('×')} ${t.getMimeType()}`),
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
