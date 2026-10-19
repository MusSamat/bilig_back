/**
 * Small modelling kit for the procedural anatomy models (skeleton.mjs,
 * respiratory.mjs), on top of the shared three-gltf kit: vector helpers,
 * (super)ellipsoid blobs, bones/airways as tubes, thick sheets with
 * numerically derived normals, vertex-coloured PBR materials, and a model
 * builder that merges every part of one named node into a single glTF mesh
 * (one primitive per material), so the node list is exactly the contract
 * names and nothing else.
 *
 * Everything is deterministic: no Math.random, seeded noise only.
 */
import { BufferGeometry, CatmullRomCurve3, DoubleSide, Float32BufferAttribute, FrontSide, Color, Group, Matrix4, Mesh, MeshPhysicalMaterial, Quaternion, Vector3 } from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import { merged, pillow, surface, toDocument, tube } from './three-gltf.mjs';

export const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => mul(a, 1 / (len(a) || 1));
export const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
/** Sum of scaled vectors: comb(p, [v, k], [w, l]) = p + v·k + w·l. */
export const comb = (p, ...terms) => terms.reduce((acc, [v, k]) => add(acc, mul(v, k)), p);
export const V = (p) => new Vector3(p[0], p[1], p[2]);
/** Rotate vector a towards b (both unit, in their plane) by angle (rad). */
export function rotateTowards(a, b, ang) {
  const perp = norm(sub(b, mul(a, dot(a, b))));
  return norm(add(mul(a, Math.cos(ang)), mul(perp, Math.sin(ang))));
}
/** Rotation turning local x → ax and local y → ay (ay orthogonalised). */
export function basis(ax, ay) {
  const x = norm(ax);
  const y = norm(sub(ay, mul(x, dot(x, ay))));
  const z = cross(x, y);
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(V(x), V(y), V(z)));
}

/** Smooth maximum (rounded intersection of SDF-like fields). */
export function smax(a, b, k) {
  const h = clamp(0.5 - (0.5 * (b - a)) / k);
  return lerp(a, b, 1 - h) + k * h * (1 - h);
}

/** Vertex-coloured physical material (white factor; colour lives in COLOR_0). */
export function material({ name = '', o = 1, r = 0.5, cc = 0, ccr = 0.35, ds = false, normal = null, ns = 0.5, rep = 4, sheen = 0, sheenColor = null, emissive = null }) {
  const m = new MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: r, metalness: 0, transparent: o < 1, opacity: o, clearcoat: cc, clearcoatRoughness: ccr, side: ds ? DoubleSide : FrontSide });
  m.name = name;
  if (sheen) {
    m.sheen = sheen;
    m.sheenRoughness = 0.5;
    if (sheenColor) m.sheenColor = new Color(...sheenColor);
  }
  if (emissive) {
    m.emissive = new Color(...emissive);
    m.emissiveIntensity = 1;
  }
  if (normal) {
    m.userData.normalPng = normal;
    m.userData.normalScale = ns;
    m.userData.normalRepeat = rep;
  }
  return m;
}

/**
 * (Super)ellipsoid blob centred at c, radii r (local axes), rotated by q.
 * e: per-axis exponent (< 1 = boxier along that axis); shape(d) → radial
 * factor (number or per-axis [kx, ky, kz]) from the unit direction d;
 * noise + amp + freq (1/m): organic radial displacement.
 */
export function blob(c, r, { q = null, nu = 20, nv = 14, e = [1, 1, 1], shape = null, noise = null, amp = 0, freq = 30, paint, uv } = {}) {
  const Q = q ?? new Quaternion();
  const t = new Vector3();
  return surface(
    nu,
    nv,
    (u, v) => {
      const th = u * Math.PI * 2;
      const ph = v * Math.PI;
      const dn = [Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)];
      const d = dn.map((x, i) => Math.sign(x) * Math.abs(x) ** e[i]);
      let k = shape ? shape(dn) : 1;
      if (typeof k === 'number') k = [k, k, k];
      let l = [d[0] * r[0] * k[0], d[1] * r[1] * k[1], d[2] * r[2] * k[2]];
      if (noise && amp) {
        const s = 1 + amp * noise.fbm((l[0] + c[0]) * freq, (l[1] + c[1]) * freq, (l[2] + c[2]) * freq, 3);
        l = mul(l, s);
      }
      t.set(l[0], l[1], l[2]).applyQuaternion(Q);
      return [c[0] + t.x, c[1] + t.y, c[2] + t.z];
    },
    { paint, uv },
  );
}

/** Tube through points ([x,y,z][]); radius(t, a), paint(p, n, t, a, cav). */
export function limb(points, na, nl, radius, { paint, cap = 0.08, closed = false, uv } = {}) {
  const curve = new CatmullRomCurve3(points.map(V), closed, 'centripetal');
  return tube(curve, na, nl, typeof radius === 'number' ? () => radius : radius, { paint, cap, uv });
}

/**
 * Thick sheet over the square U, V ∈ −1…1: mid-surface P(U, V) → [x,y,z]
 * (normals derived numerically), half-thickness h(U, V).
 * paint(p, n, U, V, cav, y) with y = −1…1 across the thickness.
 */
export function sheet(nu, nv, P, h, { profile = 0.6, paint, uv } = {}) {
  const e = 1e-3;
  return pillow(
    nu,
    nv,
    (U, W) => {
      const p = P(U, W);
      const pu = sub(P(clamp(U + e, -1, 1), W), P(clamp(U - e, -1, 1), W));
      const pv = sub(P(U, clamp(W + e, -1, 1)), P(U, clamp(W - e, -1, 1)));
      return { p, n: norm(cross(pu, pv)) };
    },
    h,
    { square: true, profile, paint, uv },
  );
}

/** Spline through points, sampled by t ∈ 0…1 (clamped). */
export function spline(points) {
  const c = new CatmullRomCurve3(points.map(V), false, 'centripetal');
  return (t) => {
    const p = c.getPoint(clamp(t));
    return [p.x, p.y, p.z];
  };
}

/**
 * Collects geometry per (node, material); build() merges each node into one
 * mesh. Nodes appear in the order they were first used.
 */
export class Model {
  constructor(rootName) {
    this.rootName = rootName;
    this.nodes = new Map();
  }
  add(node, geo, mat) {
    if (!this.nodes.has(node)) this.nodes.set(node, new Map());
    const m = this.nodes.get(node);
    if (!m.has(mat)) m.set(mat, []);
    m.get(mat).push(geo);
    return geo;
  }
  /** three.js graph (root → one Group per node → one Mesh per material); M bakes a transform into the vertices. */
  build(M = new Matrix4()) {
    const root = new Group();
    root.name = this.rootName;
    for (const [name, byMat] of this.nodes) {
      const g = new Group();
      g.name = name;
      for (const [mat, list] of byMat) {
        const geo = merged(list);
        geo.applyMatrix4(M);
        g.add(new Mesh(geo, mat));
      }
      root.add(g);
    }
    return root;
  }
  /** glTF document with each node's materials as primitives of one mesh on that node. */
  toDocument(M) {
    const doc = toDocument(this.build(M));
    for (const node of doc.getRoot().listNodes()) {
      const kids = node.listChildren();
      if (!node.getName() || node.getMesh() || !kids.length || kids.some((k) => k.getName() || !k.getMesh() || k.listChildren().length)) continue;
      const mesh = doc.createMesh(node.getName());
      for (const k of kids) {
        const old = k.getMesh();
        for (const p of old.listPrimitives()) {
          old.removePrimitive(p);
          mesh.addPrimitive(p);
        }
        old.dispose();
        k.dispose();
      }
      node.setMesh(mesh);
    }
    return doc;
  }
}

/* --------------------------------------------------------- implicit shapes */

/** Ellipsoid field: < 0 inside, ≈ distance near the surface. */
export function ell(p, c, r) {
  const q = [(p[0] - c[0]) / r[0], (p[1] - c[1]) / r[1], (p[2] - c[2]) / r[2]];
  return (Math.hypot(q[0], q[1], q[2]) - 1) * Math.min(r[0], r[1], r[2]);
}
/** Smooth minimum (rounded union). */
export function smin(a, b, k) {
  const h = clamp(0.5 + (0.5 * (b - a)) / k);
  return lerp(b, a, h) - k * h * (1 - h);
}

/**
 * Closed surface of a field f(p) (< 0 inside) that is star-shaped from the
 * centre o: along each direction, the outermost crossing within rMax
 * (marched inwards in `step`, refined by bisection). Directions as in blob().
 */
export function radialSurface(o, f, { nu = 64, nv = 48, rMax = 0.2, step = 0.002, paint, uv } = {}) {
  return surface(
    nu,
    nv,
    (u, v) => {
      const th = u * Math.PI * 2;
      const ph = v * Math.PI;
      const d = [Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)];
      const at = (r) => f([o[0] + d[0] * r, o[1] + d[1] * r, o[2] + d[2] * r]);
      let hi = rMax;
      let lo = rMax - step;
      while (lo > 0 && at(lo) > 0) {
        hi = lo;
        lo -= step;
      }
      if (lo <= 0) lo = 0;
      for (let k = 0; k < 16; k++) {
        const mid = (lo + hi) / 2;
        if (at(mid) > 0) hi = mid;
        else lo = mid;
      }
      const r = (lo + hi) / 2;
      return [o[0] + d[0] * r, o[1] + d[1] * r, o[2] + d[2] * r];
    },
    { paint, uv },
  );
}

/**
 * Thick cup (an acetabulum, a socket): spherical cap around −axis, outer
 * radius ro, inner ri, opening half-angle aMax (rad), rounded lip.
 * paint(p, n, u, v, cav) with v < 0.45 outer, v > 0.55 inner.
 */
export function cup(c, axis, ro, ri, aMax, { nu = 40, nv = 30, paint } = {}) {
  const a = norm(axis);
  const e1 = norm(cross(a, Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
  const e2 = cross(a, e1);
  return surface(
    nu,
    nv,
    (u, v) => {
      const th = u * Math.PI * 2;
      const rad = add(mul(e1, Math.cos(th)), mul(e2, Math.sin(th)));
      const pt = (r, al) => add(c, add(mul(a, -r * Math.cos(al)), mul(rad, r * Math.sin(al))));
      if (v <= 0.42) return pt(ro, (v / 0.42) * aMax);
      if (v >= 0.58) return pt(ri, ((1 - v) / 0.42) * aMax);
      const s = (v - 0.42) / 0.16;
      const p0 = pt(ro, aMax);
      const p1 = pt(ri, aMax);
      const tip = norm(add(mul(a, Math.sin(aMax)), mul(rad, Math.cos(aMax))));
      return add(lerp3(p0, p1, s), mul(tip, Math.sin(Math.PI * s) * (ro - ri) * 0.5));
    },
    { paint },
  );
}

/** Distance to segment ab minus radius (lerped ra → rb along the segment). */
export function capsule(p, a, b, ra, rb = ra) {
  const ab = sub(b, a);
  const t = clamp(dot(sub(p, a), ab) / dot(ab, ab));
  return len(sub(p, add(a, mul(ab, t)))) - lerp(ra, rb, t);
}
/** Polyline tube field: radius r(t) along the whole polyline (t 0…1). */
export function polyTube(p, pts, r) {
  let best = Infinity;
  const n = pts.length - 1;
  for (let i = 0; i < n; i++) best = Math.min(best, capsule(p, pts[i], pts[i + 1], r(i / n), r((i + 1) / n)));
  return best;
}

await MeshoptSimplifier.ready;

/**
 * Mesh of the zero set of a field f (< 0 inside) inside the box [lo, hi]:
 * surface nets on a grid of cell size h, vertices projected onto the surface,
 * simplified (meshoptimizer) to about `tris` triangles, normals from the
 * field gradient, colours from paint(p, n, 0, 0, cav) where cav is an
 * ambient-occlusion estimate from the field (> 0 in creases, like surface()).
 * Handles any topology: holes, bridges, cavities.
 */
export function implicitMesh(f, lo, hi, h, { tris = 20000, paint, ao = 0.006 } = {}) {
  const nx = Math.ceil((hi[0] - lo[0]) / h) + 1;
  const ny = Math.ceil((hi[1] - lo[1]) / h) + 1;
  const nz = Math.ceil((hi[2] - lo[2]) / h) + 1;
  const F = new Float32Array(nx * ny * nz);
  const id = (i, j, k) => (k * ny + j) * nx + i;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) F[id(i, j, k)] = f([lo[0] + i * h, lo[1] + j * h, lo[2] + k * h]);
  // One vertex per sign-changing cell: mean of the edge crossings.
  const cellV = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cid = (i, j, k) => (k * (ny - 1) + j) * (nx - 1) + i;
  const P = [];
  const corners = [];
  for (let c = 0; c < 8; c++) corners.push([c & 1, (c >> 1) & 1, (c >> 2) & 1]);
  const edges = [];
  for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) if ([0, 1, 2].filter((d) => corners[a][d] !== corners[b][d]).length === 1) edges.push([a, b]);
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const v = corners.map(([a, b, c]) => F[id(i + a, j + b, k + c)]);
        let neg = 0;
        for (const x of v) if (x < 0) neg++;
        if (neg === 0 || neg === 8) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of edges) {
          if (v[a] < 0 === v[b] < 0) continue;
          const t = v[a] / (v[a] - v[b]);
          sx += corners[a][0] + (corners[b][0] - corners[a][0]) * t;
          sy += corners[a][1] + (corners[b][1] - corners[a][1]) * t;
          sz += corners[a][2] + (corners[b][2] - corners[a][2]) * t;
          n++;
        }
        cellV[cid(i, j, k)] = P.length / 3;
        P.push(lo[0] + (i + sx / n) * h, lo[1] + (j + sy / n) * h, lo[2] + (k + sz / n) * h);
      }
  const grad = (p, e = h * 0.5) => {
    const g = [f([p[0] + e, p[1], p[2]]) - f([p[0] - e, p[1], p[2]]), f([p[0], p[1] + e, p[2]]) - f([p[0], p[1] - e, p[2]]), f([p[0], p[1], p[2] + e]) - f([p[0], p[1], p[2] - e])];
    return norm(g);
  };
  // Quads across sign-changing grid edges, oriented along the field gradient.
  const idx = [];
  const quad = (a, b, c, d) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    idx.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const s0 = F[id(i, j, k)] < 0;
        if (s0 === F[id(i + 1, j, k)] < 0) continue;
        const q = [cellV[cid(i, j - 1, k - 1)], cellV[cid(i, j, k - 1)], cellV[cid(i, j, k)], cellV[cid(i, j - 1, k)]];
        s0 ? quad(...q) : quad(q[3], q[2], q[1], q[0]);
      }
  for (let k = 1; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const s0 = F[id(i, j, k)] < 0;
        if (s0 === F[id(i, j + 1, k)] < 0) continue;
        const q = [cellV[cid(i - 1, j, k - 1)], cellV[cid(i - 1, j, k)], cellV[cid(i, j, k)], cellV[cid(i, j, k - 1)]];
        s0 ? quad(...q) : quad(q[3], q[2], q[1], q[0]);
      }
  for (let k = 0; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const s0 = F[id(i, j, k)] < 0;
        if (s0 === F[id(i, j, k + 1)] < 0) continue;
        const q = [cellV[cid(i - 1, j - 1, k)], cellV[cid(i, j - 1, k)], cellV[cid(i, j, k)], cellV[cid(i - 1, j, k)]];
        s0 ? quad(...q) : quad(q[3], q[2], q[1], q[0]);
      }
  // Project onto the surface (two Newton steps, bounded by the cell size).
  for (let v = 0; v < P.length; v += 3) {
    let p = [P[v], P[v + 1], P[v + 2]];
    for (let it = 0; it < 2; it++) {
      const d = f(p);
      const g = grad(p);
      p = sub(p, mul(g, clamp(d, -h * 0.5, h * 0.5)));
    }
    P[v] = p[0];
    P[v + 1] = p[1];
    P[v + 2] = p[2];
  }
  // Orientation: every triangle faces along the field gradient.
  for (let t = 0; t < idx.length; t += 3) {
    const a = [P[idx[t] * 3], P[idx[t] * 3 + 1], P[idx[t] * 3 + 2]];
    const b = [P[idx[t + 1] * 3], P[idx[t + 1] * 3 + 1], P[idx[t + 1] * 3 + 2]];
    const c = [P[idx[t + 2] * 3], P[idx[t + 2] * 3 + 1], P[idx[t + 2] * 3 + 2]];
    const nrm = cross(sub(b, a), sub(c, a));
    if (dot(nrm, grad(mul(add(add(a, b), c), 1 / 3))) < 0) {
      const x = idx[t + 1];
      idx[t + 1] = idx[t + 2];
      idx[t + 2] = x;
    }
  }
  const pos = new Float32Array(P);
  let ind = new Uint32Array(idx);
  if (ind.length / 3 > tris) [ind] = MeshoptSimplifier.simplify(ind, pos, 3, tris * 3, 0.02, []);
  // Compact and attribute.
  const remap = new Map();
  const outP = [];
  const outN = [];
  const outC = [];
  const outUV = [];
  const outI = [];
  for (const v of ind) {
    if (!remap.has(v)) {
      remap.set(v, outP.length / 3);
      const p = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
      const n = grad(p, h * 0.35);
      let occ = 0;
      let wsum = 0;
      for (let s = 1; s <= 4; s++) {
        const d = (ao * s) / 4;
        const w = 0.5 ** s;
        occ += (w * (d - f(add(p, mul(n, d))))) / d;
        wsum += w;
      }
      const cav = clamp(6 * (occ / wsum) - 0.3, -3, 3);
      outP.push(...p);
      outN.push(...n);
      outC.push(...paint(p, n, 0, 0, cav));
      outUV.push(clamp((p[0] + p[2] - lo[0] - lo[2]) / (hi[0] + hi[2] - lo[0] - lo[2])), clamp((p[1] - lo[1]) / (hi[1] - lo[1])));
    }
    outI.push(remap.get(v));
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(outP, 3));
  g.setAttribute('normal', new Float32BufferAttribute(outN, 3));
  g.setAttribute('color', new Float32BufferAttribute(outC, 3));
  g.setAttribute('uv', new Float32BufferAttribute(outUV, 2));
  g.setIndex(outI);
  return g;
}
