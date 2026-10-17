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
 * down to a large mountain lake. Layered cumulus clouds form above the lake
 * and over the ranges, rain and snow fall from them, the Sun stands over the
 * back right and the sky (the atmosphere) is the backdrop. Arrows show
 * evaporation, transpiration, the transport of vapour, and — in the section
 * view (z > 0 clipped) — infiltration down to the aquifer and groundwater
 * flow into the lake. The front face of the block shows the strata with the
 * aquifer band.
 *
 * Look: the land and glacier surfaces share one top-down colour texture
 * baked here (rock with strata, scree, alpine meadow, a spruce belt, dry
 * steppe and irrigated green by the water, sandy shore, snow on gentle high
 * ground, glacier snow and ice) with ambient occlusion, cavity and soft sun
 * shadow baked in; meshes are sampled finely and simplified where flat.
 * Walls and sections carry per-vertex strata. Deterministic (seeded noise).
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
  bakeRelief,
  bakeTexture,
  bandWall,
  blob,
  clamp,
  contour,
  curtain,
  gltf,
  grid,
  lerp,
  lightBake,
  line,
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
  tube,
} from './diorama.mjs';

const [outPath, reportPath] = process.argv.slice(2);
if (!outPath) {
  console.error('usage: node water-cycle.mjs <out.glb> [report.json]');
  process.exit(2);
}
const T0 = performance.now();
const log = (m) => console.error(`[${((performance.now() - T0) / 1000).toFixed(1)}s] ${m}`);

const N = makeNoise(23);
const X0 = -3.6;
const X1 = 3.6;
const Z0 = -2.2;
const Z1 = 2.2;
const YB = -1.1;
/** Mesh sampling step (before simplification). */
const STEP = 0.025;
/** Texel size of the colour texture (and of the cached height fields). */
const TEX = Number(process.env.DIORAMA_TEX ?? 0.004); // DIORAMA_TEX=0.008 for quick previews
const GRID = { x0: X0, x1: X1, z0: Z0, z1: Z1, step: STEP };
const TGRID = { x0: X0, x1: X1, z0: Z0, z1: Z1, step: TEX };
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
/** Summits ease off above `k`. */
const softCap = (h, k = 2.55) => (h < k ? h : k + (1 - Math.exp(-(h - k) * 1.5)) / 1.5);

function rawTerrain(x, z) {
  // a high massif around each glacier, so its valley is cut into high ground
  let massif = 0;
  for (const g of GLACIERS) {
    const { sc, d } = segCoords(g.a, g.b, x, z);
    massif += 0.55 * Math.exp(-((d / 0.8) ** 2)) * (0.55 + 0.45 * (1 - sc));
  }
  const back = 2.2 * smoothstep(-0.45, -1.6, z) * (1 - 0.3 * smoothstep(-1.75, -2.2, z));
  const left = 1.6 * smoothstep(-1.3, -3.4, x) * (1 - 0.45 * smoothstep(0.4, 2.2, z));
  // ridged multifractal on a warped domain: arêtes, horns and cirques
  const [wx, wz] = N.warp(x * 0.5 + 2, z * 0.5 + 1, 0.3, 0.9);
  const peaks = 0.45 + 0.8 * N.ridgedMF(wx, wz, 6);
  const mt = Math.max(back, left);
  const range = mt * peaks + 0.18 * Math.min(back, left);
  // spurs and gullies running down the range front (towards the lake)
  const sp = 1 - Math.abs(N.n2(x * 2.4 + 1.5 * N.fbm(x * 0.9, z * 0.9, 2), z * 0.7 + 20));
  const spurs = 0.3 * sp * sp * smoothstep(0.2, 1.0, mt) * smoothstep(2.4, 1.2, mt + 0.4);
  // crags and rock steps on the mountain sides
  const m = smoothstep(0.25, 1.1, mt + massif);
  const crags = m * (0.15 * N.ridgedMF(x * 1.8 + 11, z * 1.8 - 4, 5) + 0.05 * N.ridgedMF(x * 4.6 - 3, z * 4.6 + 2, 4) + 0.06 * N.eroded(x * 3.4, z * 3.4, 6) - 0.08);
  // rolling foothills and moraine hummocks on the left shore
  const hills = 0.28 * smoothstep(-0.2, -2.4, x) * smoothstep(0.6, 1.8, z) * (0.5 + 0.5 * N.fbm(x * 1.2, z * 1.2)) + 0.05 * smoothstep(0.6, 0.2, mt) * N.eroded(x * 2.2 + 4, z * 2.2, 5);
  const bowl = 0.63 * smoothstep(1.3, 0.55, lakeE(x, z));
  return Math.max(softCap(0.15 + range + massif + hills + spurs + crags + 0.04 * N.fbm(x * 2, z * 2) - bowl), AQ_TOP + SKIN + 0.03);
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
    w,
    coords,
    terrain(x, z) {
      const { sc, d } = coords(x, z);
      const e = Math.max(0, d - w);
      return floor(sc) + 0.08 * (Math.min(d, w) / w) ** 2 + 0.45 * (1 - Math.exp(-e * 4)) + 1.1 * (1 - Math.exp(-e * 1.5)) * (0.6 + 0.6 * N.ridgedMF(x * 0.7 + 4, z * 0.7, 5)) + 0.5 * smoothstep(0.12, 0, sc);
    },
    ice(x, z, T) {
      const { s, sc, d } = coords(x, z);
      const g = floor(sc) + h * Math.sqrt(clamp((1.02 - s) / 0.45)) * (0.5 + 0.5 * smoothstep(0, 0.25, s)) + 0.04 * (Math.min(d, w) / w) ** 2 + 0.008 * N.fbm(x * 6, z * 6, 3);
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
const withBox = (r, pad) => {
  const xs = r.path.map((p) => p[0]);
  const zs = r.path.map((p) => p[1]);
  return { ...r, box: [Math.min(...xs) - pad, Math.max(...xs) + pad, Math.min(...zs) - pad, Math.max(...zs) + pad] };
};
const RIVERS = [
  { path: RIVER_1, bed: bed(RIVER_1), half: 0.06 },
  { path: RIVER_2, bed: bed(RIVER_2), half: 0.05 },
].map((r) => withBox(r, 1.2));
const inBox = (b, x, z) => x >= b[0] && x <= b[1] && z >= b[2] && z <= b[3];
function terrainFn(x, z) {
  let t = valleyTerrain(x, z);
  for (const r of RIVERS) {
    if (!inBox(r.box, x, z)) continue;
    const { d, i } = nearestOnPath(r.path, x, z);
    // only downstream of the source: no pit behind it (under the glacier)
    if (d > 1.2 || i < 0.5) continue;
    const k = Math.min(r.bed.length - 1, Math.round(i));
    t = Math.min(t, r.bed[k] + 0.85 * Math.max(0, d - r.half) ** 1.2);
  }
  return Math.max(t, AQ_TOP + SKIN + 0.03);
}

log('height fields');
const Tg = grid(terrainFn, TGRID);
const terrain = Tg.at;
const tNormal = (x, z) => Tg.normal(x, z, 0.008);
// glacier surfaces and masks (cached: the texture asks for them per texel)
const iceOf = (gl) => (x, z) => gl.ice(x, z, terrain(x, z));
const glacierGrids = [GL1, GL2].map((gl) => {
  const box = (() => {
    const [ax, az] = gl.a;
    const [bx, bz] = gl.b;
    return { x0: Math.max(X0, Math.min(ax, bx) - 0.7), x1: Math.min(X1, Math.max(ax, bx) + 0.7), z0: Math.max(Z0, Math.min(az, bz) - 0.7), z1: Math.min(Z1, Math.max(az, bz) + 0.7) };
  })();
  const f = iceOf(gl);
  const G = grid((x, z) => f(x, z).g, { ...box, step: TEX });
  // the glacier stays inside the block
  const P = grid((x, z) => Math.min(f(x, z).phi, x - X0 - 0.02, X1 - x - 0.02, z - Z0 - 0.02), { ...box, step: TEX });
  const inside = (x, z) => x >= box.x0 && x <= box.x1 && z >= box.z0 && z <= box.z1;
  return { gl, box, h: G.at, phi: (x, z) => (inside(x, z) ? P.at(x, z) : -1), normal: (x, z) => G.normal(x, z, 0.01), G };
});
log('height fields done');

// --- trees (placed first: the forest floor darkens the ground under them) ---------------------
const TREES = [];
{
  const riverD = (x, z) => Math.min(...RIVERS.map((r) => (inBox(r.box, x, z) ? nearestOnPath(r.path, x, z).d : 9)));
  const free = (x, z, r) => !TREES.some((p) => Math.hypot(p.x - x, p.z - z) < r);
  const onIce = (x, z) => glacierGrids.some((g) => g.phi(x, z) > -0.05);
  // spruce belt: clustered stands on the range fronts
  let clusters = 0;
  for (let k = 0; k < 1500 && clusters < 30; k++) {
    const cx = lerp(X0 + 0.1, X1 - 0.1, N.rand(k, 101));
    const cz = lerp(Z0 + 0.1, Z1 - 0.1, N.rand(k, 102));
    const y = terrain(cx, cz);
    if (y < 0.5 || y > 1.35 || tNormal(cx, cz)[1] < 0.66 || onIce(cx, cz) || lakeE(cx, cz) < 1.15) continue;
    clusters++;
    const count = 4 + Math.floor(9 * N.rand(k, 103));
    const spread = 0.1 + 0.15 * N.rand(k, 104);
    let placed = 0;
    for (let t = 0; t < count * 4 && placed < count; t++) {
      const a = N.rand(k * 50 + t, 105) * Math.PI * 2;
      const r = spread * Math.sqrt(N.rand(k * 50 + t, 106));
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (x < X0 + 0.05 || x > X1 - 0.05 || z < Z0 + 0.05 || z > Z1 - 0.05) continue;
      const yy = terrain(x, z);
      if (yy < 0.42 || yy > 1.45 || tNormal(x, z)[1] < 0.62 || onIce(x, z) || riverD(x, z) < 0.09 || !free(x, z, 0.045)) continue;
      TREES.push({ kind: 'spruce', x, z, y: yy, s: (0.75 + 0.5 * N.rand(k * 50 + t, 107)) * (1 - 0.3 * (r / spread)), k: k * 50 + t });
      placed++;
    }
  }
  // poplars and willows along the rivers and the shore (irrigated green)
  for (let k = 0; k < 2600 && TREES.length < 260; k++) {
    const x = lerp(X0 + 0.1, X1 - 0.1, N.rand(k, 201));
    const z = lerp(Z0 + 0.1, Z1 - 0.1, N.rand(k, 202));
    const y = terrain(x, z);
    if (y < 0.03 || y > 0.55 || tNormal(x, z)[1] < 0.8 || lakeE(x, z) < 1.13) continue;
    const dr = riverD(x, z);
    const near = dr < 0.35 || lakeE(x, z) < 1.45;
    if (!near || dr < 0.08 || !free(x, z, 0.05)) continue;
    TREES.push({ kind: N.rand(k, 203) < 0.55 ? 'poplar' : 'leafy', x, z, y, s: 0.75 + 0.5 * N.rand(k, 204), k });
  }
}
const FOREST = (() => {
  const S = 0.01;
  const g = grid(() => 0, { ...GRID, step: S });
  for (const t of TREES) {
    const R = (t.kind === 'spruce' ? 0.08 : 0.06) * t.s + 0.02;
    for (let j = Math.floor((t.z - R - Z0) / S); j <= Math.ceil((t.z + R - Z0) / S); j++)
      for (let i = Math.floor((t.x - R - X0) / S); i <= Math.ceil((t.x + R - X0) / S); i++) {
        if (i < 0 || j < 0 || i > g.nx || j > g.nz) continue;
        const k = j * g.W + i;
        g.data[k] = Math.max(g.data[k], clamp(1 - Math.hypot(g.x(i) - t.x, g.z(j) - t.z) / R));
      }
  }
  return g;
})();
const RIVER_D = grid((x, z) => Math.min(...RIVERS.map((r) => (inBox(r.box, x, z) ? nearestOnPath(r.path, x, z).d : 9))), { ...GRID, step: 0.01 });
log(`trees ${TREES.length}`);

// --- baked light ------------------------------------------------------------------------------
// The Sun stands over the back right; light from the upper right front like the viewer's key light.
const SUN = [0.55, 0.75, 0.3];
const iceAt = (x, z) => {
  for (const g of glacierGrids) if (g.phi(x, z) >= 0) return g;
  return null;
};
const top = (x, z) => {
  const g = iceAt(x, z);
  return g ? g.h(x, z) : Math.max(terrain(x, z), lakeE(x, z) < 1.4 ? 0 : -9);
};
const relief = bakeRelief(top, { ...GRID, step: 0.02, sun: SUN, aoRadius: 0.8 });
const LIGHT = (() => {
  const l = Math.hypot(...SUN);
  return SUN.map((v) => v / l);
})();
log('relief');

// --- colours ----------------------------------------------------------------------------------
const C = {
  rockDark: rgb('#37332f'),
  rock: rgb('#5d554d'),
  rockLight: rgb('#8a8279'),
  rockWarm: rgb('#71594a'),
  rockRed: rgb('#7a5446'),
  lichen: rgb('#5f604b'),
  scree: rgb('#8a8276'),
  screeLight: rgb('#aba396'),
  meadowHigh: rgb('#828552'),
  meadow: rgb('#5b7b3a'),
  meadowLush: rgb('#46702f'),
  steppe: rgb('#868659'),
  steppeDry: rgb('#a0956b'),
  shrub: rgb('#4f5a35'),
  soil: rgb('#7a6a54'),
  field: rgb('#64893a'),
  forestFloor: rgb('#2a3f22'),
  sand: rgb('#c4b896'),
  sandWet: rgb('#9c9178'),
  snow: rgb('#f6f8fb'),
  snowShade: rgb('#c2d4e8'),
  iceWhite: rgb('#dff0f6'),
  iceBlue: rgb('#93cae3'),
  crevasse: rgb('#0f3a5c'),
  dirt: rgb('#7d776e'),
  river: rgb('#4aa7cf'),
  riverMilky: rgb('#86cbd0'),
  lakeShallow: rgb('#6fd0cf'),
  lakeMid: rgb('#2aa0c4'),
  lakeDeep: rgb('#155fa6'),
  spruce: rgb('#24432f'),
  poplar: rgb('#355c28'),
  leaf: rgb('#4b7230'),
  trunk: rgb('#4f3a2a'),
};

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
const bedY = (x, y, z) => y + 0.04 * x + 0.18 * N.fbm(x * 0.7, z * 0.7, 3) + 0.03 * N.fbm(x * 5, z * 5, 3);
function rockColor(x, y, z, n, cf) {
  const lith = N.fbm(x * 0.5 + 9, z * 0.5 - 3, 3);
  const warpY = bedY(x, y, z);
  const band = 0.5 + 0.5 * Math.sin(warpY * 24);
  const band2 = 0.5 + 0.5 * Math.sin(warpY * 67 + 1.3);
  let c = mix(C.rockDark, C.rock, 0.3 + 0.45 * band + 0.25 * N.fbm(x * 9 + 1, z * 9, 3));
  c = mix(c, C.rockLight, 0.4 * band2 * smoothstep(-0.1, 0.5, N.fbm(x * 2 + 4, z * 2, 3)));
  c = mix(c, C.rockWarm, 0.45 * smoothstep(0.1, 0.55, lith));
  c = mix(c, C.rockRed, 0.4 * smoothstep(0.3, 0.65, N.fbm(x * 0.8 - 5, z * 0.8 + 2, 3)));
  // on cliffs the beds stand out as ledges and recesses
  const steepK = smoothstep(0.75, 0.45, n[1]);
  c = shade(c, 1 + steepK * (0.22 * smoothstep(0.55, 0.8, 0.5 + 0.5 * Math.sin(warpY * 24 + 0.6)) - 0.12));
  const j = 1 - Math.abs(N.n2(x * 22 + 3 * N.fbm(x * 3, z * 3, 2), z * 22 + y * 9));
  c = shade(c, 1 - 0.35 * smoothstep(0.9, 0.985, j));
  c = mix(c, C.lichen, 0.35 * smoothstep(0.55, 0.8, n[1]) * smoothstep(0, 0.5, N.fbm(x * 6, z * 6, 2)));
  return shade(c, 1 + 2.2 * clamp(cf, -0.12, 0.12));
}

/** The land's albedo at (x, z). */
function groundAlbedo(x, z) {
  const y = terrain(x, z);
  const n = tNormal(x, z);
  const cf = cavityAt(terrain, x, z, 0.012);
  const cm = cavityAt(terrain, x, z, 0.05);
  const steep = smoothstep(0.82, 0.6, n[1]);
  let c = rockColor(x, y, z, n, cf);
  // scree aprons below the cliffs, streaked downslope
  const gl = Math.hypot(n[0], n[2]) || 1;
  const along = (x * -n[2] + z * n[0]) / gl;
  const down = (x * n[0] + z * n[2]) / gl;
  const streak = 0.5 + 0.5 * N.fbm(along * 38, down * 5, 3);
  const scree = smoothstep(0.5, 0.64, n[1]) * smoothstep(0.95, 0.82, n[1]) * smoothstep(0.03, -0.05, cm + 0.04 * N.fbm(x * 3, z * 3, 3)) * smoothstep(-0.2, 0.15, N.fbm(x * 2.2 + 5, z * 2.2, 3) - 4 * cm) * smoothstep(0.5, 0.9, y);
  c = mix(c, shade(mix(C.scree, C.screeLight, streak * 0.7 + 0.3 * N.n2(x * 120, z * 120)), 0.85 + 0.25 * N.fbm(x * 30, z * 30, 2)), 0.8 * scree);
  // low gentle ground is soil, not rock
  c = mix(c, shade(C.soil, 0.85 + 0.3 * (0.5 + 0.5 * N.fbm(x * 9, z * 9, 2))), smoothstep(0.8, 0.45, y) * smoothstep(0.55, 0.75, n[1]));
  // vegetation by altitude: dry steppe low down, meadow and the spruce belt above, olive alpine meadow higher
  const gentle = smoothstep(0.66, 0.86, n[1]);
  const patch = lerp(0.9 + 0.1 * smoothstep(-0.3, 0.2, N.fbm(x * 7, z * 7, 2)), smoothstep(-0.25, 0.15, N.fbm(x * 5 + 2, z * 5, 3) - 3 * cf), smoothstep(0.6, 1.0, y));
  const lowK = smoothstep(0.75, 0.35, y + 0.15 * N.fbm(x * 1.5, z * 1.5, 2));
  let grass = mix(mix(C.meadowLush, C.meadow, 0.5 + 0.5 * N.fbm(x * 2 + 7, z * 2, 3)), C.meadowHigh, smoothstep(1.3, 1.75, y));
  // steppe: tussocks and shrubs mottle it, drier on the convex rises, greener in the swales
  let steppe = mix(C.steppe, C.steppeDry, clamp(0.5 + 0.6 * N.fbm(x * 3, z * 3, 3) + 8 * cm));
  steppe = shade(steppe, 0.88 + 0.2 * (0.5 + 0.5 * N.n2(x * 150, z * 150)));
  steppe = mix(steppe, C.shrub, 0.75 * smoothstep(0.72, 0.9, 0.5 + 0.5 * N.n2(x * 55 + 3, z * 55)) * smoothstep(-0.2, 0.3, N.fbm(x * 2 + 9, z * 2, 2)));
  steppe = mix(steppe, C.meadow, 0.45 * smoothstep(0.0, -0.03, cm));
  grass = mix(grass, steppe, lowK);
  // irrigated green by the rivers and the shore (fields and orchards)
  const wet = smoothstep(0.4, 0.1, RIVER_D.at(x, z)) + smoothstep(1.45, 1.15, lakeE(x, z));
  grass = mix(grass, mix(C.field, C.meadowLush, 0.5 + 0.5 * N.fbm(x * 8, z * 8, 2)), clamp(wet) * lowK * 0.85);
  const vege = gentle * smoothstep(2.0, 1.65, y + 0.2 * N.fbm(x * 2.5, z * 2.5, 3)) * (1 - 0.6 * scree) * patch;
  c = mix(c, shade(grass, 0.86 + 0.24 * (0.5 + 0.5 * N.fbm(x * 18, z * 18, 2))), vege);
  c = mix(c, shade(C.forestFloor, 0.9 + 0.2 * N.n2(x * 60, z * 60)), 0.85 * FOREST.at(x, z));
  // sandy shore with a wet band at the water line, gravel bars along the rivers
  const le = lakeE(x, z);
  c = mix(c, mix(C.sand, C.sandWet, smoothstep(1.06, 1.0, le)), smoothstep(1.15, 1.05, le + 0.04 * N.fbm(x * 6, z * 6, 2)) * smoothstep(0.15, 0.0, y));
  c = mix(c, shade(mix(C.sand, C.dirt, 0.5), 0.9 + 0.2 * N.n2(x * 100, z * 100)), smoothstep(0.1, 0.05, RIVER_D.at(x, z)));
  // snow: gentle high ground, lower on slopes turned from the sun and in hollows; streaks in cliff gullies
  const snowLine = 2.0 + 0.15 * N.fbm(x * 1.7, z * 1.7, 3);
  const away = -(n[0] * SUN[0] + n[2] * SUN[2]);
  const yEff = y + 0.25 * away - 1.4 * cm;
  const snow = Math.max(
    smoothstep(snowLine - 0.1, snowLine + 0.12, yEff) * smoothstep(0.42, 0.62, n[1]),
    smoothstep(snowLine - 0.25, snowLine + 0.2, yEff) * smoothstep(0.0, -0.025, cf) * smoothstep(0.2, 0.4, n[1]) * 0.95,
  );
  c = mix(c, mix(C.snow, C.snowShade, 0.25 * steep + 0.6 * (1 - relief.ao(x, z))), clamp(snow * (0.85 + 0.3 * N.fbm(x * 12, z * 12, 2))));
  // snow lines on cliff ledges high up
  const ledges = steep * smoothstep(snowLine - 0.35, snowLine - 0.05, y) * smoothstep(0.93, 0.99, 0.5 + 0.5 * Math.sin(bedY(x, y, z) * 24 + 0.6 + 0.5 * N.fbm(x * 8, z * 8, 2))) * smoothstep(0.0, 0.35, N.fbm(x * 4 + 7, z * 4, 3));
  c = mix(c, C.snow, 0.85 * ledges);
  return { c, n, cf, cm, snow: Math.max(snow, ledges) };
}

/** Glacier albedo: snow in the upper part, blue-white ice with dirt bands and crevasses in the lower. */
function iceAlbedo(g, x, z) {
  const { s, d } = g.gl.coords(x, z);
  const u = d / g.gl.w;
  const cm = cavityAt(g.h, x, z, 0.04);
  const snowK = smoothstep(0.62, 0.52, s + 0.05 * N.fbm(x * 6, z * 6, 3));
  const drift = 0.5 + 0.5 * N.fbm(x * 2.5 + 3, z * 2.5, 4);
  const snow = mix(C.snow, C.snowShade, clamp(0.05 + 0.35 * drift ** 1.5 - 6 * cm + 0.9 * (1 - relief.ao(x, z))));
  let ic = mix(C.iceWhite, C.iceBlue, clamp(0.4 + 0.55 * N.fbm(x * 5, z * 5, 4) - 6 * cm));
  // ogive dirt bands and marginal debris
  ic = mix(ic, C.dirt, 0.4 * smoothstep(0.3, 0.9, 0.5 + 0.5 * Math.sin((s + 0.25 * u * u) * 46 + N.fbm(x * 3, z * 3, 2))));
  ic = mix(ic, mix(C.dirt, C.rockDark, 0.4), smoothstep(0.65, 0.98, u) * 0.8);
  let c = mix(ic, snow, snowK);
  // lateral moraine debris along the edges, the snout dirty
  c = mix(c, shade(mix(C.dirt, C.rockDark, 0.3), 0.85 + 0.3 * N.n2(x * 90, z * 90)), smoothstep(0.82, 1.05, u + 0.1 * N.fbm(x * 9, z * 9, 2)) * 0.85 + smoothstep(0.85, 1.0, s) * 0.6);
  // transverse crevasses across the steepening lower glacier
  const q = (s + 0.25 * u * u) * 26 + 0.5 * N.fbm(u * 3, s * 5, 2);
  const row = Math.round(q);
  const w = 0.09 * smoothstep(-0.1, 0.35, N.n2(u * 6 + row * 3.1, row));
  const crev = smoothstep(w, w * 0.35, Math.abs(q - row)) * smoothstep(0.55, 0.62, s) * smoothstep(0.9, 0.8, s) * smoothstep(0.9, 0.6, u);
  c = mix(c, mix(C.crevasse, rgb('#86b8dc'), snowK * 0.6), crev);
  return { c, snowK, cm };
}

const detailShade = (Hf, x, z) => {
  const fine = Hf.normal(x, z, TEX * 1.5);
  const coarse = Hf.normal(x, z, 0.04);
  const d = (n) => n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2];
  return clamp(d(fine) - d(coarse), -0.6, 0.6);
};
function texColor(x, z) {
  const g = glacierGrids.find((q) => q.phi(x, z) > -0.006);
  if (g) {
    const a = iceAlbedo(g, x, z);
    const n = g.normal(x, z);
    const c = shade(a.c, 1 + 0.7 * detailShade(g.G, x, z));
    return lightBake(c, { ao: relief.ao(x, z), cavity: 4 * a.cm, shadow: relief.shadow(x, z), sunlit: relief.sunlit(n), strength: lerp(0.85, 0.7, a.snowK) });
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
  section: material('section', { rough: 0.88 }),
  aquifer: material('aquifer', { rough: 0.55 }),
  glacier: material('glacier', { rough: 0.45, texture: land, clearcoat: [0.3, 0.25] }),
  iceWalls: material('iceWalls', { rough: 0.25, clearcoat: [0.5, 0.15] }),
  water: material('water', { rough: 0.05, clearcoat: [1, 0.04] }),
  river: material('river', { rough: 0.12, clearcoat: [0.8, 0.08] }),
  cloud: material('cloud', { rough: 1, emissive: '#262a30' }),
  trees: material('trees', { rough: 0.9 }),
  arrow: material('arrow', { rough: 0.45, emissive: '#1d2a33' }),
  rain: material('rain', { rough: 0.3, emissive: '#1a2a3a' }),
  snowfall: material('snowfall', { rough: 0.7, emissive: '#3a4048' }),
  sun: material('sun', { color: '#ffd54a', rough: 0.4, emissive: '#ffb800' }),
};
const root = node('WaterCycle');

// Ground block: textured surface, strata walls (aquifer band left to its own node), bottom.
const granite = (x, y, z) => {
  const h = x + z;
  let c = mix(rgb('#4a4541'), rgb('#6b605a'), 0.5 + 0.5 * N.fbm(h * 2.5, y * 4, 3));
  c = mix(c, rgb('#7a6560'), 0.3 * smoothstep(0.2, 0.6, N.n2(h * 40, y * 40)));
  const j = 1 - Math.abs(N.n2(h * 6 + y * 2, y * 0.7 + 9));
  return shade(c, 1 - 0.3 * smoothstep(0.94, 0.99, j));
};
const LAYERS = [
  { to: AQ_BOTTOM, color: rgb('#55504b'), colorBottom: rgb('#45403b'), shade: granite },
  { to: AQ_TOP, skip: true },
  // lake and river deposits above the aquifer: clays, silts, sands, then the mountain-front gravels
  ...sedimentStack(N, {
    from: AQ_TOP,
    to: 2.4,
    count: 16,
    seed: 40,
    fold: 0.05,
    palette: [rgb('#b09a74'), rgb('#9c8466'), rgb('#8a7f72'), rgb('#a68f6c'), rgb('#7d7064'), rgb('#bba582'), rgb('#857565'), rgb('#6f6559')],
  }),
];
const skinColor = (x, z) => shade(groundAlbedo(x, z).c, 0.85);
const wallBands = strata({ base: YB, top: terrain, layers: LAYERS, skin: SKIN, skinColor, skinBottom: () => rgb('#4f4235') });
const WSTEP = 0.04;
const SIDES = [
  [line([X0, Z1], [X1, Z1], WSTEP), [0, 0, 1], 0.065],
  [line([X0, Z0], [X1, Z0], 0.06), [0, 0, -1], null],
  [line([X0, Z0], [X0, Z1], 0.05), [-1, 0, 0], null],
  [line([X1, Z0], [X1, Z1], WSTEP), [1, 0, 0], 0.065],
];
log('ground mesh');
const groundTop = surface({ ...GRID, h: terrain, normal: tNormal, uv: TEXMAP.uv }).geo;
const groundTopS = await simplifyGeo(groundTop, { target: 44000, error: 0.0015 });
log(`ground ${groundTop.triangles} → ${groundTopS.triangles}`);
const walls = new Geo();
for (const [path, n, dy] of SIDES) walls.append(bandWall(path, wallBands, n, { dy }));
{
  const g = new Geo();
  const n = [0, -1, 0];
  const c = rgb('#4f4842');
  g.quad(g.v([X0, YB, Z0], n, c), g.v([X1, YB, Z0], n, c), g.v([X1, YB, Z1], n, c), g.v([X0, YB, Z1], n, c), n);
  walls.append(g);
}
node('Ground', [[groundTopS, M.ground], [walls, M.walls]], null, root);
const CAP = line([X0, CAP_Z], [X1, CAP_Z], WSTEP);
node('Ground_Section', bandWall(CAP, (x) => wallBands(x, 0), [0, 0, 1], { dy: 0.06 }), M.section, root);

// Aquifer: saturated sand and gravel (concept blue), on the block faces and in the section.
const AQ_C_TOP = rgb('#5b9bd0');
const AQ_C_BOTTOM = rgb('#2f6a9e');
const aquiferShade = (x, y, z, f) => {
  const h = x + z;
  // pebbles and sand lenses in a blue «water-filled» tone: lighter at the water table, deeper below
  let c = mix(AQ_C_BOTTOM, AQ_C_TOP, smoothstep(0, 1, f));
  c = shade(c, 0.88 + 0.22 * (0.5 + 0.5 * N.n2(h * 70, y * 70)));
  c = mix(c, rgb('#8fc0e6'), 0.3 * smoothstep(0.55, 0.85, N.n2(h * 30 + 5, y * 30)));
  return shade(c, 1 + 0.06 * Math.sin((y - AQ_BOTTOM) * 90 + 2 * N.fbm(h, y * 3, 2)));
};
const aquiferBand = (x, z) => [{ top: Math.min(AQ_TOP, terrain(x, z) - SKIN), bottom: AQ_BOTTOM, cTop: AQ_C_TOP, cBottom: AQ_C_BOTTOM, shade: aquiferShade }];
const aq = new Geo();
for (const [path, n, dy] of SIDES) aq.append(bandWall(path, aquiferBand, n, { dy: dy ? 0.05 : null }));
const aquifer = node('Aquifer', aq, M.aquifer, root);
// water-table line: a thin pale stripe at the top of the aquifer
const wt = new Geo();
for (const [path, n] of SIDES) wt.append(bandWall(path.map(([x, z]) => [x + n[0] * 0.002, z + n[2] * 0.002]), () => [{ top: AQ_TOP + 0.012, bottom: AQ_TOP - 0.004, cTop: rgb('#a9d4f2') }], n));
node('Aquifer_WaterTable', wt, M.aquifer, aquifer);
node('Aquifer_Section', bandWall(CAP, (x) => aquiferBand(x, 0), [0, 0, 1], { dy: 0.05 }), M.aquifer, aquifer);

// Lake (level 0) with its section: turquoise shallows, deep blue middle.
const lakePhi = (x, z) => Math.min(-terrain(x, z), 1.4 - lakeE(x, z));
const lakeColor = (x, z) => {
  const depth = -terrain(x, z);
  let c = mix(C.lakeShallow, C.lakeMid, smoothstep(0.01, 0.12, depth));
  c = mix(c, C.lakeDeep, smoothstep(0.12, 0.42, depth));
  // milky plume where the glacial river enters
  c = mix(c, C.riverMilky, 0.5 * smoothstep(0.45, 0.0, Math.hypot(x - 0.75, z - 0.47)) * (0.7 + 0.3 * N.fbm(x * 8, z * 8, 2)));
  return shade(c, 0.97 + 0.06 * N.fbm(x * 5, z * 5, 2));
};
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
    color: (x, y, z) => lakeColor(x, z),
    normal: () => [0, 1, 0],
  }).geo,
  M.water,
  root,
);
node('Lake_Section', bandWall(line([LAKE.x - LAKE.rx * 1.4, CAP_Z], [LAKE.x + LAKE.rx * 1.4, CAP_Z], 0.02), (x) => {
  const t = terrain(x, 0);
  return [{ top: lakePhi(x, 0) >= 0 ? 0 : t, bottom: t, cTop: rgb('#4fb8d6'), cBottom: rgb('#123f7a') }];
}, [0, 0, 1], { dy: 0.05 }), M.water, lakeNode);

// Glaciers: textured surface, ice cliffs at the margins and snout, a few open crevasses.
async function glacierParts(g, name) {
  const { gl, box, h, phi, normal } = g;
  const surf = surface({ ...box, step: 0.02, h, phi, normal, uv: TEXMAP.uv }).geo;
  const edges = curtain(contour({ ...box, step: 0.02, fn: phi }), { top: h, bottom: (x, z) => terrain(x, z) - 0.03, phi, cTop: (x, z) => shade(rgb('#9fbfcc'), 0.9 + 0.2 * N.n2(x * 50, z * 50)), cBottom: rgb('#3f5f6e') });
  const [ax, az] = gl.a;
  const [bx, bz] = gl.b;
  for (let k = 0; k < 4; k++) {
    const s = 0.62 + k * 0.08;
    const cx = lerp(ax, bx, s);
    const cz = lerp(az, bz, s);
    const vx = bx - ax;
    const vz = bz - az;
    const l = Math.hypot(vx, vz);
    const [px, pz] = [-vz / l, vx / l];
    const pts = [-0.11, 0, 0.11].map((u) => [cx + px * u - (vx / l) * Math.abs(u) * 0.4, cz + pz * u - (vz / l) * Math.abs(u) * 0.4]);
    if (pts.every(([x, z]) => phi(x, z) > 0.01))
      edges.append(
        ribbon(spline(pts, 0.015), {
          width: (t) => 0.014 * Math.sin(Math.PI * clamp(t, 0.05, 0.95)) + 0.003,
          y: (x, z) => h(x, z) + 0.004,
          color: rgb('#d9eef6'),
          centre: rgb('#0b2c48'),
          normal,
        }),
      );
  }
  return node(name, [[await simplifyGeo(surf, { target: 3500, error: 0.0006 }), M.glacier], [edges, M.iceWalls]], null, root);
}
await glacierParts(glacierGrids[0], 'Glacier');
await glacierParts(glacierGrids[1], 'Glacier_2');

// Rivers: milky glacial water near the glaciers, bluer by the lake.
const riverY = (x, z) => terrain(x, z) + 0.014;
const riverColor = (t, i) => shade(mix(C.riverMilky, C.river, smoothstep(0, 0.7, t)), 0.95 + 0.1 * N.rand(i, 77));
const bank = (t) => mix(rgb('#b6e0e2'), rgb('#8cc6dc'), t);
node('River_Main', ribbon(RIVER_1, { width: (t) => 0.05 + 0.09 * t, y: riverY, color: bank, centre: riverColor }), M.river, root);
node('River_East', ribbon(RIVER_2, { width: (t) => 0.04 + 0.06 * t, y: riverY, color: bank, centre: riverColor }), M.river, root);

// Clouds: layered cumulus — flat grey bases, bright cauliflower tops — and a dark rain/snow cloud.
const SUN_POS = [2.95, 3.25, -1.95];
function cumulus(centre, size, seed, { dark = 0, towers = 3 } = {}) {
  const puffs = [];
  const [cx, cy, cz] = centre;
  const base = cy - size * 0.3;
  // base layer: broad, flattened puffs
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2 + N.rand(k, seed);
    const r = size * (0.35 + 0.5 * N.rand(k, seed + 1));
    const rr = size * (0.34 + 0.14 * N.rand(k, seed + 2));
    puffs.push([cx + Math.cos(a) * r * 1.15, base + rr * 0.55, cz + Math.sin(a) * r * 0.6, rr]);
  }
  // body
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + N.rand(k, seed + 3) * 1.3;
    const r = size * (0.15 + 0.35 * N.rand(k, seed + 4));
    const rr = size * (0.36 + 0.14 * N.rand(k, seed + 5));
    puffs.push([cx + Math.cos(a) * r, base + size * (0.42 + 0.12 * N.rand(k, seed + 6)), cz + Math.sin(a) * r * 0.55, rr]);
  }
  // cauliflower towers
  for (let k = 0; k < towers; k++) {
    const a = N.rand(k, seed + 7) * Math.PI * 2;
    const r = size * 0.25 * N.rand(k, seed + 8);
    const rr = size * (0.27 + 0.1 * N.rand(k, seed + 9));
    puffs.push([cx + Math.cos(a) * r, base + size * (0.78 + 0.18 * N.rand(k, seed + 10)), cz + Math.sin(a) * r * 0.5, rr]);
  }
  const topY = Math.max(...puffs.map((p) => p[1] + p[3]));
  // `dark` 0 = fair-weather cumulus, 1 = heavy precipitation cloud
  const colBase = mix(rgb('#a9b6c6'), rgb('#626d7b'), dark);
  const colTop = mix(rgb('#ffffff'), rgb('#c0c7d0'), dark);
  const sunDir = (() => {
    const v = [SUN_POS[0] - cx, SUN_POS[1] - cy, SUN_POS[2] - cz];
    const l = Math.hypot(...v);
    return v.map((q) => q / l);
  })();
  const g = new Geo();
  puffs.forEach(([px, py, pz, rr], k) => {
    const puff = blob([px, py, pz], {
      radii: [rr, rr * 0.82, rr * 0.9],
      color: [1, 1, 1],
      detail: 2,
      jitter: (d) => 1 + 0.07 * N.n2(d[0] * 3 + k + seed, d[2] * 3 + d[1] * 2) + 0.03 * N.n2(d[0] * 9 + k, d[1] * 9 + seed),
    });
    g.append(puff);
  });
  // flat base: a cloud's bottom is the condensation level
  for (let i = 1; i < g.P.length; i += 3) g.P[i] = Math.max(g.P[i], base);
  g.smoothNormals();
  // colour: height in the cloud (grey base → white top), sun side brighter, crevices between puffs darker
  for (let v = 0; v < g.count; v++) {
    const p = [g.P[3 * v], g.P[3 * v + 1], g.P[3 * v + 2]];
    const n = [g.N[3 * v], g.N[3 * v + 1], g.N[3 * v + 2]];
    const hgt = clamp((p[1] - base) / (topY - base));
    let c = mix(colBase, colTop, smoothstep(0.0, 0.75, hgt) ** 0.8);
    const lit = clamp(n[0] * sunDir[0] + n[1] * sunDir[1] + n[2] * sunDir[2]);
    c = shade(c, 0.9 + 0.14 * lit);
    let occ = 0;
    for (const [qx, qy, qz, qr] of puffs) {
      const d = Math.hypot(p[0] - qx, (p[1] - qy) / 0.82, (p[2] - qz) / 0.9) / qr;
      if (d < 1.0) occ += 1 - d;
    }
    c = shade(c, 1 - 0.35 * clamp(occ * 2.2) * (1 - 0.5 * hgt));
    if (n[1] < -0.5) c = shade(c, 0.88);
    for (let d = 0; d < 3; d++) g.C[3 * v + d] = c[d];
  }
  return g;
}
const CLOUDS = {
  Cloud_Valley: { c: [-0.55, 2.6, -0.45], size: 0.55, dark: 0.45, towers: 3 },
  Cloud_Rain: { c: [-2.55, 3.3, -1.85], size: 0.58, dark: 0.8, towers: 2 },
  Cloud_Lake: { c: [2.0, 2.15, 0.25], size: 0.4, towers: 2 },
};
Object.entries(CLOUDS).forEach(([name, v], i) => node(name, cumulus(v.c, v.size, 30 + i * 10, v), M.cloud, root));

// Precipitation (decor): rain shafts from the valley cloud, snow over the glacier.
const rain = new Geo();
{
  const [cx, cy, cz] = CLOUDS.Cloud_Valley.c;
  const base = cy - CLOUDS.Cloud_Valley.size * 0.3;
  for (let k = 0; k < 110; k++) {
    // a shaft: denser in the middle, slanted by the wind
    const a = N.rand(k, 201) * Math.PI * 2;
    const r = 0.5 * Math.sqrt(N.rand(k, 202));
    const x = cx + Math.cos(a) * r * 0.95;
    const z = cz + Math.sin(a) * r * 0.45;
    const len = 0.1 + 0.08 * N.rand(k, 204);
    const groundY = terrain(clamp(x, X0, X1), clamp(z, Z0, Z1));
    for (let y = base - 0.05 - 0.3 * N.rand(k, 203); y - len > groundY + 0.08; y -= len * (2.2 + 1.5 * N.rand(k, 205))) {
      const t = (base - y) / (base - groundY);
      const c = mix(rgb('#9cc4ea'), rgb('#4f8cc9'), clamp(t));
      rain.append(tube([[x - 0.25 * (base - y) * 0.18, y, z], [x - 0.25 * (base - y + len) * 0.18 - 0.012, y - len, z]], { radius: 0.0045, color: c, segs: 3 }));
    }
  }
}
node('Precip_Rain', rain, M.rain, root);
const snowfall = new Geo();
{
  const [cx, cy, cz] = CLOUDS.Cloud_Rain.c;
  const base = cy - CLOUDS.Cloud_Rain.size * 0.3;
  for (let k = 0; k < 110; k++) {
    const x = cx + (N.rand(k, 301) - 0.5) * 1.0;
    const z = cz + (N.rand(k, 302) - 0.5) * 0.55;
    const ground = terrain(clamp(x, X0, X1), clamp(z, Z0, Z1));
    const y = lerp(ground + 0.1, base - 0.05, N.rand(k, 303) ** 0.8);
    const r = 0.011 + 0.008 * N.rand(k, 304);
    // flakes: small faceted crystals, a cool white
    snowfall.append(blob([x, y, z], { radii: [r, r, r], color: (d) => mix(rgb('#dfe9f4'), rgb('#ffffff'), clamp(d[1] + 0.5)), detail: 0, jitter: (d) => 1 + 0.35 * N.n2(d[0] * 5 + k, d[2] * 5) }));
  }
}
node('Precip_Snow', snowfall, M.snowfall, root);

// Sun (decor).
node('Sun', blob(SUN_POS, { radii: [0.3, 0.3, 0.3], color: (d) => mix(rgb('#ffb92e'), rgb('#ffe680'), clamp(d[2] * 0.5 + d[1] * 0.3 + 0.5)), detail: 2 }), M.sun, root);

// Trees (decor): Tien Shan spruce on the range fronts, poplars and leafy trees by the water.
const trees = new Geo();
for (const t of TREES) {
  const lit = (c) => lightBake(c, { ao: relief.ao(t.x, t.z), shadow: relief.shadow(t.x, t.z), strength: 0.7 });
  if (t.kind === 'spruce') {
    const h = 0.2 * t.s * (0.85 + 0.3 * N.rand(t.k, 110));
    trees.append(
      spruce([t.x, t.y, t.z], {
        height: h,
        radius: h * (0.17 + 0.05 * N.rand(t.k, 111)),
        color: lit(shade(mix(C.spruce, rgb('#2f5640'), N.rand(t.k, 108)), 0.8 + 0.35 * N.rand(t.k, 104))),
        trunk: C.trunk,
        tiers: 6,
        segs: 6,
        phase: N.rand(t.k, 109) * 6,
        rand: (q) => N.rand(t.k, 300 + q),
        lean: [(N.rand(t.k, 112) - 0.5) * 0.08, (N.rand(t.k, 113) - 0.5) * 0.08],
      }),
    );
  } else {
    const s = t.s;
    const poplar = t.kind === 'poplar';
    const h = (poplar ? 0.2 : 0.12) * s;
    const base = lit(shade(poplar ? C.poplar : C.leaf, 0.82 + 0.3 * N.rand(t.k, 206)));
    trees.append(tube([[t.x, t.y - 0.01, t.z], [t.x, t.y + h * 0.3, t.z]], { radius: 0.008 * s, color: C.trunk, segs: 4 }));
    // crown: two or three overlapping lobes, darker underneath, sunlit on top
    const lobes = poplar ? 2 : 3;
    for (let k = 0; k < lobes; k++) {
      const ox = (N.rand(t.k, 210 + k) - 0.5) * (poplar ? 0.012 : 0.04) * s;
      const oz = (N.rand(t.k, 220 + k) - 0.5) * (poplar ? 0.012 : 0.04) * s;
      const cy = t.y + h * (poplar ? 0.45 + 0.28 * k : 0.55 + 0.1 * k);
      const rr = poplar ? [0.028 * s, h * 0.36, 0.028 * s] : [0.045 * s * (0.8 + 0.3 * N.rand(t.k, 230 + k)), 0.04 * s, 0.045 * s];
      trees.append(blob([t.x + ox, cy, t.z + oz], { radii: rr, color: (d) => shade(base, 0.7 + 0.45 * clamp(d[1] * 0.6 + 0.5)), detail: 1, jitter: (d) => 1 + 0.14 * N.n2(d[0] * 4 + k + t.k, d[2] * 4 + d[1] * 3) }));
    }
  }
}
node('Trees', trees, M.trees, root);

// Arrows (decor), concept-coloured with a tone gradient (deeper at the tail, lighter at the head).
const toneRamp = (hex) => (t) => mix(shade(rgb(hex), 0.78), mix(rgb(hex), [1, 1, 1], 0.25), clamp(t));
const arrows = new Geo();
const wavy = (x, z, y0, y1, amp, seed) => {
  const pts = [];
  for (let y = y0; y <= y1; y += 0.06) pts.push([x + amp * Math.sin((y - y0) * 7 + seed), y, z]);
  return pts;
};
[[1.55, 0.35], [2.0, 0.6], [2.45, 0.3]].forEach(([x, z], k) => arrows.append(arrow(wavy(x, z, 0.08, 1.7, 0.05, k), { radius: 0.022, color: toneRamp('#9ad2f5'), head: 2.6, headLength: 5 })));
node('Arrow_Evaporation', arrows, M.arrow, root);
const tr = new Geo();
[[-1.4, 0.75], [-1.05, 0.95]].forEach(([x, z], k) => {
  const y0 = terrain(x, z) + 0.2;
  tr.append(arrow(wavy(x, z, y0, y0 + 0.9, 0.04, k + 3), { radius: 0.018, color: toneRamp('#9bd39a'), head: 2.6, headLength: 5 }));
});
node('Arrow_Transpiration', tr, M.arrow, root);
node(
  'Arrow_Vapour',
  arrow(spline([[1.6, 2.5, 0.2], [0.9, 2.95, 0.0], [0.1, 3.05, -0.3], [-0.5, 3.0, -0.5]], 0.05), { radius: 0.022, color: toneRamp('#e3ecf3'), head: 2.6, headLength: 5 }),
  M.arrow,
  root,
);
// Surface runoff / infiltration markers: short arrows into the ground on the meadow.
const inf = new Geo();
[[-0.9, 0.9], [-0.5, 1.05], [-0.15, 0.95]].forEach(([x, z]) => {
  const y = terrain(x, z);
  inf.append(arrow([[x, y + 0.35, z], [x, y + 0.04, z]], { radius: 0.016, color: toneRamp('#6fb2e6'), head: 2.6, headLength: 5 }));
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
    const ca = color(i / (L - 1));
    const cb = color((i + 1) / (L - 1));
    g.quad(g.v([a[0], a[1], z], n, ca), g.v([b[0], b[1], z], n, ca), g.v([d[0], d[1], z], n, cb), g.v([c[0], c[1], z], n, cb), n);
  }
  const [hl, hr] = side(L - head - 1, width * 1.4);
  const tip = dense[L - 1];
  g.tri(g.v([hl[0], hl[1], z], n, color(1)), g.v([hr[0], hr[1], z], n, color(1)), g.v([tip[0], tip[1], z], n, color(1)), n);
  return g;
}
const under = new Geo();
under.append(flatArrow([[-0.75, terrain(-0.75, 0) - 0.06], [-0.7, -0.2], [-0.62, AQ_TOP - 0.05]], 0.05, toneRamp('#d8ecfa')));
under.append(flatArrow([[-0.35, -0.66], [0.3, -0.66], [0.8, -0.62], [1.05, -0.52]], 0.05, toneRamp('#d8ecfa')));
node('Arrow_Groundwater', under, M.arrow, root);

// Atmosphere: the sky backdrop behind the ranges, gradient texture.
const sky = new Geo();
{
  const R = [];
  for (let x = X0; x <= X1 + 1e-9; x += 0.1) R.push([x, Z0 - 0.04]);
  const TOP = 3.9;
  const bottom = R.map(([x, z]) => Math.max(terrain(clamp(x, X0, X1), clamp(z, Z0, Z1)) - 0.05, 0));
  for (let i = 0; i < R.length - 1; i++) {
    const [ax, az] = R[i];
    const [bx, bz] = R[i + 1];
    const facing = [0, 0, 1];
    const v = (x, y, z) => sky.v([x, y, z], facing, [1, 1, 1], [0.5, 1 - y / TOP]);
    sky.quad(v(ax, bottom[i], az), v(bx, bottom[i + 1], bz), v(bx, TOP, bz), v(ax, TOP, az), facing);
  }
}
sky.C = [];
// vertical gradient: hazy pale blue at the horizon, deeper blue above
const skyPng = await (() => {
  const H = 64;
  const px = Buffer.alloc(4 * H * 3);
  for (let j = 0; j < H; j++) {
    const t = j / (H - 1); // 0 = top
    const top = [96, 158, 220];
    const bot = [222, 238, 248];
    const c = top.map((v, i) => Math.round(v + (bot[i] - v) * t ** 1.3));
    for (let i = 0; i < 4; i++) px.set(c, (j * 4 + i) * 3);
  }
  return sharp(px, { raw: { width: 4, height: H, channels: 3 } }).png().toBuffer();
})();
const skyTex = texture('Sky', skyPng);
node('Atmosphere', sky, material('sky', { rough: 1, texture: skyTex, emissiveTexture: skyTex, emissive: '#b8b8b8' }), root);

doc.createScene('Scene').addChild(root);

// --- write ------------------------------------------------------------------------------------
log('optimise');
await optimise(doc, { ratio: 1, maxTexture: 2048, webpQuality: 86 });
const io = await createIO();
const glb = await io.writeBinary(doc);
const tris = docTriangles(doc);
console.error(nodeTree(doc).join('\n'), glb.byteLength, tris);
checkBudget('water-cycle.glb', glb.byteLength, tris);
writeFileSync(outPath, glb);

const r2 = (v) => Number(v.toFixed(2));
const at = (x, z, dy = 0.03) => [r2(x), r2(terrain(x, z) + dy), r2(z)];
const g1 = glacierGrids[0].h;
const report = {
  sizeAfter: glb.byteLength,
  trianglesAfter: tris,
  textures: 2,
  texture: `${TEXMAP.width}x${TEXMAP.height}`,
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
log('done');
