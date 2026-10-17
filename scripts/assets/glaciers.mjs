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
 * the bare-ice ablation zone with crevasses, dirt bands and meltwater streams.
 * The debris-covered tongue ends in a turquoise proglacial lake dammed by the
 * young terminal moraine; a braided river crosses the outwash plain past an
 * older, grassed terminal moraine (the glacier's earlier extent). Section view
 * (z > 0 clipped) shows the glacier's long profile: snow → firn layers → ice
 * → basal debris on bedrock.
 *
 * Look: the land and ice surfaces share one top-down colour texture baked
 * here (rock with strata and joints, scree aprons, alpine meadow, spruce
 * forest floor, snow on gentle high ground, crevasse fields, ogives, debris)
 * with ambient occlusion, cavity and soft sun shadow baked in; the meshes are
 * sampled finely and simplified where flat. Walls and sections carry
 * per-vertex strata. Everything is deterministic (seeded noise).
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
  bakeRelief,
  bakeTexture,
  bandWall,
  blob,
  chain,
  clamp,
  contour,
  curtain,
  fieldNormal,
  gltf,
  grid,
  lerp,
  line,
  lightBake,
  makeNoise,
  mix,
  nearestOnPath,
  rgb,
  ribbon,
  sedimentStack,
  shade,
  simplifyGeo,
  smoothstep,
  spline,
  spruce,
  strata,
  surface,
} from './diorama.mjs';

const [outPath, reportPath] = process.argv.slice(2);
if (!outPath) {
  console.error('usage: node glaciers.mjs <out.glb> [report.json]');
  process.exit(2);
}
const T0 = performance.now();
const log = (m) => console.error(`[${((performance.now() - T0) / 1000).toFixed(1)}s] ${m}`);

const N = makeNoise(11);
const X0 = -3.6;
const X1 = 3.6;
const Z0 = -2.0;
const Z1 = 2.0;
const YB = -0.7;
/** Mesh sampling step (before simplification). */
const STEP = 0.02;
/** Texel size of the colour texture (and of the cached height fields). */
const TEX = Number(process.env.DIORAMA_TEX ?? 0.004); // DIORAMA_TEX=0.008 for quick previews
const GRID = { x0: X0, x1: X1, z0: Z0, z1: Z1, step: STEP };
const TGRID = { x0: X0, x1: X1, z0: Z0, z1: Z1, step: TEX };

// --- valley layout ----------------------------------------------------------------------------
/** Valley centre line (z) and half-width; the outwash plain turns towards the camera. */
const zc = (x) => 0.18 * Math.sin(0.6 * x + 0.4) + 0.7 * smoothstep(0.9, 3.6, x);
const W = (x) => 0.9 + 0.45 * smoothstep(0.8, 3.2, x);
/** Valley floor along the valley. */
const F = (x) => 0.1 + 1.75 * clamp(1 - (x - X0) / (X1 - X0)) ** 1.5;
/** Cirque headwall weight (1 at the head). */
const hw = (x) => smoothstep(-2.7, -3.6, x);
const X_SN = 1.0; // snout
/** Summits ease off above `k` (no needle peaks at the block edge). */
const softCap = (h, k = 2.35) => (h < k ? h : k + (1 - Math.exp(-(h - k) * 1.5)) / 1.5);

const NUNATAKS = [
  [-2.05, -0.6, 0.15, 0.55],
  [-1.75, 0.55, 0.12, 0.45],
];
function rawTerrain(x, z) {
  const c = zc(x);
  const d = Math.abs(z - c);
  const w = W(x);
  const back = z < c;
  const floor = F(x) + 0.1 * (Math.min(d, w) / w) ** 2;
  const e = Math.max(0, d - w);
  // back range high, front range low (and lower still at the front edge) so the valley is in view
  const amp = back ? 1.8 : 0.8 * (1 - 0.4 * smoothstep(0.5, 3.6, x)) * (1 - 0.5 * smoothstep(Z1 - 1.0, Z1, z));
  // a steep U-trough side (holds the ice) below the range itself
  const wall = 0.5 * (1 - Math.exp(-e * 2.8)) + amp * (1 - Math.exp(-e * 1.15));
  // spurs and gullies running down the valley sides (truncated where the glacier passed)
  const sp = 1 - Math.abs(N.n2(x * 3.2 + 0.5 * N.fbm(x * 1.1, z * 1.1, 2) * 3, e * 0.9 + (back ? 0 : 40)));
  const spurs = 0.32 * sp * sp * smoothstep(0.04, 0.5, e) * smoothstep(1.9, 0.9, e) * (back ? 1 : 0.6);
  // ridged multifractal on a warped domain: crisp arêtes, smooth cirque floors
  const [wx, wz] = N.warp(x * 0.45 + 3, z * 0.45 - 1, 0.28, 0.9);
  const peaks = 0.5 + 0.85 * N.ridgedMF(wx, wz, 6);
  const head = 0.85 * hw(x) ** 1.4 * (0.62 + 0.55 * N.ridgedMF(x * 0.8 + 1.7, z * 0.8, 5));
  // crags, buttresses and gullies on the mountain sides only (the trough that holds the ice stays smooth)
  // (the trough side gets some too: ice-scoured knobs and ledges, so it reads as rock, not a ramp)
  const m = (0.4 * smoothstep(0.0, 0.1, e) + 0.6 * smoothstep(0.05, 0.45, e)) * clamp(0.35 + wall * 0.6, 0, 1.3);
  const crags = m * (0.17 * N.ridgedMF(x * 1.8 + 11, z * 1.8 - 4, 5) + 0.05 * N.ridgedMF(x * 4.6 - 3, z * 4.6 + 2, 4) + 0.06 * N.eroded(x * 3.4, z * 3.4, 6) - 0.085);
  const rough = 0.022 * N.fbm(x * 2.2, z * 2.2) + 0.04 * smoothstep(0, 0.6, e) * N.fbm(x * 1.3 + 5, z * 1.3);
  // nunataks: rock knobs the accumulation zone flows around
  let knobs = 0;
  for (const [kx, kz, kr, kh] of NUNATAKS) {
    // rock ribs drawn out along the flow, craggy
    const r = Math.hypot((x - kx) / 2.2, z - kz) / kr;
    if (r < 1.8) knobs = Math.max(knobs, kh * Math.exp(-r * r * 1.4) * (0.55 + 0.8 * N.ridgedMF(x * 7 + kx, z * 7, 4)));
  }
  return softCap(floor + wall * peaks + head + rough + crags + spurs + knobs);
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
  if (d > 2.2) return 99;
  const e = Math.max(0, d - W2);
  const head = 0.7 * smoothstep(0.15, 0, sc);
  const m = smoothstep(0.02, 0.4, e);
  const crags = m * (0.15 * N.ridgedMF(x * 1.8 + 11, z * 1.8 - 4, 5) + 0.045 * N.ridgedMF(x * 4.6 - 3, z * 4.6 + 2, 4) + 0.05 * N.eroded(x * 3.4, z * 3.4, 6) - 0.07);
  return softCap(F2(sc) + 0.08 * (Math.min(d, W2) / W2) ** 2 + 0.45 * (1 - Math.exp(-e * 5)) + 1.3 * (1 - Math.exp(-e * 1.8)) * (0.62 + 0.7 * N.ridgedMF(x * 0.6 + 8, z * 0.6, 5)) + head + crags);
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
/** Thin threads between the gravel bars (River_Braids). */
const THREADS = [
  spline([[2.05, 0.3], [2.3, 0.52], [2.55, 0.6], [2.8, 0.58]], 0.03),
  spline([[2.6, 0.44], [2.9, 0.43], [3.2, 0.58], [3.45, 0.66]], 0.03),
  spline([[3.0, 0.7], [3.25, 0.8], [3.5, 0.79], [3.65, 0.82]], 0.03),
  spline([[1.95, 0.45], [2.2, 0.62], [2.5, 0.74], [2.72, 0.7]], 0.03),
  spline([[3.2, 0.92], [3.42, 0.97], [3.62, 0.94]], 0.03),
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
const withBox = (r, pad) => {
  const xs = r.path.map((p) => p[0]);
  const zs = r.path.map((p) => p[1]);
  return { ...r, box: [Math.min(...xs) - pad, Math.max(...xs) + pad, Math.min(...zs) - pad, Math.max(...zs) + pad] };
};
const RIVERS = [
  { path: RIVER, bed: bed(RIVER), half: 0.07 },
  ...BRAIDS.map((p) => ({ path: p, bed: bed(p), half: 0.045 })),
].map((r) => withBox(r, r.half + 0.5));
const inBox = (b, x, z) => x >= b[0] && x <= b[1] && z >= b[2] && z <= b[3];
function terrainFn(x, z) {
  let t = lakeTerrain(x, z);
  for (const r of RIVERS) {
    if (!inBox(r.box, x, z)) continue;
    const { d, i } = nearestOnPath(r.path, x, z);
    if (d > r.half + 0.5) continue;
    const k = Math.min(r.bed.length - 1, Math.round(i));
    t = Math.min(t, r.bed[k] + 0.5 * Math.max(0, d - r.half) ** 1.2);
  }
  return t;
}

// --- glacier surface --------------------------------------------------------------------------
const H0 = (x) => 0.4 * Math.sqrt(clamp((X_SN + 0.1 - x) / 1.5)) * (0.5 + 0.5 * smoothstep(-3.4, -2.4, x));
/** Ogive arc coordinate (down-glacier, arcs convex down-glacier). */
const ogiveS = (x, z) => x + 0.55 * ((z - zc(x)) / (W(x) + 0.2)) ** 2;
function glacierFn(x, z) {
  const d = Math.abs(z - zc(x));
  const w = W(x);
  // gentle swells: ogive waves below the icefall, a hummocky snout
  const swell = 0.006 * Math.sin(ogiveS(x, z) * 30) * smoothstep(-0.9, -0.5, x) * smoothstep(X_SN, X_SN - 0.4, x) + 0.008 * N.fbm(x * 7, z * 7, 3);
  // the snowfield above the icefall: broad drifts
  const drifts = 0.024 * N.fbm(x * 2.6 + 5, z * 2.6, 3) * smoothstep(-0.6, -1.0, x);
  const main = d < w + 0.5 ? F(x) + H0(x) + 0.05 * (Math.min(d, w * 1.3) / w) ** 2 + 0.5 * hw(x) ** 1.3 + swell + drifts : -10;
  const t = tribCoords(x, z);
  if (t.s > 1.05 || t.d > W2 + 0.3) return main;
  const H2 = 0.25 * (0.45 + 0.55 * smoothstep(0, 0.3, t.sc));
  return Math.max(main, F2(t.sc) + 0.012 * N.fbm(x * 3, z * 3, 3) + H2 + 0.04 * (Math.min(t.d, W2) / W2) ** 2 + 0.006 * N.fbm(x * 7, z * 7, 3));
}
/** Rounded tongue: the snout front is at X_SN on the centre line, further back at the margins. */
const snout = (x, z) => X_SN - 0.28 * (Math.abs(z - zc(x)) / W(x)) ** 2 - x;

log('height fields');
const Tg = grid(terrainFn, TGRID);
const terrain = Tg.at;
const Gg = grid((x, z) => (glacierFn(x, z) > -5 ? glacierFn(x, z) : -10), TGRID);
const glacier = Gg.at;
const ice = (x, z) => Math.min(glacier(x, z) - terrain(x, z) - 0.004, snout(x, z));
const ELA = glacierFn(-0.55, zc(-0.55));
const tNormal = (x, z) => Tg.normal(x, z, 0.006);
const gNormal = (x, z) => Gg.normal(x, z, 0.008);
log('height fields done');

// --- trees (placed first: the forest floor darkens the ground under them) ---------------------
/** Spruce stands: clustered on the lower slopes of both ranges and on the old outwash terraces. */
const TREES = [];
{
  const ok = (x, z) => {
    if (x < X0 + 0.05 || x > X1 - 0.05 || z < Z0 + 0.05 || z > Z1 - 0.05) return false;
    const y = terrain(x, z);
    const n = tNormal(x, z);
    if (y < 0.1 || y > 1.25 || n[1] < 0.7) return false;
    if (ice(x, z) > -0.04 || lakeR2(x, z) < 1.8) return false;
    if (RIVERS.some((r) => inBox(r.box, x, z) && nearestOnPath(r.path, x, z).d < 0.12)) return false;
    if (Math.abs(z - zc(x)) < W(x) * 0.72 && x < 2.95) return false; // the forefield stays bare
    return true;
  };
  let clusters = 0;
  for (let k = 0; k < 900 && clusters < 34; k++) {
    const cx = lerp(-0.6, X1 - 0.1, N.rand(k, 101));
    const cz = lerp(Z0 + 0.1, Z1 - 0.1, N.rand(k, 102));
    if (!ok(cx, cz)) continue;
    clusters++;
    const count = 4 + Math.floor(12 * N.rand(k, 103));
    const spread = 0.08 + 0.17 * N.rand(k, 104);
    let placed = 0;
    for (let t = 0; t < count * 4 && placed < count; t++) {
      const a = N.rand(k * 50 + t, 105) * Math.PI * 2;
      const r = spread * Math.sqrt(N.rand(k * 50 + t, 106));
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (!ok(x, z) || TREES.some((p) => Math.hypot(p.x - x, p.z - z) < 0.038)) continue;
      // smaller towards the edge of the stand and higher up
      const y = terrain(x, z);
      const s = (0.7 + 0.6 * N.rand(k * 50 + t, 107)) * (1 - 0.35 * (r / spread)) * (1 - 0.35 * smoothstep(0.7, 1.25, y));
      TREES.push({ x, z, y, s, k: k * 50 + t });
      placed++;
    }
  }
}
const FOREST = (() => {
  const S = 0.01;
  const g = grid(() => 0, { ...GRID, step: S });
  for (const t of TREES) {
    const R = 0.075 * t.s + 0.02;
    for (let j = Math.floor((t.z - R - Z0) / S); j <= Math.ceil((t.z + R - Z0) / S); j++)
      for (let i = Math.floor((t.x - R - X0) / S); i <= Math.ceil((t.x + R - X0) / S); i++) {
        if (i < 0 || j < 0 || i > g.nx || j > g.nz) continue;
        const d = Math.hypot(g.x(i) - t.x, g.z(j) - t.z);
        const k = j * g.W + i;
        g.data[k] = Math.max(g.data[k], clamp(1 - d / R));
      }
  }
  return g;
})();
const forest = FOREST.at;
/** Distance to the nearest river / braid / thread (cached). */
const RIVER_D = grid((x, z) => {
  let d = 9;
  for (const p of [RIVER, ...BRAIDS, ...THREADS]) {
    if (x < 1.4 || z < -0.3) break;
    d = Math.min(d, nearestOnPath(p, x, z).d);
  }
  return d;
}, { ...GRID, step: 0.01 });
log(`trees ${TREES.length}`);

// --- baked light ------------------------------------------------------------------------------
// Sun from the upper right front (as the viewer's key light): shadows fall to the back left.
const SUN = [0.55, 0.75, 0.38];
const top = (x, z) => (ice(x, z) >= 0 ? glacier(x, z) : terrain(x, z));
const relief = bakeRelief(top, { ...GRID, sun: SUN, aoRadius: 0.8 });
log('relief');

// --- colours ----------------------------------------------------------------------------------
const C = {
  rockDark: rgb('#35322f'),
  rock: rgb('#58524c'),
  rockLight: rgb('#878079'),
  rockWarm: rgb('#6d5646'),
  rockRed: rgb('#744f43'),
  lichen: rgb('#5e5f4c'),
  scree: rgb('#857d72'),
  screeLight: rgb('#a8a094'),
  meadowHigh: rgb('#7f8152'),
  meadow: rgb('#557638'),
  meadowLush: rgb('#3e652e'),
  polished: rgb('#9a958d'),
  forestFloor: rgb('#2a3f22'),
  gravel: rgb('#a29c91'),
  gravelWet: rgb('#6e6a62'),
  silt: rgb('#bdb6a6'),
  till: rgb('#8d8273'),
  bedrock: rgb('#5a534d'),
  snow: rgb('#f6f8fb'),
  snowShade: rgb('#c4d6ea'),
  firn: rgb('#e3ebf0'),
  iceWhite: rgb('#dff0f6'),
  iceBlue: rgb('#93cae3'),
  iceDeep: rgb('#5ea7cf'),
  dirt: rgb('#8b867c'),
  dirtDark: rgb('#635c53'),
  debris: rgb('#5f574e'),
  debrisLight: rgb('#8e8579'),
  crevasse: rgb('#0f3a5c'),
  crevasseDeep: rgb('#07203a'),
  moraine: rgb('#7a6f63'),
  moraineOld: rgb('#7b8a52'),
  boulder: rgb('#6f6862'),
  lakeShallow: rgb('#8fdcd2'),
  lakeMid: rgb('#3fbcc4'),
  lakeDeep: rgb('#138aa6'),
  river: rgb('#5fc0c6'),
  riverBank: rgb('#a9dcd6'),
  stream: rgb('#3fb7d6'),
  ela: rgb('#e0583a'),
  spruce: rgb('#24432f'),
  trunk: rgb('#4a3626'),
};

/** Fine and mid-scale convexity of the cached ground (+ crest, − gully). */
const cavityAt = (H, x, z, r) => {
  const h0 = H(x, z);
  let s = 0;
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.3;
    s += H(x + Math.cos(a) * r, z + Math.sin(a) * r);
  }
  return h0 - s / 6;
};

/** Altitude warped by a gentle dip and folds: rock beds follow it. */
const bedY = (x, y, z) => y + 0.036 * x + 0.18 * N.fbm(x * 0.7, z * 0.7, 3) + 0.03 * N.fbm(x * 5, z * 5, 3);
/** Bare rock: banded metasediments and granite, iron-stained patches, joints and lichen. */
function rockColor(x, y, z, n, cf) {
  const lith = N.fbm(x * 0.5 + 9, z * 0.5 - 3, 3);
  // dipping beds: altitude warped by a tilt and folds
  const warpY = bedY(x, y, z);
  const band = 0.5 + 0.5 * Math.sin(warpY * 26);
  const band2 = 0.5 + 0.5 * Math.sin(warpY * 71 + 1.3);
  let c = mix(C.rockDark, C.rock, 0.3 + 0.45 * band + 0.25 * N.fbm(x * 9 + 1, z * 9, 3));
  c = mix(c, C.rockLight, 0.4 * band2 * smoothstep(-0.1, 0.5, N.fbm(x * 2 + 4, z * 2, 3)));
  c = mix(c, C.rockWarm, 0.45 * smoothstep(0.1, 0.55, lith));
  c = mix(c, C.rockRed, 0.4 * smoothstep(0.3, 0.65, N.fbm(x * 0.8 - 5, z * 0.8 + 2, 3)));
  // on cliffs the beds stand out as ledges and recesses
  const steepK = smoothstep(0.75, 0.45, n[1]);
  const ledge = smoothstep(0.55, 0.8, 0.5 + 0.5 * Math.sin(warpY * 26 + 0.6));
  c = shade(c, 1 + steepK * (0.22 * ledge - 0.12));
  // joints and fractures: thin dark lines
  const j = 1 - Math.abs(N.n2(x * 22 + 3 * N.fbm(x * 3, z * 3, 2), z * 22 + y * 9));
  c = shade(c, 1 - 0.35 * smoothstep(0.9, 0.985, j));
  // lichen and weathering on gentle ledges
  c = mix(c, C.lichen, 0.35 * smoothstep(0.55, 0.8, n[1]) * smoothstep(0, 0.5, N.fbm(x * 6, z * 6, 2)));
  // crests catch light, gullies hold grime
  return shade(c, 1 + 2.2 * clamp(cf, -0.12, 0.12));
}

/** The land's albedo at (x, z). */
function groundAlbedo(x, z) {
  const y = terrain(x, z);
  const n = tNormal(x, z);
  const cf = cavityAt(terrain, x, z, 0.012);
  const cm = cavityAt(terrain, x, z, 0.05);
  const steep = smoothstep(0.82, 0.6, n[1]);
  const d = Math.abs(z - zc(x));
  let c = rockColor(x, y, z, n, cf);
  // scree: moderate slopes below the cliffs and concave aprons, streaked downslope
  const gl = Math.hypot(n[0], n[2]) || 1;
  const along = (x * -n[2] + z * n[0]) / gl; // contour direction
  const down = (x * n[0] + z * n[2]) / gl;
  const streak = 0.5 + 0.5 * N.fbm(along * 38, down * 5, 3);
  const scree = smoothstep(0.5, 0.64, n[1]) * smoothstep(0.95, 0.82, n[1]) * smoothstep(0.03, -0.05, cm + 0.04 * N.fbm(x * 3, z * 3, 3)) * smoothstep(-0.2, 0.15, N.fbm(x * 2.2 + 5, z * 2.2, 3) - 4 * cm);
  c = mix(c, shade(mix(C.scree, C.screeLight, streak * 0.7 + 0.3 * N.n2(x * 120, z * 120)), 0.85 + 0.25 * N.fbm(x * 30, z * 30, 2)), 0.8 * scree);
  // trimline: the trough sides the glacier scoured recently stay bare, pale polished rock with striations
  const e = Math.max(0, d - W(x));
  const iceLevel = F(x) + H0(x) + 0.5 * hw(x) ** 1.3;
  const trim = smoothstep(0.2, 0.06, y - iceLevel + 0.06 * N.fbm(x * 3, z * 3, 2)) * smoothstep(0.55, 0.25, e) * smoothstep(X_SN + 0.4, X_SN, x);
  const stri = 0.5 + 0.5 * Math.sin(x * 160 + 6 * N.fbm(x * 2, z * 8, 2));
  c = mix(c, shade(mix(C.polished, C.rock, 0.3 + 0.4 * N.fbm(x * 7, z * 7, 2)), 0.94 + 0.08 * stri), 0.8 * trim * (1 - 0.6 * scree));
  // vegetation: lush below the tree line, olive alpine meadow above, thinning into scree and rock
  const treeLine = 1.3 + 0.12 * N.fbm(x * 1.4, z * 1.4, 3);
  const gentle = smoothstep(0.7, 0.87, n[1]);
  const grass = mix(mix(C.meadowLush, C.meadow, 0.5 + 0.5 * N.fbm(x * 2 + 7, z * 2, 3)), C.meadowHigh, smoothstep(treeLine - 0.3, treeLine + 0.25, y));
  const patch = smoothstep(-0.25, 0.15, N.fbm(x * 5 + 2, z * 5, 3) - 3 * cf);
  const vege = gentle * smoothstep(1.95, 1.6, y + 0.2 * N.fbm(x * 2.5, z * 2.5, 3)) * (1 - 0.6 * scree) * patch * (1 - trim);
  c = mix(c, shade(grass, 0.86 + 0.24 * (0.5 + 0.5 * N.fbm(x * 18, z * 18, 2))), vege);
  c = mix(c, shade(C.forestFloor, 0.9 + 0.2 * N.n2(x * 60, z * 60)), 0.85 * forest(x, z));
  // valley floor: outwash gravel with old braided channels, freshly deglaciated till, silt by the lake
  const floorK = smoothstep(W(x) * 0.95, W(x) * 0.55, d) * smoothstep(X_SN - 0.1, X_SN + 0.25, x);
  if (floorK > 0) {
    const ch = Math.abs(N.fbm(x * 2.6 + 3, (z - zc(x)) * 11, 3));
    // bars: lighter, coarser tops; abandoned channels darker and finer
    let g = mix(C.gravel, C.gravelWet, smoothstep(0.1, 0.0, ch) * 0.85);
    g = mix(g, shade(C.gravel, 1.12), 0.5 * smoothstep(0.25, 0.45, ch));
    g = shade(g, 0.88 + 0.22 * (0.5 + 0.5 * N.n2(x * 140, z * 140)));
    g = mix(g, C.silt, 0.5 * smoothstep(2.4, 1.5, lakeR2(x, z)));
    const rd = RIVER_D.at(x, z);
    g = mix(g, C.gravelWet, 0.7 * smoothstep(0.09, 0.03, rd));
    g = mix(g, mix(C.meadow, C.meadowHigh, 0.5), 0.55 * smoothstep(0.15, 0.45, N.fbm(x * 3 + 1, z * 3, 3)) * smoothstep(0.15, 0.3, rd) * smoothstep(2.2, 3.0, x));
    c = mix(c, g, 0.92 * floorK);
  }
  const tillK = 0.85 * smoothstep(2.75, 2.45, x) * smoothstep(X_SN - 0.3, X_SN, x) * smoothstep(W(x) + 0.5, W(x), d) * smoothstep(1.4, 1.9, lakeR2(x, z));
  c = mix(c, shade(mix(C.till, C.debrisLight, 0.5 + 0.5 * N.fbm(x * 9, z * 9, 2)), 0.8 + 0.3 * (0.5 + 0.5 * N.n2(x * 130, z * 130))), tillK);
  // wet dark ring and pale silt beach at the lake shore
  const lr = lakeR2(x, z);
  c = mix(c, C.gravelWet, smoothstep(1.55, 1.2, lr) * 0.7);
  // snow: gentle high ground, lower on slopes turned from the sun and in hollows; streaks in cliff gullies
  const snowLine = 2.0 + 0.15 * N.fbm(x * 1.7, z * 1.7, 3);
  const away = -(n[0] * SUN[0] + n[2] * SUN[2]);
  const yEff = y + 0.25 * away - 1.4 * cm;
  const snow = Math.max(
    smoothstep(snowLine - 0.1, snowLine + 0.12, yEff) * smoothstep(0.42, 0.62, n[1]),
    smoothstep(snowLine - 0.25, snowLine + 0.2, yEff) * smoothstep(0.0, -0.025, cf) * smoothstep(0.2, 0.4, n[1]) * 0.95,
  );
  c = mix(c, mix(C.snow, C.snowShade, 0.25 * steep), clamp(snow * (0.85 + 0.3 * N.fbm(x * 12, z * 12, 2))));
  // snow lines on cliff ledges high up
  const ledges = steep * smoothstep(snowLine - 0.35, snowLine - 0.05, y) * smoothstep(0.93, 0.99, 0.5 + 0.5 * Math.sin(bedY(x, y, z) * 26 + 0.6 + 0.5 * N.fbm(x * 8, z * 8, 2))) * smoothstep(0.0, 0.35, N.fbm(x * 4 + 7, z * 4, 3));
  c = mix(c, C.snow, 0.85 * ledges);
  return { c, n, cf, cm, snow: Math.max(snow, ledges) };
}

/** Crack field: 1 inside a crevasse, a soft lip around it; q = coordinate across the cracks. */
function cracks(q, along, freq, width, seed) {
  const f = q * freq + 0.6 * N.fbm(along * 3 + seed, q * 2, 2);
  const row = Math.round(f);
  const dd = Math.abs(f - row);
  // each crack is a lens: widest mid-way, broken into separate lengths
  const seg = N.n2(along * 7 + row * 3.7 + seed, row * 1.3);
  const w = width * smoothstep(-0.15, 0.35, seg);
  return { inside: w > 0.005 ? smoothstep(w, w * 0.35, dd) : 0, lip: w > 0.005 ? smoothstep(w * 2.2, w, dd) : 0 };
}

/** The ice's albedo at (x, z): snow above the ELA, blue-white ice below, crevasses, ogives, debris. */
function iceAlbedo(x, z) {
  const g = glacier(x, z);
  const u = (z - zc(x)) / W(x);
  const au = Math.abs(u);
  const tc = tribCoords(x, z);
  const inTrib = tc.d < W2 + 0.05 && tc.s < 1.0 && g - (F(x) + H0(x)) > 0.05;
  const cm = cavityAt(glacier, x, z, 0.05);
  // flow foliation: faint stripes along the flow
  const fol = 0.5 + 0.5 * Math.sin((inTrib ? tc.d * 60 : u * 34) + 2 * N.fbm(x * 1.5, z * 1.5, 2));
  // snow cover above the equilibrium line, patchy just below it
  const snowK = smoothstep(ELA - 0.05, ELA + 0.015, g + 0.035 * N.fbm(x * 6, z * 6, 3));
  // snow: wind-packed, faint drifts and sastrugi, blue in hollows
  const drift = 0.5 + 0.5 * N.fbm(x * 2.2 + 3, z * 2.2, 4);
  const sast = 0.5 + 0.5 * N.fbm(x * 4, z * 30, 2);
  let snow = mix(C.snow, C.snowShade, clamp(0.04 + 0.4 * drift ** 1.5 + 0.08 * sast - 6 * cm + 0.16 * fol ** 3 + 0.9 * (1 - relief.ao(x, z))));
  snow = mix(snow, C.firn, smoothstep(ELA + 0.25, ELA, g) * 0.6);
  // bare ice: white weathering crust, bluer in hollows and towards the snout
  let ic = mix(C.iceWhite, C.iceBlue, clamp(0.42 + 0.55 * N.fbm(x * 4, z * 4, 4) - 6 * cm + 0.2 * fol));
  // ogives (dark dirt bands, convex down-glacier) below the icefall
  const s = ogiveS(x, z);
  const og = smoothstep(0.25, 0.85, 0.5 + 0.5 * Math.sin(s * 30 + 1.2 * N.fbm(x * 2, z * 2, 2)));
  ic = mix(ic, C.dirt, 0.5 * og * smoothstep(-0.7, -0.3, x) * smoothstep(X_SN - 0.1, X_SN - 0.45, x));
  // marginal debris stripes
  ic = mix(ic, mix(C.dirt, C.dirtDark, fol), smoothstep(0.62, 0.95, au) * (0.55 + 0.35 * Math.sin(au * 40)));
  let c = mix(ic, snow, snowK);
  // crevasse fields: transverse (icefall below the confluence, the tongue), marginal (oblique), tributary icefall
  let crev = { inside: 0, lip: 0 };
  const add = (k, r) => {
    crev = { inside: Math.max(crev.inside, k * r.inside), lip: Math.max(crev.lip, k * r.lip) };
  };
  add(smoothstep(-1.2, -1.0, x) * smoothstep(-0.55, -0.75, x) * smoothstep(0.98, 0.8, au), cracks(s, u, 17, 0.09, 1));
  add(smoothstep(0.15, 0.3, x) * smoothstep(0.85, 0.7, x) * smoothstep(0.95, 0.75, au), cracks(s, u, 19, 0.085, 2));
  {
    const side = Math.sign(u) || 1;
    const q = x + side * 0.9 * (z - zc(x));
    add(smoothstep(0.62, 0.78, au) * smoothstep(0.98, 0.9, au) * smoothstep(-0.7, -0.5, x) * smoothstep(X_SN - 0.25, X_SN - 0.45, x), cracks(q, au * 3, 17, 0.08, 3));
  }
  if (inTrib) add(smoothstep(0.55, 0.65, tc.s) * smoothstep(0.92, 0.82, tc.s) * smoothstep(W2, W2 * 0.7, tc.d), cracks(tc.s * 1.5 - tc.d * tc.d, tc.d * 4, 15, 0.09, 4));
  // in snow the cracks read as blue shadows, in ice as deep blue slits
  const crevC = mix(mix(C.crevasse, C.crevasseDeep, 0.5), mix(rgb('#7fb2d8'), C.crevasse, 0.4), snowK);
  c = mix(c, mix(C.iceWhite, C.snow, snowK), 0.3 * crev.lip);
  c = mix(c, crevC, crev.inside);
  // medial moraine: a dark debris band from the confluence down the glacier
  const mz = zc(x) - 0.42 * (1 - 0.15 * smoothstep(-1.15, X_SN, x));
  const mw = 0.035 + 0.04 * smoothstep(-1.15, X_SN, x);
  c = mix(c, shade(C.debris, 0.85 + 0.3 * N.n2(x * 90, z * 90)), smoothstep(mw * 1.6, mw * 0.5, Math.abs(z - mz)) * smoothstep(-1.2, -1.05, x));
  // debris-covered snout
  const cover = smoothstep(X_SN - 0.45, X_SN - 0.1, x + 0.08 * N.fbm(x * 6, z * 6, 3));
  c = mix(c, shade(mix(C.debris, C.debrisLight, 0.5 + 0.5 * N.fbm(x * 14, z * 14, 2)), 0.78 + 0.35 * (0.5 + 0.5 * N.n2(x * 150, z * 150))), 0.92 * cover);
  return { c, snowK, crev: crev.inside, cm };
}

/**
 * Relief detail finer than the mesh: the sun term of the texel normal minus
 * that of the mesh-scale normal (the renderer already shades the big forms).
 */
const LIGHT = (() => {
  const l = Math.hypot(...SUN);
  return SUN.map((v) => v / l);
})();
const detailShade = (Hf, x, z) => {
  const fine = Hf.normal(x, z, TEX * 1.5);
  const coarse = Hf.normal(x, z, 0.035);
  const d = (n) => n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2];
  return clamp(d(fine) - d(coarse), -0.6, 0.6);
};

/** Texel colour: albedo × baked light (ambient occlusion, cavity, cast shadow, fine relief, warm sun / cool shade). */
function texColor(x, z) {
  const onIce = ice(x, z) > -0.006;
  if (onIce) {
    const a = iceAlbedo(x, z);
    const n = gNormal(x, z);
    const c = shade(a.c, 1 + 0.7 * detailShade(Gg, x, z));
    return lightBake(c, { ao: relief.ao(x, z), cavity: 4 * a.cm - 0.6 * a.crev, shadow: relief.shadow(x, z), sunlit: relief.sunlit(n), strength: lerp(0.85, 0.7, a.snowK) });
  }
  const a = groundAlbedo(x, z);
  const c = shade(a.c, 1 + lerp(0.9, 0.6, a.snow) * detailShade(Tg, x, z));
  return lightBake(c, { ao: relief.ao(x, z), cavity: 6 * a.cf + 3 * a.cm, shadow: relief.shadow(x, z), sunlit: relief.sunlit(a.n), strength: lerp(1, 0.75, a.snow) });
}

// --- build ------------------------------------------------------------------------------------
const { doc, material, node, texture } = gltf();
log('texture');
const TEXMAP = await bakeTexture(TGRID, texColor);
log(`texture ${TEXMAP.width}x${TEXMAP.height}`);
const land = texture('Land', TEXMAP.png);
if (process.env.DIORAMA_DUMP) writeFileSync(process.env.DIORAMA_DUMP, TEXMAP.png);
const M = {
  ground: material('ground', { rough: 0.93, texture: land }),
  walls: material('walls', { rough: 0.9 }),
  snow: material('snow', { rough: 0.55, texture: land }),
  ice: material('ice', { rough: 0.24, texture: land, clearcoat: [0.45, 0.2] }),
  iceWalls: material('iceWalls', { rough: 0.2, clearcoat: [0.5, 0.15] }),
  section: material('section', { rough: 0.88 }),
  moraine: material('moraine', { rough: 0.96 }),
  water: material('water', { rough: 0.06, clearcoat: [1, 0.04] }),
  river: material('river', { rough: 0.12, clearcoat: [0.8, 0.08] }),
  line: material('line', { rough: 0.6 }),
  trees: material('trees', { rough: 0.9 }),
};
const root = node('GlacierValley');

// Terrain block: textured surface, strata walls, bottom.
const STRATA = [
  // crystalline basement (granite / gneiss), then folded metasediments
  {
    to: (x, z) => -0.38 + 0.05 * N.fbm(x * 0.8, z * 0.8, 3),
    color: rgb('#4a4541'),
    colorBottom: rgb('#3a3632'),
    shade: (x, y, z) => {
      const h = x + z;
      // granite: speckled grey with pink feldspar, gneissic banding, dark joints
      let c = mix(rgb('#4c4743'), rgb('#6e625c'), 0.5 + 0.5 * N.fbm(h * 2.5, y * 4, 3));
      c = mix(c, rgb('#7a6560'), 0.3 * smoothstep(0.2, 0.6, N.n2(h * 40, y * 40)));
      const j = 1 - Math.abs(N.n2(h * 6 + y * 2, y * 0.7 + 9));
      return shade(c, (1 - 0.3 * smoothstep(0.94, 0.99, j)) * (0.88 + 0.12 * smoothstep(-0.7, -0.4, y)));
    },
  },
  ...sedimentStack(N, {
    from: -0.38,
    to: 2.6,
    count: 22,
    seed: 70,
    fold: 0.09,
    palette: [rgb('#6d645a'), rgb('#857a6c'), rgb('#56504a'), rgb('#7a6d5f'), rgb('#948a7a'), rgb('#625a53'), rgb('#76604f'), rgb('#7d6253'), rgb('#6f6b63'), rgb('#5d5a55')],
  }),
];
const skinColor = (x, z) => shade(groundAlbedo(x, z).c, 0.85);
const wallBands = strata({ base: YB, top: terrain, layers: STRATA, skinColor, skinBottom: () => rgb('#4e4034'), skin: 0.035 });
const WSTEP = 0.04;
log('terrain mesh');
const terrainTop = surface({ ...GRID, h: terrain, normal: tNormal, uv: TEXMAP.uv }).geo;
const terrainTopS = await simplifyGeo(terrainTop, { target: 42000, error: 0.0015 });
log(`terrain ${terrainTop.triangles} → ${terrainTopS.triangles}`);
const walls = new Geo();
// the walls the default view shows get finer rows (laminae, joints); the back and left ones plain beds
walls.append(bandWall(line([X0, Z1], [X1, Z1], WSTEP), wallBands, [0, 0, 1], { dy: 0.065 }));
walls.append(bandWall(line([X1, Z0], [X1, Z1], WSTEP), wallBands, [1, 0, 0], { dy: 0.065 }));
walls.append(bandWall(line([X0, Z0], [X1, Z0], 0.06), wallBands, [0, 0, -1]));
walls.append(bandWall(line([X0, Z0], [X0, Z1], 0.05), wallBands, [-1, 0, 0]));
{
  const g = new Geo();
  const n = [0, -1, 0];
  const c = rgb('#3b3632');
  g.quad(g.v([X0, YB, Z0], n, c), g.v([X1, YB, Z0], n, c), g.v([X1, YB, Z1], n, c), g.v([X0, YB, Z1], n, c), n);
  walls.append(g);
}
node('Terrain', [[terrainTopS, M.ground], [walls, M.walls]], null, root);
node('Terrain_Section', bandWall(line([X0, CAP_Z], [X1, CAP_Z], WSTEP), (x) => wallBands(x, 0), [0, 0, 1], { dy: 0.06 }), M.section, root);

// Glacier: zones (surface), margin cliffs, crevasses, long section.
log('glacier');
const glacierNode = node('Glacier', null, null, root);
const acc = surface({ ...GRID, h: glacier, phi: (x, z) => Math.min(ice(x, z), glacier(x, z) - ELA), normal: gNormal, uv: TEXMAP.uv });
const abl = surface({ ...GRID, h: glacier, phi: (x, z) => Math.min(ice(x, z), ELA - glacier(x, z)), normal: gNormal, uv: TEXMAP.uv });
node('Zone_Accumulation', await simplifyGeo(acc.geo, { target: 9000, error: 0.0006 }), M.snow, root);
node('Zone_Ablation', await simplifyGeo(abl.geo, { target: 5000, error: 0.0006 }), M.ice, root);

const margin = contour({ ...GRID, fn: ice });
const marginGeo = curtain(margin, {
  top: glacier,
  bottom: (x, z) => terrain(x, z) - 0.03,
  phi: ice,
  cTop: (x, z) => (glacier(x, z) > ELA ? C.snow : x > X_SN - 0.4 ? shade(C.debris, 1.05 + 0.3 * N.n2(x * 60, z * 60)) : rgb('#b5e0ee')),
  cBottom: (x, z) => (x > X_SN - 0.4 ? mix(rgb('#2f5f7c'), C.debris, 0.5) : rgb('#3c80ad')),
});
node('Glacier_Margin', marginGeo, M.iceWalls, glacierNode);

// Crevasses: the biggest ones of each field as real slits (dark, deep blue inside, white lips), a bergschrund.
const crev = new Geo();
const crevasse = (pts, w) =>
  crev.append(
    ribbon(pts, {
      width: (t) => w * Math.sin(Math.PI * clamp(t, 0.03, 0.97)) ** 0.6 + 0.003,
      y: (px, pz) => glacier(px, pz) + 0.003,
      color: rgb('#d9eef6'),
      centre: (t) => mix(C.crevasseDeep, rgb('#1d5f8a'), 1 - Math.sin(Math.PI * clamp(t)) ** 1.5),
      normal: gNormal,
    }),
  );
const ROWS = [-1.02, -0.93, -0.84, -0.75, 0.24, 0.34, 0.44, 0.54, 0.64];
ROWS.forEach((xr, r) => {
  for (let k = 0; k < 6; k++) {
    const u = (k + 0.5) / 6 - 0.5 + (N.rand(r, k) - 0.5) * 0.08;
    const x = xr + (N.rand(r, k + 20) - 0.5) * 0.04;
    const z = zc(x) + u * 1.8 * W(x);
    const len = 0.12 + 0.14 * N.rand(r, k + 40);
    if (ice(x, z) < 0.05 || ice(x, z + len / 2) < 0.04 || ice(x, z - len / 2) < 0.04) continue;
    if (Math.abs(z - (zc(x) - 0.42)) < 0.08) continue; // not across the medial moraine
    // arcs follow the ogive curvature; ends bend up-glacier near the margins
    const s0 = ogiveS(x, z);
    const pts = [];
    for (let t = -0.5; t <= 0.5001; t += 0.1) {
      const pz = z + t * len;
      const uu = (pz - zc(x)) / (W(x) + 0.2);
      pts.push([s0 - 0.55 * uu * uu + 0.006 * N.n2(t * 5, r + k), pz]);
    }
    crevasse(spline(pts, 0.012), 0.018 + 0.012 * N.rand(r, k + 80));
  }
});
// marginal crevasses: short, at ~45° pointing up-glacier, along both edges of the tongue
for (let k = 0; k < 26; k++) {
  const x = lerp(-0.5, X_SN - 0.4, N.rand(k, 120));
  const side = k % 2 ? 1 : -1;
  const z = zc(x) + side * W(x) * (0.7 + 0.14 * N.rand(k, 121));
  const len = 0.07 + 0.06 * N.rand(k, 122);
  const p = [x + 0.5 * len * 0.7, z - side * len * 0.7];
  if (ice(x, z) < 0.03 || ice(...p) < 0.03) continue;
  crevasse(spline([[x, z], [(x + p[0]) / 2 + 0.005, (z + p[1]) / 2], p], 0.012), 0.012);
}
{
  // bergschrund: the arc where the glacier pulls away from the headwall
  const pts = [];
  for (let z = -0.55; z <= 0.5; z += 0.03) pts.push([-2.95 + 0.2 * (z / 0.5) ** 2 + 0.02 * N.n2(z * 8, 3), zc(-2.95) + z]);
  const ok = pts.filter(([x, z]) => ice(x, z) > 0.02);
  if (ok.length > 2) crevasse(spline(ok, 0.015), 0.03);
}
node('Glacier_Crevasses', crev, M.ice, glacierNode);

// Long section at z = 0: snow → firn bands → ice (bubbly white to dense blue, foliation, debris bands) → basal debris.
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
  const put = (top, bottom, cTop, cBottom, sh) => bands.push({ top: Math.max(top, bottom), bottom: Math.min(top, bottom), cTop, cBottom, shade: sh });
  put(T + debris, T, rgb('#615a52'), rgb('#4a443e'), (px, py) => shade(mix(rgb('#4a443e'), rgb('#7a7064'), 0.5 + 0.5 * N.n2(px * 90, py * 90)), 0.9 + 0.2 * N.n2(px * 40 + 3, py * 40)));
  const iceTop = G - snowD - firnD;
  put(iceTop, T + debris, rgb('#bfe3f2'), rgb('#2f78ad'), (px, py, pz, f) => {
    // depth below the surface → denser, bluer ice; foliation streaks parallel to the bed; dirty basal layer
    let c = mix(rgb('#2a6fa6'), rgb('#c4e6f3'), smoothstep(0, 1, f) ** 0.8);
    c = shade(c, 1 + 0.07 * Math.sin((py - T) * 140 + 3 * N.fbm(px * 3, py * 3, 2)));
    c = mix(c, rgb('#6e6a62'), 0.35 * smoothstep(0.15, 0.0, f) * (0.6 + 0.4 * N.n2(px * 50, py * 50)));
    return c;
  });
  // firn: four annual layers, alternating, each with a dusty summer surface
  for (let k = 0; k < 4; k++) {
    const t = G - snowD - (firnD * k) / 4;
    const b = G - snowD - (firnD * (k + 1)) / 4;
    const base = k % 2 ? rgb('#d3e1eb') : rgb('#edf3f7');
    put(t, b, base, shade(base, 0.92), (px, py, pz, f) => (f > 0.9 ? mix(base, rgb('#b9b3a6'), 0.45) : shade(base, 0.93 + 0.07 * f)));
  }
  put(G, G - snowD, C.snow, rgb('#e6eef5'));
  return has ? bands : bands.map(() => ({ top: T, bottom: T, cTop: C.snow }));
}
node('Glacier_Section', bandWall(line([X0, CAP_Z], [X_SN + 0.02, CAP_Z], 0.02), (x) => iceBands(x), [0, 0, 1], { dy: 0.05 }), M.section, glacierNode);

// Equilibrium line: dashed red line along glacier = ELA.
const elaLines = chain(contour({ ...GRID, fn: (x, z) => glacierFn(x, z) - ELA, mask: (x, z) => ice(x, z) - 0.01 }));
const elaGeo = new Geo();
for (const l of elaLines) {
  if (l.length < 6) continue;
  elaGeo.append(ribbon(spline(l, 0.02), { width: 0.024, y: (x, z) => glacier(x, z) + 0.008, color: C.ela, centre: shade(C.ela, 1.15), dashes: [3, 2] }));
}
node('EquilibriumLine', elaGeo, M.line, root);

// --- moraines: sharp-crested ridges draped on the ground --------------------------------------
/** Till: unsorted grey-brown debris, lighter stones speckling it; hollows darker. */
const tillColor = (base, x, y, z, n) => {
  let c = mix(base, C.till, 0.3 + 0.3 * N.fbm(x * 9, z * 9, 3));
  c = shade(c, 0.78 + 0.4 * (0.5 + 0.5 * N.n2(x * 70 + y * 20, z * 70)));
  c = mix(c, C.debrisLight, 0.4 * smoothstep(0.55, 0.9, N.n2(x * 45, z * 45 + 7)));
  return c;
};
const litMoraine = (c, x, z, n, crest) =>
  lightBake(c, { ao: relief.ao(x, z) * (0.78 + 0.22 * clamp(n[1] + 0.2)), cavity: crest, shadow: relief.shadow(x, z), sunlit: Math.max(0, n[0] * relief.sun[0] + n[1] * relief.sun[1] + n[2] * relief.sun[2]) });
/**
 * A moraine ridge along `path` (2D): an embankment of till whose crest runs
 * `a` above the ground at the path and whose flanks fall at `slope` (angle of
 * repose) until they meet the land, so it rises out of the valley floor and
 * leans against a valley side instead of draping over it.
 */
function ridge(path, { w, a, slope = 0.85, step = 0.018, color }) {
  const xs = path.map((q) => q[0]);
  const zs = path.map((q) => q[1]);
  const pad = 0.2;
  const box = { x0: Math.min(...xs) - pad, x1: Math.max(...xs) + pad, z0: Math.min(...zs) - pad, z1: Math.max(...zs) + pad, step };
  const crest = path.map(([x, z]) => terrain(x, z));
  const prof = (x, z) => {
    const { d, i, t } = nearestOnPath(path, x, z);
    if (d >= w) return 0;
    const k = Math.min(path.length - 1, Math.round(i));
    const taper = Math.sin(Math.PI * clamp(t, 0.0, 1)) ** 0.5;
    const hum = 0.7 + 0.6 * (0.5 + 0.5 * N.fbm(t * 14 + w * 50, 3.1, 3));
    // slightly rounded crest, straight flanks
    const top = crest[k] + a * taper * hum - slope * (d * d) / (d + 0.012);
    return Math.max(0, (top - terrain(x, z)) * smoothstep(w, w * 0.7, d));
  };
  const h = (x, z) => terrain(x, z) + prof(x, z);
  const nrm = fieldNormal(h, 0.006);
  return surface({
    ...box,
    h,
    phi: (x, z) => prof(x, z) - 0.006,
    normal: nrm,
    color: (x, y, z, n) => {
      const pr = prof(x, z);
      return litMoraine(color(x, y, z, n, pr), x, z, n, 4 * (pr - 0.5 * a));
    },
  }).geo;
}
const boulders = (pts2, count, seed, spread, onY) => {
  const g = new Geo();
  for (let k = 0; k < count; k++) {
    const p = pts2[Math.floor(N.rand(k, seed) * pts2.length)];
    const x = p[0] + (N.rand(k, seed + 1) - 0.5) * spread;
    const z = p[1] + (N.rand(k, seed + 2) - 0.5) * spread;
    const r = 0.008 + 0.02 * N.rand(k, seed + 3) ** 2;
    const c = lightBake(shade(mix(C.boulder, C.rockWarm, N.rand(k, seed + 5) * 0.5), 0.75 + 0.45 * N.rand(k, seed + 4)), { ao: relief.ao(x, z), shadow: relief.shadow(x, z), strength: 0.8 });
    g.append(blob([x, onY(x, z) + r * 0.45, z], { radii: [r * (0.9 + 0.3 * N.rand(k, seed + 6)), r * 0.75, r], color: (d) => shade(c, 0.72 + 0.4 * clamp(d[1] + 0.4)), detail: 0, jitter: (d) => 1 + 0.25 * N.n2(d[0] * 3 + k, d[2] * 3 + d[1]) }));
  }
  return g;
};
const ridgeTop = (path, a) => (x, z) => terrain(x, z) + a * 0.6 * smoothstep(0.06, 0, nearestOnPath(path, x, z).d);

// Terminal moraine: arc in front of the lake with a gap for the outlet.
const arc = (cx, cz, rx, rz, from, to) => {
  const pts = [];
  for (let a = from; a <= to + 1e-9; a += 0.05) pts.push([cx + rx * Math.cos(a), cz + rz * Math.sin(a)]);
  return pts;
};
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
const termL = spline(arc(LX, LZ, LRX + 0.07, LRZ + 0.09, -1.55, -0.22), 0.025);
const termR = spline(arc(LX, LZ, LRX + 0.07, LRZ + 0.09, 0.22, 1.55), 0.025);
// Lateral moraines: along both margins of the ablation zone, joined to the terminal arc ends.
const lateral = (side) => {
  const pts = [];
  for (let x = -0.75; x <= X_SN - 0.05; x += 0.05) {
    const z = marginZ(x, side);
    if (z !== null) pts.push([x, z + side * 0.025]);
  }
  const end = side < 0 ? termL[0] : termR[termR.length - 1];
  return spline([...pts.filter((_, i) => i % 3 === 0), end], 0.025);
};
const latBack = lateral(-1);
const latFront = lateral(1);
log('moraines');
const fresh = (x, y, z, n, pr) => tillColor(C.moraine, x, y, z, n);
const morGeo = (parts) => parts.reduce((g, p) => g.append(p), new Geo());
node('Moraine_Lateral', morGeo([ridge(latBack, { w: 0.16, a: 0.08, color: fresh }), ridge(latFront, { w: 0.16, a: 0.08, color: fresh }), boulders(latBack, 40, 50, 0.12, ridgeTop(latBack, 0.1)), boulders(latFront, 40, 60, 0.12, ridgeTop(latFront, 0.1))]), M.moraine, root);
node('Moraine_Terminal', morGeo([ridge(termL, { w: 0.14, a: 0.085, color: fresh }), ridge(termR, { w: 0.14, a: 0.085, color: fresh }), boulders(termL, 22, 70, 0.08, ridgeTop(termL, 0.085)), boulders(termR, 22, 80, 0.08, ridgeTop(termR, 0.085))]), M.moraine, root);

// Older terminal moraine (the glacier's earlier extent), lower, broader and grassed, cut by the river.
const OX = 2.55;
const oldArc = (from, to) => spline(arc(OX - 0.45, zc(OX), 0.5, W(OX) + 0.05, from, to), 0.03);
const grassed = (x, y, z, n, pr) => {
  const till = tillColor(shade(C.till, 0.95), x, y, z, n);
  const grass = mix(mix(C.meadow, C.moraineOld, 0.5 + 0.5 * N.fbm(x * 6, z * 6, 3)), C.meadowHigh, 0.3 * smoothstep(0.2, 0.6, N.fbm(x * 15, z * 15, 2)));
  return mix(till, shade(grass, 0.85 + 0.25 * (0.5 + 0.5 * N.n2(x * 80, z * 80))), smoothstep(0.55, 0.85, n[1]) * smoothstep(-0.3, 0.1, N.fbm(x * 9, z * 9, 2)));
};
node('Moraine_TerminalOld', morGeo([ridge(oldArc(-1.15, -0.2), { w: 0.2, a: 0.065, slope: 0.45, step: 0.022, color: grassed }), ridge(oldArc(0.18, 1.15), { w: 0.2, a: 0.065, slope: 0.45, step: 0.022, color: grassed })]), M.moraine, root);

// Medial moraine: dark debris band from the confluence down the glacier, an ice-cored ridge with boulders.
const medial = [];
for (let x = -1.15; x <= X_SN - 0.06; x += 0.03) {
  const z = zc(x) - 0.42 * (1 - 0.15 * smoothstep(-1.15, X_SN, x));
  if (ice(x, z) > 0.005) medial.push([x, z]);
}
const medGeo = ribbon(medial, {
  width: (t) => 0.05 + 0.06 * t,
  y: (x, z) => glacier(x, z) + 0.006,
  color: (t) => lightBake(shade(C.debris, 1.08), { ao: 0.9, shadow: 1, strength: 0.5 }),
  centre: (t, i) => lightBake(shade(C.dirtDark, 0.85 + 0.3 * N.rand(i, 91)), { ao: 0.9, shadow: 1, strength: 0.5 }),
  normal: gNormal,
});
medGeo.append(boulders(medial, 36, 90, 0.05, (x, z) => glacier(x, z) + 0.004));
node('Moraine_Medial', medGeo, M.moraine, root);

// --- meltwater --------------------------------------------------------------------------------
log('water');
const lakePhi = (x, z) => Math.min(L - terrain(x, z), 1.5 - lakeR2(x, z));
const lakeGeo = surface({
  x0: LX - LRX - 0.1,
  x1: LX + LRX + 0.1,
  z0: LZ - LRZ - 0.1,
  z1: LZ + LRZ + 0.1,
  step: 0.02,
  h: () => L,
  phi: lakePhi,
  // glacial flour: milky turquoise, paler over the shallow shelf, greyer where the snout calves silt
  color: (x, y, z) => {
    const depth = L - terrain(x, z);
    let c = mix(C.lakeShallow, C.lakeMid, smoothstep(0.004, 0.05, depth));
    c = mix(c, C.lakeDeep, smoothstep(0.05, 0.16, depth));
    c = mix(c, rgb('#a9c8c4'), 0.45 * smoothstep(LX - LRX + 0.15, LX - LRX, x) * (0.6 + 0.4 * N.fbm(x * 9, z * 9, 2)));
    return lightBake(c, { ao: relief.ao(x, z) * 0.5 + 0.5, shadow: relief.shadow(x, z), strength: 0.6 });
  },
  normal: () => [0, 1, 0],
}).geo;
// small icebergs calved from the snout
for (let k = 0; k < 4; k++) {
  const x = LX - LRX * 0.6 + 0.22 * N.rand(k, 140);
  const z = LZ + (N.rand(k, 141) - 0.5) * LRZ * 1.1;
  if (lakePhi(x, z) < 0.02) continue;
  const r = 0.007 + 0.01 * N.rand(k, 142);
  lakeGeo.append(blob([x, L + r * 0.15, z], { radii: [r * 1.3, r * 0.6, r], color: (d) => mix(rgb('#9fd3e6'), C.snow, clamp(d[1] + 0.3)), detail: 1, jitter: (d) => 1 + 0.2 * N.n2(d[0] * 3 + k, d[2] * 3) }));
}
node('Melt_Lake', lakeGeo, M.water, root);
{
  // lake section (z = 0 crosses the lake's back half)
  const pts = line([LX - LRX, CAP_Z], [LX + LRX, CAP_Z], 0.01);
  node(
    'Melt_LakeSection',
    bandWall(pts, (x) => {
      const t = terrain(x, 0);
      const inLake = lakePhi(x, 0) >= 0;
      return [{ top: inLake ? L : t, bottom: t, cTop: rgb('#6fcfcf'), cBottom: rgb('#16708f') }];
    }, [0, 0, 1], { dy: 0.04 }),
    M.water,
    root,
  );
}
const streams = new Geo();
const STREAMS = [
  [-0.35, 0.18, 0.55],
  [-0.15, -0.22, 0.75],
  [0.1, 0.32, 0.92],
  [0.3, -0.05, 0.7],
];
STREAMS.forEach(([xs, off, xe], k) => {
  const pts = [];
  for (let x = xs; x <= xe; x += 0.02) {
    // supraglacial streams meander tightly
    const z = zc(x) + off * W(x) + 0.04 * Math.sin(x * 14 + k * 2) + 0.015 * Math.sin(x * 37 + k);
    if (ice(x, z) > 0.02) pts.push([x, z]);
  }
  if (pts.length > 3) streams.append(ribbon(pts, { width: (t) => 0.012 + 0.016 * t, y: (x, z) => glacier(x, z) + 0.006, color: rgb('#a8e3ee'), centre: (t) => mix(C.stream, rgb('#1f8fc0'), t), normal: gNormal }));
  // moulin: dark hole where the stream disappears into the ice
  const [ex, ez] = pts[pts.length - 1] ?? [xe, zc(xe)];
  streams.append(blob([ex, glacier(ex, ez) + 0.002, ez], { radii: [0.022, 0.005, 0.022], color: rgb('#082a44'), detail: 1 }));
});
node('Melt_Streams', streams, M.water, root);
{
  // ice cave (portal) at the snout where the subglacial meltwater leaves
  const x = X_SN - 0.01;
  const z = zc(x);
  node('Melt_Portal', blob([x, L + 0.035, z], { radii: [0.03, 0.05, 0.09], color: (d) => mix(rgb('#0b2a40'), rgb('#3f8fb8'), clamp(d[1] * 0.8 + 0.3)), detail: 2 }), M.water, root);
}

// --- river ------------------------------------------------------------------------------------
const riverY = (x, z) => terrain(x, z) + 0.012;
// glacial flour: milky turquoise at the lake outlet, a little clearer downstream; pale shallows at the banks
const riverColor = (t, i = 0) => shade(mix(rgb('#7fcfcc'), C.river, smoothstep(0, 0.6, t)), 0.95 + 0.1 * N.rand(i, 77));
const bank = (t) => mix(C.riverBank, rgb('#93cfd2'), t);
node('River_Main', ribbon(RIVER, { width: (t) => 0.09 + 0.06 * t + 0.015 * N.fbm(t * 12, 1, 2), y: riverY, color: bank, centre: riverColor }), M.river, root);
const braidGeo = new Geo();
for (const b of BRAIDS) braidGeo.append(ribbon(b, { width: (t) => 0.05 * Math.sin(Math.PI * clamp(t, 0.08, 0.92)) + 0.016, y: riverY, color: bank(0.5), centre: (t, i) => riverColor(0.7, i) }));
THREADS.forEach((pts, k) =>
  braidGeo.append(ribbon(pts, { width: (t) => 0.024 * Math.sin(Math.PI * clamp(t, 0.06, 0.94)) + 0.006, y: (x, z) => Math.max(riverY(x, z) - 0.004, terrain(x, z) + 0.005), color: bank(0.7), centre: (t, i) => riverColor(0.8 + 0.05 * k, i) })),
);
node('River_Braids', braidGeo, M.river, root);

// --- trees (decor): Tien Shan spruce stands on the lower slopes -----------------------------------
const trees = new Geo();
for (const t of TREES) {
  const tint = mix(C.spruce, rgb('#2f5640'), N.rand(t.k, 108));
  const c = lightBake(shade(tint, 0.8 + 0.35 * N.rand(t.k, 104)), { ao: relief.ao(t.x, t.z), shadow: relief.shadow(t.x, t.z), strength: 0.7 });
  const h = 0.2 * t.s * (0.85 + 0.3 * N.rand(t.k, 110));
  trees.append(
    spruce([t.x, t.y, t.z], {
      height: h,
      radius: h * (0.17 + 0.05 * N.rand(t.k, 111)),
      color: c,
      trunk: C.trunk,
      tiers: 6,
      segs: 6,
      phase: N.rand(t.k, 109) * 6,
      rand: (q) => N.rand(t.k, 300 + q),
      lean: [(N.rand(t.k, 112) - 0.5) * 0.08, (N.rand(t.k, 113) - 0.5) * 0.08],
    }),
  );
}
node('Trees', trees, M.trees, root);

doc.createScene('Scene').addChild(root);

// --- write ------------------------------------------------------------------------------------
log('optimise');
await optimise(doc, { ratio: 1, maxTexture: 2048, webpQuality: 86 });
const io = await createIO();
const glb = await io.writeBinary(doc);
const tris = docTriangles(doc);
console.error(nodeTree(doc).join('\n'), glb.byteLength, tris);
checkBudget('glaciers.glb', glb.byteLength, tris);
writeFileSync(outPath, glb);

const r2 = (v) => Number(v.toFixed(2));
const p = (x, z, y) => [r2(x), r2(y), r2(z)];
const report = {
  sizeAfter: glb.byteLength,
  trianglesAfter: tris,
  textures: 1,
  texture: `${TEXMAP.width}x${TEXMAP.height}`,
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
log('done');
