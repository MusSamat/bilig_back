#!/usr/bin/env node
/**
 * water-cycle.glb: a diorama of the Issyk-Kul basin, made here (our own
 * geometry, CC0). No free 3D water-cycle model with separate parts was found
 * (NASA 3D Resources, Smithsonian 3D, Poly Haven, Kenney, Wikimedia Commons;
 * marketplace models are not CC0/CC BY), so the pipeline builds it:
 *
 *   node water-cycle.mjs <out.glb> [report.json]
 *
 * Snowy ranges (back and left) hold two glaciers; their meltwater rivers run
 * down to a large mountain lake. Clouds form above the lake and over the
 * ranges, rain and snow fall from them, the Sun stands over the back right
 * and the sky (the atmosphere) is the backdrop. Arrows show evaporation,
 * transpiration, the transport of vapour, and — in the section view (z > 0
 * clipped) — infiltration down to the aquifer and groundwater flow into the
 * lake. The front face of the block shows the strata with the aquifer band.
 *
 * Node names = the topic's concept masks: Atmosphere, Cloud_*, Glacier*,
 * River_*, Lake, Aquifer*. Ground, Trees, Sun, Precip_*, Arrow_* are decor.
 */
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { checkBudget, createIO, docTriangles, nodeTree, optimise } from './lib.mjs';
import {
  CAP_Z,
  Geo,
  arrow,
  bandWall,
  blob,
  clamp,
  cone,
  contour,
  curtain,
  fieldNormal,
  gltf,
  lerp,
  line,
  makeNoise,
  mix,
  nearestOnPath,
  rgb,
  ribbon,
  shade,
  smoothstep,
  spline,
  strata,
  surface,
  tube,
} from './diorama.mjs';

const [outPath, reportPath] = process.argv.slice(2);
if (!outPath) {
  console.error('usage: node water-cycle.mjs <out.glb> [report.json]');
  process.exit(2);
}

const N = makeNoise(23);
const X0 = -3.6;
const X1 = 3.6;
const Z0 = -2.2;
const Z1 = 2.2;
const YB = -1.1;
const STEP = 0.04;
const GRID = { x0: X0, x1: X1, z0: Z0, z1: Z1, step: STEP };
const AQ_TOP = -0.5;
const AQ_BOTTOM = -0.8;
const SKIN = 0.04;

// --- terrain ----------------------------------------------------------------------------------
const LAKE = { x: 1.9, z: 0.45, rx: 1.35, rz: 0.9 };
const lakeE = (x, z) => Math.hypot((x - LAKE.x) / LAKE.rx, (z - LAKE.z) / LAKE.rz);

/** Glacier valleys: path a → b, half-width, ice thickness. */
const GLACIERS = [
  { a: [-3.0, -1.95], b: [-1.95, -1.05], w: 0.32, h: 0.22, depth: [0.4, 0.3] },
  { a: [2.95, -2.05], b: [2.45, -1.32], w: 0.24, h: 0.17, depth: [0.36, 0.28] },
];
const segCoords = (a, b, x, z) => {
  const vx = b[0] - a[0];
  const vz = b[1] - a[1];
  const s = ((x - a[0]) * vx + (z - a[1]) * vz) / (vx * vx + vz * vz);
  const sc = clamp(s);
  return { s, sc, d: Math.hypot(x - (a[0] + sc * vx), z - (a[1] + sc * vz)) };
};

function rawTerrain(x, z) {
  // a high massif around each glacier, so its valley is cut into high ground
  let massif = 0;
  for (const g of GLACIERS) {
    const { sc, d } = segCoords(g.a, g.b, x, z);
    massif += 0.55 * Math.exp(-((d / 0.8) ** 2)) * (0.55 + 0.45 * (1 - sc));
  }
  const back = 2.3 * smoothstep(-0.45, -1.6, z) * (1 - 0.35 * smoothstep(-1.7, -2.2, z));
  const left = 1.7 * smoothstep(-1.3, -3.4, x) * (1 - 0.45 * smoothstep(0.4, 2.2, z));
  const peaks = 0.5 + 0.7 * N.ridged(x * 0.5 + 2, z * 0.5 + 1, 3);
  const range = Math.max(back, left) * peaks + 0.18 * Math.min(back, left);
  const hills = 0.28 * smoothstep(-0.2, -2.4, x) * smoothstep(0.6, 1.8, z) * (0.5 + 0.5 * N.fbm(x * 1.2, z * 1.2));
  const bowl = 0.63 * smoothstep(1.3, 0.55, lakeE(x, z));
  return Math.max(0.15 + range + massif + hills + 0.05 * N.fbm(x * 2, z * 2) - bowl, AQ_TOP + SKIN + 0.03);
}

/**
 * A glacier valley cut into the massif: the floor follows the ground along the
 * centre line (minus `depth`, never rising downstream), the ice lies on it.
 */
function valley({ a, b, w, h, depth }) {
  const coords = (x, z) => segCoords(a, b, x, z);
  const K = 40;
  let m = Infinity;
  const floors = Array.from({ length: K + 1 }, (_, k) => {
    const s = k / K;
    const x = lerp(a[0], b[0], s);
    const z = lerp(a[1], b[1], s);
    return (m = Math.min(m, rawTerrain(x, z) - lerp(depth[0], depth[1], s)));
  });
  const floor = (s) => {
    const f = clamp(s) * K;
    const k = Math.min(K - 1, Math.floor(f));
    return lerp(floors[k], floors[k + 1], f - k);
  };
  return {
    a,
    b,
    coords,
    terrain(x, z) {
      const { sc, d } = coords(x, z);
      const e = Math.max(0, d - w);
      return floor(sc) + 0.08 * (Math.min(d, w) / w) ** 2 + 0.5 * (1 - Math.exp(-e * 5)) + 1.1 * (1 - Math.exp(-e * 1.6)) * (0.6 + 0.6 * N.ridged(x * 0.7 + 4, z * 0.7)) + 0.5 * smoothstep(0.12, 0, sc);
    },
    ice(x, z, T) {
      const { s, sc, d } = coords(x, z);
      const g = floor(sc) + h * Math.sqrt(clamp((1.02 - s) / 0.45)) * (0.5 + 0.5 * smoothstep(0, 0.25, s)) + 0.04 * (Math.min(d, w) / w) ** 2;
      return { g, phi: Math.min(g - T - 0.004, 1.0 - s - 0.12 * (d / w) ** 2, w + 0.3 - d) };
    },
  };
}
const [GL1, GL2] = GLACIERS.map(valley);

const RIVER_1 = spline([[-1.92, -1.0], [-1.55, -0.6], [-1.1, -0.22], [-0.6, 0.12], [-0.05, 0.33], [0.45, 0.45], [0.75, 0.47]], 0.03);
const RIVER_2 = spline([[2.43, -1.28], [2.36, -0.98], [2.22, -0.66], [2.12, -0.36]], 0.03);

/** Ground with each glacier's trough blended in (walls rise above the ice, fading into the massif). */
function valleyTerrain(x, z) {
  let t = rawTerrain(x, z);
  for (const [gl, g] of [[GL1, GLACIERS[0]], [GL2, GLACIERS[1]]]) {
    const { s, d } = gl.coords(x, z);
    const k = smoothstep(g.w + 0.75, g.w + 0.25, d) * smoothstep(1.4, 1.05, s);
    if (k > 0) t = lerp(t, gl.terrain(x, z), k);
  }
  return t;
}
function bed(path) {
  let m = Infinity;
  return path.map(([x, z]) => (m = Math.min(m, valleyTerrain(x, z) - 0.03)));
}
const RIVERS = [
  { path: RIVER_1, bed: bed(RIVER_1), half: 0.06 },
  { path: RIVER_2, bed: bed(RIVER_2), half: 0.05 },
];
function terrain(x, z) {
  let t = valleyTerrain(x, z);
  for (const r of RIVERS) {
    const { d, i } = nearestOnPath(r.path, x, z);
    // only downstream of the source: no pit behind it (under the glacier)
    if (d > 1.2 || i < 0.5) continue;
    const k = Math.min(r.bed.length - 1, Math.round(i));
    t = Math.min(t, r.bed[k] + 0.85 * Math.max(0, d - r.half) ** 1.2);
  }
  return Math.max(t, AQ_TOP + SKIN + 0.03);
}
const tNormal = fieldNormal(terrain, STEP * 0.5);

// glacier surfaces
const glacierAt = (gl) => (x, z) => gl.ice(x, z, terrain(x, z)).g;
const glacierPhi = (gl) => (x, z) => gl.ice(x, z, terrain(x, z)).phi;

// --- colours ----------------------------------------------------------------------------------
const C = {
  rock: rgb('#857b70'),
  rock2: rgb('#a09487'),
  grass: rgb('#79a052'),
  grass2: rgb('#97b462'),
  steppe: rgb('#c2b47c'),
  sand: rgb('#d8c9a0'),
  snow: rgb('#f2f5f8'),
  ice: rgb('#cfe7f2'),
  river: rgb('#3f93d6'),
  lakeShallow: rgb('#5fb4dc'),
  lakeDeep: rgb('#1f6fb2'),
  cloud: rgb('#ffffff'),
  rainCloud: rgb('#b9c3cf'),
  spruce: rgb('#2c5a3c'),
  leaf: rgb('#5d9a45'),
  trunk: rgb('#5b4330'),
};
function groundColor(x, y, z, n) {
  let c = mix(C.rock, C.rock2, 0.5 + 0.5 * N.fbm(x * 3, z * 3));
  // grassland and dry steppe on the gentle lower ground, a sandy shore
  const low = smoothstep(1.2, 0.75, y) * smoothstep(0.7, 0.86, n[1]);
  c = mix(c, mix(C.grass, C.grass2, 0.5 + 0.5 * N.fbm(x * 2 + 7, z * 2)), low);
  c = mix(c, C.steppe, low * 0.45 * smoothstep(0.2, 0.8, N.fbm(x * 0.9 + 3, z * 0.9)));
  c = mix(c, C.sand, smoothstep(0.12, 0.02, y) * smoothstep(1.35, 1.0, lakeE(x, z)));
  const snowLine = 1.95 + 0.2 * N.fbm(x * 1.7, z * 1.7);
  c = mix(c, C.snow, smoothstep(snowLine - 0.12, snowLine + 0.12, y) * smoothstep(0.45, 0.68, n[1]));
  return shade(c, 0.92 + 0.12 * N.fbm(x * 9, z * 9));
}

// --- build ------------------------------------------------------------------------------------
const { doc, material, node } = gltf();
const M = {
  ground: material('ground', { rough: 0.95 }),
  section: material('section', { rough: 0.9 }),
  aquifer: material('aquifer', { rough: 0.6 }),
  snow: material('snow', { rough: 0.6 }),
  water: material('water', { rough: 0.12 }),
  cloud: material('cloud', { rough: 1, emissive: '#3a3f46' }),
  trees: material('trees', { rough: 0.9 }),
  arrow: material('arrow', { rough: 0.5, emissive: '#1d2a33' }),
  precip: material('precip', { rough: 0.5 }),
  sun: material('sun', { color: '#ffd54a', rough: 0.4, emissive: '#ffb800' }),
};
const root = node('WaterCycle');

// Ground block: surface, strata walls (aquifer band left to its own node), bottom.
const LAYERS = [
  { to: AQ_BOTTOM, color: rgb('#5c5650') },
  { to: AQ_TOP, skip: true },
  { to: -0.2, color: rgb('#b49a72') },
  { to: 0.15, color: rgb('#9c8466') },
  { to: 0.7, color: rgb('#8a7f72') },
  { to: 1.4, color: rgb('#776e63') },
  { to: 99, color: rgb('#8b8173') },
];
const skinColor = (x, z) => shade(groundColor(x, terrain(x, z), z, tNormal(x, z)), 0.8);
const wallBands = strata({ base: YB, top: terrain, layers: LAYERS, skin: SKIN, skinColor });
const SIDES = [
  [line([X0, Z1], [X1, Z1], STEP), [0, 0, 1]],
  [line([X0, Z0], [X1, Z0], STEP), [0, 0, -1]],
  [line([X0, Z0], [X0, Z1], STEP), [-1, 0, 0]],
  [line([X1, Z0], [X1, Z1], STEP), [1, 0, 0]],
];
const ground = surface({ ...GRID, h: terrain, color: groundColor, normal: tNormal }).geo;
for (const [path, n] of SIDES) ground.append(bandWall(path, wallBands, n));
{
  const g = new Geo();
  const n = [0, -1, 0];
  const c = rgb('#4f4842');
  g.quad(g.v([X0, YB, Z0], n, c), g.v([X1, YB, Z0], n, c), g.v([X1, YB, Z1], n, c), g.v([X0, YB, Z1], n, c), n);
  ground.append(g);
}
node('Ground', ground, M.ground, root);
const CAP = line([X0, CAP_Z], [X1, CAP_Z], STEP);
node('Ground_Section', bandWall(CAP, (x) => wallBands(x, 0), [0, 0, 1]), M.section, root);

// Aquifer: the saturated layer, on the block faces and in the section.
const AQ_C_TOP = rgb('#5b9bd0');
const AQ_C_BOTTOM = rgb('#2f6a9e');
const aquiferBand = (x, z) => [{ top: Math.min(AQ_TOP, terrain(x, z) - SKIN), bottom: AQ_BOTTOM, cTop: AQ_C_TOP, cBottom: AQ_C_BOTTOM }];
const aq = new Geo();
for (const [path, n] of SIDES) aq.append(bandWall(path, aquiferBand, n));
const aquifer = node('Aquifer', aq, M.aquifer, root);
// water-table line: a thin pale stripe at the top of the aquifer
const wt = new Geo();
for (const [path, n] of SIDES) wt.append(bandWall(path.map(([x, z]) => [x + n[0] * 0.002, z + n[2] * 0.002]), () => [{ top: AQ_TOP + 0.012, bottom: AQ_TOP - 0.004, cTop: rgb('#a9d4f2') }], n));
node('Aquifer_WaterTable', wt, M.aquifer, aquifer);
node('Aquifer_Section', bandWall(CAP, (x) => aquiferBand(x, 0), [0, 0, 1]), M.aquifer, aquifer);

// Lake (level 0) with its section.
const lakePhi = (x, z) => Math.min(-terrain(x, z), 1.4 - lakeE(x, z));
const lakeNode = node(
  'Lake',
  surface({
    x0: LAKE.x - LAKE.rx * 1.45,
    x1: LAKE.x + LAKE.rx * 1.45,
    z0: LAKE.z - LAKE.rz * 1.45,
    z1: LAKE.z + LAKE.rz * 1.45,
    step: 0.03,
    h: () => 0,
    phi: lakePhi,
    color: (x, y, z) => mix(C.lakeShallow, C.lakeDeep, smoothstep(0.02, 0.4, -terrain(x, z))),
    normal: () => [0, 1, 0],
  }).geo,
  M.water,
  root,
);
node('Lake_Section', bandWall(line([LAKE.x - LAKE.rx * 1.4, CAP_Z], [LAKE.x + LAKE.rx * 1.4, CAP_Z], 0.02), (x) => {
  const t = terrain(x, 0);
  return [{ top: lakePhi(x, 0) >= 0 ? 0 : t, bottom: t, cTop: C.lakeShallow, cBottom: C.lakeDeep }];
}, [0, 0, 1]), M.water, lakeNode);

// Glaciers.
function glacierParts(gl, name) {
  const h = glacierAt(gl);
  // stays inside the block
  const phi = (x, z) => Math.min(glacierPhi(gl)(x, z), x - X0 - 0.02, X1 - x - 0.02, z - Z0 - 0.02);
  const nrm = fieldNormal(h, 0.02);
  const [ax, az] = gl.a;
  const [bx, bz] = gl.b;
  const box = { x0: Math.max(X0, Math.min(ax, bx) - 0.7), x1: Math.min(X1, Math.max(ax, bx) + 0.7), z0: Math.max(Z0, Math.min(az, bz) - 0.7), z1: Math.min(Z1, Math.max(az, bz) + 0.7), step: 0.025 };
  const col = (x, y, z) => {
    const s = gl.coords(x, z).s;
    return mix(C.snow, C.ice, smoothstep(0.55, 0.85, s) + 0.15 * N.fbm(x * 4, z * 4));
  };
  const surf = surface({ ...box, h, phi, color: col, normal: nrm }).geo;
  surf.append(curtain(contour({ ...box, fn: phi }), { top: h, bottom: (x, z) => terrain(x, z) - 0.03, phi, cTop: rgb('#c3e2f1'), cBottom: rgb('#6ea5c9') }));
  // a few transverse crevasses on the lower part
  for (let k = 0; k < 3; k++) {
    const s = 0.66 + k * 0.09;
    const cx = lerp(ax, bx, s);
    const cz = lerp(az, bz, s);
    const vx = bx - ax;
    const vz = bz - az;
    const l = Math.hypot(vx, vz);
    const [px, pz] = [-vz / l, vx / l];
    const pts = [-0.1, 0, 0.1].map((u) => [cx + px * u - (vx / l) * Math.abs(u) * 0.4, cz + pz * u - (vz / l) * Math.abs(u) * 0.4]);
    if (pts.every(([x, z]) => phi(x, z) > 0.01)) surf.append(ribbon(spline(pts, 0.02), { width: (t) => 0.013 * Math.sin(Math.PI * clamp(t, 0.05, 0.95)) + 0.004, y: (x, z) => h(x, z) + 0.004, color: rgb('#2a6390'), normal: nrm }));
  }
  return node(name, surf, M.snow, root);
}
glacierParts(GL1, 'Glacier');
glacierParts(GL2, 'Glacier_2');

// Rivers.
const riverY = (x, z) => terrain(x, z) + 0.016;
node('River_Main', ribbon(RIVER_1, { width: (t) => 0.05 + 0.09 * t, y: riverY, color: (t) => mix(rgb('#8fcbe6'), C.river, smoothstep(0, 0.4, t)) }), M.water, root);
node('River_East', ribbon(RIVER_2, { width: (t) => 0.04 + 0.06 * t, y: riverY, color: (t) => mix(rgb('#8fcbe6'), C.river, smoothstep(0, 0.4, t)) }), M.water, root);

// Clouds: fair-weather cumulus over the lake, a big cloud over the valley, a grey rain/snow cloud over the glacier.
function cloud(centre, size, seed, color, puffs = 7) {
  const g = new Geo();
  for (let k = 0; k < puffs; k++) {
    const a = (k / puffs) * Math.PI * 2 + N.rand(k, seed);
    const r = k === 0 ? 0 : size * (0.45 + 0.35 * N.rand(k, seed + 1));
    const c = [centre[0] + Math.cos(a) * r, centre[1] + (k === 0 ? size * 0.25 : size * 0.12 * N.rand(k, seed + 2)), centre[2] + Math.sin(a) * r * 0.6];
    const rr = size * (k === 0 ? 0.62 : 0.38 + 0.2 * N.rand(k, seed + 3));
    g.append(blob(c, { radii: [rr, rr * 0.78, rr * 0.85], color: (d) => shade(color, 0.86 + 0.14 * clamp(d[1] + 0.5)), detail: 2, jitter: (d) => 1 + 0.06 * N.n2(d[0] * 3 + k, d[2] * 3 + seed) }));
  }
  // flat base: a cloud's bottom is the condensation level
  for (let i = 1; i < g.P.length; i += 3) g.P[i] = Math.max(g.P[i], centre[1] - size * 0.25);
  return g.smoothNormals();
}
const CLOUDS = {
  Cloud_Valley: { c: [-0.55, 2.6, -0.45], size: 0.5, color: C.cloud },
  Cloud_Rain: { c: [-2.55, 3.3, -1.85], size: 0.5, color: C.rainCloud },
  Cloud_Lake: { c: [2.0, 2.15, 0.25], size: 0.36, color: C.cloud },
};
Object.entries(CLOUDS).forEach(([name, v], i) => node(name, cloud(v.c, v.size, 30 + i * 10, v.color), M.cloud, root));

// Precipitation (decor): rain from the valley cloud, snow over the glacier.
const rain = new Geo();
for (let k = 0; k < 26; k++) {
  const x = -0.55 + (N.rand(k, 201) - 0.5) * 0.9;
  const z = -0.45 + (N.rand(k, 202) - 0.5) * 0.5;
  const top = 2.35 - 0.1 * N.rand(k, 203);
  const len = 0.18 + 0.12 * N.rand(k, 204);
  for (let y = top; y > terrain(x, z) + 0.25; y -= len * 1.9)
    rain.append(tube([[x, y, z], [x - 0.03, y - len, z]], { radius: 0.006, color: rgb('#6ea8dc'), segs: 4 }));
}
node('Precip_Rain', rain, M.precip, root);
const snowfall = new Geo();
for (let k = 0; k < 60; k++) {
  const x = -2.5 + (N.rand(k, 301) - 0.5) * 0.9;
  const z = -1.6 + (N.rand(k, 302) - 0.5) * 0.6;
  const ground = terrain(x, z);
  const y = lerp(ground + 0.12, 3.1, N.rand(k, 303));
  snowfall.append(blob([x, y, z], { radii: [0.016, 0.016, 0.016], color: C.snow, detail: 0 }));
}
node('Precip_Snow', snowfall, M.precip, root);

// Sun (decor).
node('Sun', blob([2.95, 3.25, -1.95], { radii: [0.3, 0.3, 0.3], color: rgb('#ffd54a'), detail: 2 }), M.sun, root);

// Trees (decor): spruce on the mid slopes, leafy trees by the shore and rivers.
const trees = new Geo();
let planted = 0;
for (let k = 0; k < 2400 && planted < 120; k++) {
  const x = lerp(X0 + 0.1, X1 - 0.1, N.rand(k, 101));
  const z = lerp(Z0 + 0.1, Z1 - 0.1, N.rand(k, 102));
  const y = terrain(x, z);
  const n = tNormal(x, z);
  if (n[1] < 0.72 || lakeE(x, z) < 1.12) continue;
  if (glacierPhi(GL1)(x, z) > -0.05 || glacierPhi(GL2)(x, z) > -0.05) continue;
  const dr = Math.min(...RIVERS.map((r) => nearestOnPath(r.path, x, z).d));
  if (dr < 0.1) continue;
  const s = 0.75 + 0.5 * N.rand(k, 103);
  if (y > 0.45 && y < 1.45 && N.rand(k, 105) < 0.75) {
    const g = shade(C.spruce, 0.85 + 0.3 * N.rand(k, 104));
    trees.append(tube([[x, y - 0.01, z], [x, y + 0.045 * s, z]], { radius: 0.011 * s, color: C.trunk, segs: 5 }));
    trees.append(cone([x, y + 0.035 * s, z], { radius: 0.07 * s, height: 0.13 * s, color: g, segs: 7 }));
    trees.append(cone([x, y + 0.095 * s, z], { radius: 0.05 * s, height: 0.1 * s, color: shade(g, 1.1), segs: 7 }));
    planted++;
  } else if (y > 0.02 && y < 0.45 && (dr < 0.4 || lakeE(x, z) < 1.5)) {
    const g = shade(C.leaf, 0.85 + 0.3 * N.rand(k, 106));
    trees.append(tube([[x, y - 0.01, z], [x, y + 0.06 * s, z]], { radius: 0.012 * s, color: C.trunk, segs: 5 }));
    trees.append(blob([x, y + 0.1 * s, z], { radii: [0.065 * s, 0.07 * s, 0.065 * s], color: g, detail: 1, jitter: (d) => 1 + 0.12 * N.n2(d[0] * 4 + k, d[2] * 4) }));
    planted++;
  }
}
node('Trees', trees, M.trees, root);

// Arrows (decor). Evaporation from the lake, transpiration from the forest, vapour carried to the ranges.
const arrows = new Geo();
const wavy = (x, z, y0, y1, amp, seed) => {
  const pts = [];
  for (let y = y0; y <= y1; y += 0.06) pts.push([x + amp * Math.sin((y - y0) * 7 + seed), y, z]);
  return pts;
};
[[1.55, 0.35], [2.0, 0.6], [2.45, 0.3]].forEach(([x, z], k) => arrows.append(arrow(wavy(x, z, 0.08, 1.7, 0.05, k), { radius: 0.022, color: rgb('#9ad2f5'), head: 2.6, headLength: 5 })));
node('Arrow_Evaporation', arrows, M.arrow, root);
const tr = new Geo();
[[-1.4, 0.75], [-1.05, 0.95]].forEach(([x, z], k) => {
  const y0 = terrain(x, z) + 0.2;
  tr.append(arrow(wavy(x, z, y0, y0 + 0.9, 0.04, k + 3), { radius: 0.018, color: rgb('#9bd39a'), head: 2.6, headLength: 5 }));
});
node('Arrow_Transpiration', tr, M.arrow, root);
node(
  'Arrow_Vapour',
  arrow(spline([[1.6, 2.5, 0.2], [0.9, 2.95, 0.0], [0.1, 3.05, -0.3], [-0.5, 3.0, -0.5]], 0.05), { radius: 0.022, color: rgb('#e3ecf3'), head: 2.6, headLength: 5 }),
  M.arrow,
  root,
);
// Surface runoff / infiltration markers: short arrows into the ground on the meadow.
const inf = new Geo();
[[-0.9, 0.9], [-0.5, 1.05], [-0.15, 0.95]].forEach(([x, z]) => {
  const y = terrain(x, z);
  inf.append(arrow([[x, y + 0.35, z], [x, y + 0.04, z]], { radius: 0.016, color: rgb('#6fb2e6'), head: 2.6, headLength: 5 }));
});
node('Arrow_Infiltration', inf, M.arrow, root);

// Section-only arrows, flat on the cap plane: infiltration to the aquifer, groundwater flow into the lake.
function flatArrow(pts, width, color) {
  const g = new Geo();
  const z = CAP_Z + 0.002;
  const n = [0, 0, 1];
  const dense = spline(pts, 0.03);
  const L = dense.length;
  const head = 4;
  const side = (i, w) => {
    const p = dense[Math.max(0, i - 1)];
    const q = dense[Math.min(L - 1, i + 1)];
    const tx = q[0] - p[0];
    const ty = q[1] - p[1];
    const l = Math.hypot(tx, ty) || 1;
    return [
      [dense[i][0] - (ty / l) * w, dense[i][1] + (tx / l) * w],
      [dense[i][0] + (ty / l) * w, dense[i][1] - (tx / l) * w],
    ];
  };
  for (let i = 0; i < L - head - 1; i++) {
    const [a, b] = side(i, width / 2);
    const [c, d] = side(i + 1, width / 2);
    g.quad(g.v([a[0], a[1], z], n, color), g.v([b[0], b[1], z], n, color), g.v([d[0], d[1], z], n, color), g.v([c[0], c[1], z], n, color), n);
  }
  const [hl, hr] = side(L - head - 1, width * 1.4);
  const tip = dense[L - 1];
  g.tri(g.v([hl[0], hl[1], z], n, color), g.v([hr[0], hr[1], z], n, color), g.v([tip[0], tip[1], z], n, color), n);
  return g;
}
const under = new Geo();
under.append(flatArrow([[-0.75, terrain(-0.75, 0) - 0.06], [-0.7, -0.2], [-0.62, AQ_TOP - 0.05]], 0.05, rgb('#d8ecfa')));
under.append(flatArrow([[-0.35, -0.66], [0.3, -0.66], [0.8, -0.62], [1.05, -0.52]], 0.05, rgb('#d8ecfa')));
node('Arrow_Groundwater', under, M.arrow, root);

// Atmosphere: the sky backdrop behind the ranges (curving forward at the ends), gradient texture.
const sky = new Geo();
{
  const R = [];
  for (let x = X0; x <= X1 + 1e-9; x += 0.1) R.push([x, Z0 - 0.04]);
  const strips = [R];
  const TOP = 3.9;
  for (const path of strips) {
    const bottom = path.map(([x, z]) => Math.max(terrain(clamp(x, X0, X1), clamp(z, Z0, Z1)) - 0.05, 0));
    for (let i = 0; i < path.length - 1; i++) {
      const [ax, az] = path[i];
      const [bx, bz] = path[i + 1];
      const tx = bx - ax;
      const tz = bz - az;
      const l = Math.hypot(tx, tz);
      const n = [-tz / l, 0, tx / l]; // towards the diorama (inside of the curve)
      const nn = n[2] < 0 && Math.abs(n[0]) < 0.5 ? [-n[0], 0, -n[2]] : n;
      const centreDir = [-(ax + bx) / 2, 0, -(az + bz) / 2];
      const facing = nn[0] * centreDir[0] + nn[2] * centreDir[2] >= 0 ? nn : [-nn[0], 0, -nn[2]];
      const v = (x, y, z) => sky.v([x, y, z], facing, [1, 1, 1], [0.5, 1 - y / TOP]);
      const a = v(ax, bottom[i], az);
      const b = v(bx, bottom[i + 1], bz);
      const c = v(bx, TOP, bz);
      const d = v(ax, TOP, az);
      sky.quad(a, b, c, d, facing);
    }
  }
}
// vertical gradient: pale at the horizon, deeper blue above
const skyPng = await sharp({ create: { width: 4, height: 64, channels: 3, background: '#000000' } })
  .raw()
  .toBuffer()
  .then(() => {
    const px = Buffer.alloc(4 * 64 * 3);
    for (let j = 0; j < 64; j++) {
      const t = j / 63; // 0 = top
      const top = [118, 176, 228];
      const bot = [226, 240, 250];
      const c = top.map((v, i) => Math.round(v + (bot[i] - v) * t ** 1.4));
      for (let i = 0; i < 4; i++) px.set(c, (j * 4 + i) * 3);
    }
    return sharp(px, { raw: { width: 4, height: 64, channels: 3 } }).png().toBuffer();
  });
const skyTex = doc.createTexture('Sky').setImage(new Uint8Array(skyPng)).setMimeType('image/png');
node('Atmosphere', sky, material('sky', { rough: 1, texture: skyTex, emissiveTexture: skyTex, emissive: '#b8b8b8' }), root);

doc.createScene('Scene').addChild(root);

// --- write ------------------------------------------------------------------------------------
await optimise(doc, { ratio: 1, maxTexture: 64 });
const io = await createIO();
const glb = await io.writeBinary(doc);
const tris = docTriangles(doc);
checkBudget('water-cycle.glb', glb.byteLength, tris);
writeFileSync(outPath, glb);

const r2 = (v) => Number(v.toFixed(2));
const at = (x, z, dy = 0.03) => [r2(x), r2(terrain(x, z) + dy), r2(z)];
const g1 = glacierAt(GL1);
const report = {
  sizeAfter: glb.byteLength,
  trianglesAfter: tris,
  anchors: {
    'geo.atmosphere': [0, 3.4, r2(Z0)],
    'geo.cloud': CLOUDS.Cloud_Valley.c,
    'geo.glacier': [r2(lerp(GL1.a[0], GL1.b[0], 0.55)), r2(g1(lerp(GL1.a[0], GL1.b[0], 0.55), lerp(GL1.a[1], GL1.b[1], 0.55)) + 0.04), r2(lerp(GL1.a[1], GL1.b[1], 0.55))],
    'geo.river': at(-0.6, 0.12),
    'geo.lake': [LAKE.x, 0.02, LAKE.z],
    'geo.groundwater': [0.4, r2((AQ_TOP + AQ_BOTTOM) / 2), Z1],
  },
  nodes: nodeTree(doc),
};
if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, nodes: report.nodes.length }, null, 2));
