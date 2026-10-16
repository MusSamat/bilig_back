#!/usr/bin/env node
/**
 * glaciers.glb: a Tien Shan valley-glacier diorama, made here (our own
 * geometry, CC0). No free 3D model of a glacier with separate zones and
 * moraines was found (NASA 3D Resources, Smithsonian 3D, Poly Haven, Kenney,
 * Wikimedia Commons; marketplace models are not CC0/CC BY), so the pipeline
 * builds it:
 *
 *   node glaciers.mjs <out.glb> [report.json]
 *
 * A valley glacier flows from a cirque (left, high) towards the camera-right;
 * a tributary from the back joins it and leaves a medial moraine. Above the
 * equilibrium line (dashed) lies the snow-covered accumulation zone, below it
 * the bare-ice ablation zone with crevasses and meltwater streams. The tongue
 * ends in a proglacial lake dammed by the young terminal moraine; a braided
 * river crosses the outwash plain past an older, vegetated terminal moraine
 * (the glacier's earlier extent). Section view (z > 0 clipped) shows the
 * glacier's long profile: snow → firn layers → ice → basal debris on bedrock.
 *
 * Node names = the topic's concept masks: Glacier (Glacier_Margin,
 * Glacier_Crevasses, Glacier_Section), Zone_Accumulation, Zone_Ablation,
 * Moraine_*, Melt_*, River_*. Terrain, Trees and EquilibriumLine are decor.
 */
import { writeFileSync } from 'node:fs';
import { checkBudget, createIO, docTriangles, nodeTree, optimise } from './lib.mjs';
import {
  CAP_Z,
  Geo,
  bandWall,
  blob,
  chain,
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
  console.error('usage: node glaciers.mjs <out.glb> [report.json]');
  process.exit(2);
}

const N = makeNoise(11);
const X0 = -3.6;
const X1 = 3.6;
const Z0 = -2.0;
const Z1 = 2.0;
const YB = -0.7;
const STEP = 0.04;
const GRID = { x0: X0, x1: X1, z0: Z0, z1: Z1, step: STEP };

// --- valley layout ----------------------------------------------------------------------------
/** Valley centre line (z) and half-width; the outwash plain turns towards the camera. */
const zc = (x) => 0.18 * Math.sin(0.6 * x + 0.4) + 0.7 * smoothstep(0.9, 3.6, x);
const W = (x) => 0.9 + 0.45 * smoothstep(0.8, 3.2, x);
/** Valley floor along the valley. */
const F = (x) => 0.1 + 1.75 * clamp(1 - (x - X0) / (X1 - X0)) ** 1.5;
/** Cirque headwall weight (1 at the head). */
const hw = (x) => smoothstep(-2.7, -3.6, x);
const X_SN = 1.0; // snout

function rawTerrain(x, z) {
  const c = zc(x);
  const d = Math.abs(z - c);
  const w = W(x);
  const back = z < c;
  const floor = F(x) + 0.1 * (Math.min(d, w) / w) ** 2;
  const e = Math.max(0, d - w);
  // back range high, front range low (and lower still at the front edge) so the valley is in view
  const amp = back ? 1.55 : 0.8 * (1 - 0.4 * smoothstep(0.5, 3.6, x)) * (1 - 0.5 * smoothstep(Z1 - 1.0, Z1, z));
  // a steep U-trough side (holds the ice) below the range itself
  const wall = 0.62 * (1 - Math.exp(-e * 5)) + amp * (1 - Math.exp(-e * 1.7));
  const peaks = 0.55 + 0.65 * N.ridged(x * 0.45 + 3, z * 0.45 - 1, 3);
  const head = 1.0 * hw(x) ** 1.4 * (0.75 + 0.4 * N.ridged(x * 0.7, z * 0.7, 3));
  const rough = 0.025 * N.fbm(x * 2.2, z * 2.2) + 0.05 * smoothstep(0, 0.6, e) * N.fbm(x * 1.3 + 5, z * 1.3);
  return floor + wall * peaks + head + rough;
}

// Tributary glacier valley from the back, joining the main glacier (medial moraine).
const TA = [-2.45, -1.85];
const TB = [-1.15, -0.8];
const W2 = 0.36;
function tribCoords(x, z) {
  const vx = TB[0] - TA[0];
  const vz = TB[1] - TA[1];
  const s = ((x - TA[0]) * vx + (z - TA[1]) * vz) / (vx * vx + vz * vz);
  const sc = clamp(s);
  const d = Math.hypot(x - (TA[0] + sc * vx), z - (TA[1] + sc * vz));
  return { s, sc, d };
}
const F2 = (s) => lerp(1.85, 1.05, clamp(s) ** 0.9);
function tribTerrain(x, z) {
  const { sc, d } = tribCoords(x, z);
  const e = Math.max(0, d - W2);
  const head = 0.7 * smoothstep(0.15, 0, sc);
  return F2(sc) + 0.08 * (Math.min(d, W2) / W2) ** 2 + 0.45 * (1 - Math.exp(-e * 5)) + 1.3 * (1 - Math.exp(-e * 1.8)) * (0.7 + 0.5 * N.ridged(x * 0.6 + 8, z * 0.6, 3)) + head;
}

// Proglacial lake in a depression just in front of the snout.
const LX = X_SN + 0.22;
const LZ = zc(LX);
const LRX = 0.32;
const LRZ = 0.48;
const lakeR2 = (x, z) => ((x - LX) / LRX) ** 2 + ((z - LZ) / LRZ) ** 2;
const L = F(LX) + 0.01;

// Rivers: main channel from the lake outlet across the outwash plain, two braids.
const OUTLET = [LX + LRX, LZ];
const RIVER = spline([OUTLET, [1.9, LZ + 0.1], [2.3, 0.38], [2.7, 0.55], [3.1, 0.64], [3.4, 0.72], [3.65, 0.78]], 0.03);
const BRAIDS = [
  spline([[2.2, 0.36], [2.45, 0.62], [2.75, 0.8], [3.05, 0.83], [3.3, 0.72]], 0.03),
  spline([[2.85, 0.57], [3.1, 0.47], [3.35, 0.52], [3.55, 0.75]], 0.03),
];

/** Rim of the lake basin under the young terminal moraine (front half, gap at the outlet). */
function rim(x, z) {
  const a = Math.atan2((z - LZ) / (LRZ + 0.09), (x - LX) / (LRX + 0.07));
  if (Math.abs(a) > 1.75) return 0;
  const ring = Math.abs(Math.sqrt(((x - LX) / (LRX + 0.07)) ** 2 + ((z - LZ) / (LRZ + 0.09)) ** 2) - 1);
  return 0.13 * Math.max(0, 1 - ring / 0.45) ** 2 * smoothstep(0.1, 0.24, Math.abs(a));
}
function lakeTerrain(x, z) {
  const t = Math.min(rawTerrain(x, z), tribTerrain(x, z));
  return t - 0.22 * Math.max(0, 1 - lakeR2(x, z)) ** 0.8 + rim(x, z);
}
/** River bed heights along a path: monotonically falling (cumulative min of the ground). */
function bed(path) {
  let m = Infinity;
  return path.map(([x, z]) => (m = Math.min(m, lakeTerrain(x, z) - 0.025)));
}
const RIVERS = [
  { path: RIVER, bed: bed(RIVER), half: 0.07 },
  ...BRAIDS.map((p) => ({ path: p, bed: bed(p), half: 0.045 })),
];
function terrain(x, z) {
  let t = lakeTerrain(x, z);
  for (const r of RIVERS) {
    const { d, i } = nearestOnPath(r.path, x, z);
    if (d > r.half + 0.5) continue;
    const k = Math.min(r.bed.length - 1, Math.round(i));
    t = Math.min(t, r.bed[k] + 0.5 * Math.max(0, d - r.half) ** 1.2);
  }
  return t;
}
const tNormal = fieldNormal(terrain, STEP * 0.5);

// --- glacier surface --------------------------------------------------------------------------
const H0 = (x) => 0.4 * Math.sqrt(clamp((X_SN + 0.1 - x) / 1.5)) * (0.5 + 0.5 * smoothstep(-3.4, -2.4, x));
function glacier(x, z) {
  const d = Math.abs(z - zc(x));
  const w = W(x);
  const main = d < w + 0.5 ? F(x) + H0(x) + 0.05 * (Math.min(d, w * 1.3) / w) ** 2 + 0.5 * hw(x) ** 1.3 : -10;
  const t = tribCoords(x, z);
  if (t.s > 1.05 || t.d > W2 + 0.3) return main;
  const H2 = 0.25 * (0.45 + 0.55 * smoothstep(0, 0.3, t.sc));
  return Math.max(main, F2(t.sc) + H2 + 0.04 * (Math.min(t.d, W2) / W2) ** 2);
}
/** Rounded tongue: the snout front is at X_SN on the centre line, further back at the margins. */
const snout = (x, z) => X_SN - 0.28 * (Math.abs(z - zc(x)) / W(x)) ** 2 - x;
const ice = (x, z) => Math.min(glacier(x, z) - terrain(x, z) - 0.004, snout(x, z));
const ELA = glacier(-0.55, zc(-0.55));
const gNormal = fieldNormal(glacier, STEP * 0.5);

// --- colours ----------------------------------------------------------------------------------
const C = {
  rock: rgb('#7b7268'),
  rock2: rgb('#9a9086'),
  grass: rgb('#6f9150'),
  grass2: rgb('#8aa65c'),
  gravel: rgb('#b3ab9d'),
  bare: rgb('#9b958c'),
  snow: rgb('#f2f5f8'),
  snowShade: rgb('#cfe0ee'),
  ice: rgb('#cfe7f2'),
  iceBlue: rgb('#9fcde3'),
  dirtyIce: rgb('#a3aeac'),
  moraine: rgb('#7d6d5c'),
  moraineOld: rgb('#8e9a68'),
  boulder: rgb('#77706a'),
  water: rgb('#4f9fd8'),
  lake: rgb('#7cc3c8'),
  stream: rgb('#55b5e6'),
  crevasse: rgb('#1f557e'),
  ela: rgb('#e0583a'),
  spruce: rgb('#2c5a3c'),
  trunk: rgb('#5b4330'),
};
function groundColor(x, y, z, n) {
  // bedrock under the ice (seen in the section)
  if (ice(x, z) > -0.01) return shade(C.bare, 0.85);
  const d = Math.abs(z - zc(x));
  let c = mix(C.rock, C.rock2, 0.5 + 0.5 * N.fbm(x * 3, z * 3));
  c = mix(c, mix(C.grass, C.grass2, 0.5 + 0.5 * N.fbm(x * 2 + 7, z * 2)), smoothstep(1.3, 0.9, y) * smoothstep(0.72, 0.86, n[1]));
  // outwash gravel on the valley floor below the snout
  c = mix(c, C.gravel, 0.9 * smoothstep(W(x) * 0.95, W(x) * 0.55, d) * smoothstep(X_SN - 0.1, X_SN + 0.25, x));
  // freshly deglaciated forefield: bare grey till between the snout and the old moraine
  c = mix(c, C.bare, 0.8 * smoothstep(2.75, 2.45, x) * smoothstep(X_SN - 0.3, X_SN, x) * smoothstep(W(x) + 0.5, W(x), d));
  const snowLine = 2.3 + 0.2 * N.fbm(x * 1.7, z * 1.7);
  c = mix(c, C.snow, smoothstep(snowLine - 0.12, snowLine + 0.12, y) * smoothstep(0.45, 0.68, n[1]));
  return shade(c, 0.92 + 0.12 * N.fbm(x * 9, z * 9));
}
function accColor(x, y, z) {
  // firn snow, faintly blue, with flow banding parallel to the valley
  const band = 0.5 + 0.5 * Math.sin(((z - zc(x)) / W(x)) * 13 + N.fbm(x, z) * 2);
  return mix(mix(rgb('#eaf2f9'), C.snowShade, 0.35 + 0.45 * N.fbm(x * 2.5, z * 2.5)), rgb('#c9dceb'), 0.22 * band);
}
function ablColor(x, y, z) {
  const d = Math.abs(z - zc(x)) / (W(x) + 0.2);
  let c = mix(C.ice, C.iceBlue, 0.5 + 0.6 * N.fbm(x * 3, z * 3));
  c = mix(c, C.dirtyIce, smoothstep(0.55, 1.0, d) * 0.8 + smoothstep(X_SN - 0.4, X_SN, x) * 0.35);
  return c;
}

// --- build ------------------------------------------------------------------------------------
const { doc, material, node } = gltf();
const M = {
  ground: material('ground', { rough: 0.95 }),
  snow: material('snow', { rough: 0.7 }),
  ice: material('ice', { rough: 0.35 }),
  section: material('section', { rough: 0.9 }),
  moraine: material('moraine', { rough: 0.95 }),
  water: material('water', { rough: 0.12 }),
  line: material('line', { rough: 0.6 }),
  trees: material('trees', { rough: 0.9 }),
};
const root = node('GlacierValley');

// Terrain block: surface, strata walls, bottom.
const STRATA = [
  { to: -0.45, color: rgb('#5d554d') },
  { to: -0.15, color: rgb('#857a6d') },
  { to: 0.2, color: rgb('#6f665b') },
  { to: 0.6, color: rgb('#8f8577') },
  { to: 1.1, color: rgb('#776e63') },
  { to: 1.7, color: rgb('#8b8173') },
  { to: 2.5, color: rgb('#746b60') },
  { to: 99, color: rgb('#868074') },
];
const skinColor = (x, z) => shade(groundColor(x, terrain(x, z), z, tNormal(x, z)), 0.85);
const wallBands = strata({ base: YB, top: terrain, layers: STRATA, skinColor });
const terrainGeo = surface({ ...GRID, h: terrain, color: groundColor, normal: tNormal }).geo;
terrainGeo.append(bandWall(line([X0, Z1], [X1, Z1], STEP), wallBands, [0, 0, 1]));
terrainGeo.append(bandWall(line([X0, Z0], [X1, Z0], STEP), wallBands, [0, 0, -1]));
terrainGeo.append(bandWall(line([X0, Z0], [X0, Z1], STEP), wallBands, [-1, 0, 0]));
terrainGeo.append(bandWall(line([X1, Z0], [X1, Z1], STEP), wallBands, [1, 0, 0]));
{
  const g = new Geo();
  const n = [0, -1, 0];
  const c = rgb('#4f4842');
  g.quad(g.v([X0, YB, Z0], n, c), g.v([X1, YB, Z0], n, c), g.v([X1, YB, Z1], n, c), g.v([X0, YB, Z1], n, c), n);
  terrainGeo.append(g);
}
node('Terrain', terrainGeo, M.ground, root);
node('Terrain_Section', bandWall(line([X0, CAP_Z], [X1, CAP_Z], STEP), (x) => wallBands(x, 0), [0, 0, 1]), M.section, root);

// Glacier: zones (surface), margin cliffs, crevasses, long section.
const glacierNode = node('Glacier', null, null, root);
const acc = surface({ ...GRID, h: glacier, phi: (x, z) => Math.min(ice(x, z), glacier(x, z) - ELA), color: accColor, normal: gNormal });
const abl = surface({ ...GRID, h: glacier, phi: (x, z) => Math.min(ice(x, z), ELA - glacier(x, z)), color: ablColor, normal: gNormal });
node('Zone_Accumulation', acc.geo, M.snow, root);
node('Zone_Ablation', abl.geo, M.ice, root);

const margin = contour({ ...GRID, fn: ice });
const marginGeo = curtain(margin, {
  top: glacier,
  bottom: (x, z) => terrain(x, z) - 0.03,
  phi: ice,
  cTop: (x, z) => (glacier(x, z) > ELA ? C.snow : rgb('#b6dcec')),
  cBottom: rgb('#5f97bf'),
});
node('Glacier_Margin', marginGeo, M.ice, glacierNode);

// Transverse crevasses in the ablation zone and below the confluence; a bergschrund under the headwall.
const crev = new Geo();
// rows across the glacier: below the confluence (extending flow) and towards the tongue
const ROWS = [-0.95, -0.82, -0.69, 0.32, 0.46, 0.6, 0.72];
ROWS.forEach((xr, r) => {
  for (let k = 0; k < 6; k++) {
    const u = (k + 0.5) / 6 - 0.5 + (N.rand(r, k) - 0.5) * 0.08;
    const x = xr + (N.rand(r, k + 20) - 0.5) * 0.05;
    const z = zc(x) + u * 1.9 * W(x);
    const len = 0.13 + 0.12 * N.rand(r, k + 40);
    if (ice(x, z) < 0.05 || ice(x, z + len / 2) < 0.04 || ice(x, z - len / 2) < 0.04) continue;
    // chevron near the margins: the ends bend up-glacier
    const bend = 0.1 * Math.abs(u) * 2;
    const pts = spline([[x - bend * 0.5, z - len / 2], [x, z], [x - bend * 0.5, z + len / 2]], 0.02);
    crev.append(ribbon(pts, { width: (t) => 0.03 * Math.sin(Math.PI * clamp(t, 0.05, 0.95)) + 0.006, y: (px, pz) => glacier(px, pz) + 0.004, color: C.crevasse, normal: gNormal }));
  }
});
{
  const pts = [];
  for (let z = -0.5; z <= 0.45; z += 0.03) pts.push([-2.9 + 0.18 * (z / 0.5) ** 2, zc(-2.9) + z]);
  const ok = pts.filter(([x, z]) => ice(x, z) > 0.02);
  if (ok.length > 2) crev.append(ribbon(ok, { width: 0.03, y: (px, pz) => glacier(px, pz) + 0.004, color: C.crevasse, normal: gNormal }));
}
node('Glacier_Crevasses', crev, M.ice, glacierNode);

// Long section at z = 0: snow → firn bands → ice → basal debris.
const ICE_TOP = rgb('#c3e2f1');
const ICE_DEEP = rgb('#4d8cbb');
function iceBands(x) {
  const z = 0;
  const has = ice(x, z) >= 0;
  const T = terrain(x, z);
  const G = has ? glacier(x, z) : T;
  const accK = smoothstep(ELA - 0.08, ELA + 0.3, G);
  const snowD = 0.045 * accK;
  const firnD = 0.14 * accK;
  const debris = Math.min(0.025, (G - T) * 0.2);
  const bands = [];
  const put = (top, bottom, cTop, cBottom) => bands.push({ top: Math.max(top, bottom), bottom: Math.min(top, bottom), cTop, cBottom });
  put(T + debris, T, rgb('#6f6a63'));
  put(G - snowD - firnD, T + debris, ICE_TOP, ICE_DEEP);
  // firn: four annual layers, alternating
  for (let k = 0; k < 4; k++) {
    const top = G - snowD - (firnD * k) / 4;
    const bottom = G - snowD - (firnD * (k + 1)) / 4;
    put(top, bottom, k % 2 ? rgb('#dfe8ee') : rgb('#eef3f6'), k % 2 ? rgb('#d3e0e8') : rgb('#e6eef3'));
  }
  put(G, G - snowD, C.snow);
  return has ? bands : bands.map(() => ({ top: T, bottom: T, cTop: C.snow }));
}
node('Glacier_Section', bandWall(line([X0, CAP_Z], [X_SN + 0.02, CAP_Z], STEP / 2), (x) => iceBands(x), [0, 0, 1]), M.section, glacierNode);

// Equilibrium line: dashed red line along glacier = ELA.
const elaLines = chain(contour({ ...GRID, fn: (x, z) => glacier(x, z) - ELA, mask: (x, z) => ice(x, z) - 0.01 }));
const elaGeo = new Geo();
for (const l of elaLines) {
  if (l.length < 4) continue;
  elaGeo.append(ribbon(spline(l, 0.02), { width: 0.022, y: (x, z) => glacier(x, z) + 0.008, color: C.ela, dashes: [3, 2] }));
}
node('EquilibriumLine', elaGeo, M.line, root);

// --- moraines ---------------------------------------------------------------------------------
/** Ice margin z on one side of the glacier at x (searched outwards from the centre line). */
function marginZ(x, side) {
  let z = zc(x);
  for (let k = 0; k < 120; k++) {
    const nz = z + side * 0.01;
    if (ice(x, nz) < 0) return nz;
    z = nz;
  }
  return null;
}
const ridgeY = (x, z) => terrain(x, z) + 0.01;
const ridge = (pts2, r, color) =>
  tube(
    pts2.map(([x, z]) => [x, ridgeY(x, z), z]),
    { radius: (t, i) => r * (0.7 + 0.6 * (0.5 + 0.5 * N.n2(i * 0.6, r * 50))) * (0.35 + 0.65 * Math.sin(Math.PI * clamp(t, 0.02, 0.98)) ** 0.4), color: (t, i) => shade(color, 0.82 + 0.3 * N.rand(i, 7)), segs: 7, flatten: 0.6 },
  );
const boulders = (pts2, count, seed, spread, onY = ridgeY) => {
  const g = new Geo();
  for (let k = 0; k < count; k++) {
    const p = pts2[Math.floor(N.rand(k, seed) * pts2.length)];
    const x = p[0] + (N.rand(k, seed + 1) - 0.5) * spread;
    const z = p[1] + (N.rand(k, seed + 2) - 0.5) * spread;
    const r = 0.018 + 0.022 * N.rand(k, seed + 3);
    g.append(blob([x, onY(x, z) + r * 0.6, z], { radii: [r, r * 0.8, r], color: shade(C.boulder, 0.8 + 0.4 * N.rand(k, seed + 4)), detail: 1, jitter: (d) => 1 + 0.18 * N.n2(d[0] * 3 + k, d[2] * 3) }));
  }
  return g;
};

// Terminal moraine: arc in front of the lake with a gap for the outlet.
const arc = (cx, cz, rx, rz, from, to) => {
  const pts = [];
  for (let a = from; a <= to + 1e-9; a += 0.05) pts.push([cx + rx * Math.cos(a), cz + rz * Math.sin(a)]);
  return pts;
};
const termL = arc(LX, LZ, LRX + 0.07, LRZ + 0.09, -1.5, -0.2);
const termR = arc(LX, LZ, LRX + 0.07, LRZ + 0.09, 0.2, 1.5);

// Lateral moraines: along both margins of the ablation zone, joined to the terminal arc ends.
const lateral = (side) => {
  const pts = [];
  for (let x = -0.7; x <= X_SN - 0.05; x += 0.05) {
    const z = marginZ(x, side);
    if (z !== null) pts.push([x, z + side * 0.05]);
  }
  const end = side < 0 ? termL[0] : termR[termR.length - 1];
  return spline([...pts.filter((_, i) => i % 3 === 0), end], 0.03);
};
const latBack = lateral(-1);
const latFront = lateral(1);
const morGeo = (parts) => {
  const g = new Geo();
  for (const p of parts) g.append(p);
  return g;
};
node('Moraine_Lateral', morGeo([ridge(latBack, 0.09, C.moraine), ridge(latFront, 0.09, C.moraine), boulders(latBack, 18, 50, 0.1), boulders(latFront, 18, 60, 0.1)]), M.moraine, root);
node('Moraine_Terminal', morGeo([ridge(spline(termL, 0.03), 0.085, C.moraine), ridge(spline(termR, 0.03), 0.085, C.moraine), boulders(termL, 10, 70, 0.08), boulders(termR, 10, 80, 0.08)]), M.moraine, root);

// Older terminal moraine (the glacier's earlier extent), lower and grassed, cut by the river.
const OX = 2.55;
const oldArc = (from, to) => arc(OX - 0.45, zc(OX), 0.5, W(OX) + 0.05, from, to);
const oldRidge = (pts) =>
  tube(
    spline(pts, 0.03).map(([x, z]) => [x, terrain(x, z) - 0.01, z]),
    { radius: (t, i) => 0.1 * (0.8 + 0.4 * (0.5 + 0.5 * N.n2(i * 0.5, 3))) * (0.3 + 0.7 * Math.sin(Math.PI * clamp(t, 0.02, 0.98)) ** 0.5), color: (t, i) => shade(C.moraineOld, 0.85 + 0.25 * N.rand(i, 17)), segs: 7, flatten: 0.4 },
  );
node('Moraine_TerminalOld', morGeo([oldRidge(oldArc(-1.15, -0.2)), oldRidge(oldArc(0.18, 1.15))]), M.moraine, root);

// Medial moraine: dark debris band from the confluence down the glacier.
const medial = [];
for (let x = -1.15; x <= X_SN - 0.06; x += 0.03) {
  const z = zc(x) - 0.42 * (1 - 0.15 * smoothstep(-1.15, X_SN, x));
  if (ice(x, z) > 0.005) medial.push([x, z]);
}
const medGeo = ribbon(medial, { width: (t) => 0.05 + 0.05 * t, y: (x, z) => glacier(x, z) + 0.006, color: (t, i) => shade(rgb('#5e564c'), 0.85 + 0.3 * N.rand(i, 9)), normal: gNormal });
medGeo.append(boulders(medial, 16, 90, 0.05, (x, z) => glacier(x, z)));
node('Moraine_Medial', medGeo, M.moraine, root);

// --- meltwater --------------------------------------------------------------------------------
const lakePhi = (x, z) => Math.min(L - terrain(x, z), 1.5 - lakeR2(x, z));
node('Melt_Lake', surface({ x0: LX - LRX - 0.1, x1: LX + LRX + 0.1, z0: LZ - LRZ - 0.1, z1: LZ + LRZ + 0.1, step: 0.02, h: () => L, phi: lakePhi, color: (x, y, z) => mix(C.lake, rgb('#5aa9bd'), smoothstep(0.9, 0.2, lakeR2(x, z))), normal: () => [0, 1, 0] }).geo, M.water, root);
{
  // lake section (z = 0 crosses the lake's back half)
  const pts = line([LX - LRX, CAP_Z], [LX + LRX, CAP_Z], 0.01);
  node(
    'Melt_LakeSection',
    bandWall(pts, (x) => {
      const t = terrain(x, 0);
      const inLake = lakePhi(x, 0) >= 0;
      return [{ top: inLake ? L : t, bottom: t, cTop: rgb('#6fb8c4'), cBottom: rgb('#3f8fa8') }];
    }, [0, 0, 1]),
    M.water,
    root,
  );
}
const streams = new Geo();
const STREAMS = [
  [-0.35, 0.18, 0.55],
  [-0.15, -0.22, 0.75],
  [0.1, 0.32, 0.92],
];
STREAMS.forEach(([xs, off, xe], k) => {
  const pts = [];
  for (let x = xs; x <= xe; x += 0.03) {
    const z = zc(x) + off * W(x) + 0.05 * Math.sin(x * 9 + k * 2);
    if (ice(x, z) > 0.02) pts.push([x, z]);
  }
  if (pts.length > 3) streams.append(ribbon(pts, { width: (t) => 0.014 + 0.016 * t, y: (x, z) => glacier(x, z) + 0.007, color: C.stream, normal: gNormal }));
  // moulin: dark hole where the stream disappears into the ice
  const [ex, ez] = pts[pts.length - 1] ?? [xe, zc(xe)];
  streams.append(blob([ex, glacier(ex, ez) + 0.002, ez], { radii: [0.022, 0.006, 0.022], color: rgb('#1d4766'), detail: 1 }));
});
node('Melt_Streams', streams, M.water, root);
{
  // ice cave (portal) at the snout where the subglacial meltwater leaves
  const x = X_SN - 0.01;
  const z = zc(x);
  node('Melt_Portal', blob([x, L + 0.035, z], { radii: [0.03, 0.05, 0.09], color: rgb('#17384f'), detail: 2 }), M.water, root);
}

// --- river ------------------------------------------------------------------------------------
const riverY = (x, z) => terrain(x, z) + 0.014;
const riverColor = (t) => mix(rgb('#7cc3c8'), C.water, smoothstep(0, 0.5, t));
node('River_Main', ribbon(RIVER, { width: (t) => 0.1 + 0.06 * t, y: riverY, color: riverColor }), M.water, root);
const braidGeo = new Geo();
for (const b of BRAIDS) braidGeo.append(ribbon(b, { width: (t) => 0.05 * Math.sin(Math.PI * clamp(t, 0.08, 0.92)) + 0.02, y: riverY, color: C.water }));
node('River_Braids', braidGeo, M.water, root);

// --- trees (decor): spruce on the lower slopes ---------------------------------------------------
const trees = new Geo();
let planted = 0;
for (let k = 0; k < 900 && planted < 70; k++) {
  const x = lerp(-0.6, X1 - 0.1, N.rand(k, 101));
  const z = lerp(Z0 + 0.1, Z1 - 0.1, N.rand(k, 102));
  const y = terrain(x, z);
  const n = tNormal(x, z);
  if (y < 0.12 || y > 1.15 || n[1] < 0.8) continue;
  if (ice(x, z) > -0.02 || lakeR2(x, z) < 1.6) continue;
  if (RIVERS.some((r) => nearestOnPath(r.path, x, z).d < 0.16)) continue;
  if (Math.abs(z - zc(x)) < W(x) * 0.7 && x < 2.9) continue; // forefield stays bare
  const s = 0.75 + 0.55 * N.rand(k, 103);
  const green = shade(C.spruce, 0.85 + 0.3 * N.rand(k, 104));
  trees.append(tube([[x, y - 0.01, z], [x, y + 0.045 * s, z]], { radius: 0.011 * s, color: C.trunk, segs: 5 }));
  trees.append(cone([x, y + 0.035 * s, z], { radius: 0.07 * s, height: 0.13 * s, color: green, segs: 7 }));
  trees.append(cone([x, y + 0.095 * s, z], { radius: 0.05 * s, height: 0.1 * s, color: shade(green, 1.1), segs: 7 }));
  planted++;
}
node('Trees', trees, M.trees, root);

doc.createScene('Scene').addChild(root);

// --- write ------------------------------------------------------------------------------------
await optimise(doc, { ratio: 1 });
const io = await createIO();
const glb = await io.writeBinary(doc);
const tris = docTriangles(doc);
checkBudget('glaciers.glb', glb.byteLength, tris);
writeFileSync(outPath, glb);

const r2 = (v) => Number(v.toFixed(2));
const p = (x, z, y) => [r2(x), r2(y), r2(z)];
const report = {
  sizeAfter: glb.byteLength,
  trianglesAfter: tris,
  ela: r2(ELA),
  anchors: {
    'geo.glacier': p(-1.5, zc(-1.5), glacier(-1.5, zc(-1.5)) + 0.05),
    'geo.accumulation-zone': p(-2.3, zc(-2.3), glacier(-2.3, zc(-2.3)) + 0.05),
    'geo.ablation-zone': p(0.35, zc(0.35) + 0.15, glacier(0.35, zc(0.35) + 0.15) + 0.05),
    'geo.moraine': p(LX + LRX + 0.07, LZ + 0.25, terrain(LX + LRX + 0.07, LZ + 0.25) + 0.08),
    'geo.meltwater': p(LX, LZ, L + 0.02),
    'geo.river': p(2.9, 0.6, terrain(2.9, 0.6) + 0.03),
  },
  snout: p(X_SN, zc(X_SN), glacier(X_SN, zc(X_SN))),
  nodes: nodeTree(doc),
};
if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, nodes: report.nodes.length }, null, 2));
