/**
 * Specimen thumbnails (TZ W-12: rendered at build time, not in the browser).
 *
 * Every `topic.samples[].thumb` is rendered with the client's real viewer and
 * scene plugins (bilig_ft `/thumb.html`, a dev-only page), so a thumbnail
 * looks exactly like the model in the app. What a sample shows comes from
 * `content/src/thumbs.json`:
 *
 *   { "<topicKey>": { "<sampleKey>": {
 *       "topicKey"?: render another topic's scene (default: sample.topicKey ?? the topic),
 *       "scene"?:    { plugin?, params?, camera?, asset? }  replaces parts of that scene,
 *       "modes"?, "focus"?, "isolate"?, "hide"?            viewer state,
 *       "process"?:  { key, fraction }                     a frozen point of a process,
 *       "crop"?:     false = keep the camera framing (sizes stay comparable),
 *       "bounds"?:   "soft" = crop to every drawn pixel, not only opaque ones } } }
 *
 * Output: content/assets/<topicKey>/<thumb path> (transparent WebP) plus an
 * ASSET.json entry. A render of a GLB inherits that GLB's licence and author
 * (a render is a derivative); a procedural render is Bilig's own work (CC0).
 *
 * Needs the bilig_ft dev server (`npm run dev` there) and its Playwright:
 *   node scripts/assets/thumbs.mjs [--ft=http://localhost:5173] [--ft-dir=../bilig_ft] [--only=water,dna] [--size=384] [--force]
 *     [--samples=water/ice,water/steam] [--preview=/tmp/thumbs]  (preview: no content changes)
 * Then rebuild the packages: `npx tsx content/build.mjs`.
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONTENT = join(ROOT, 'content');
const arg = (name, dflt) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? dflt;
const FT_URL = arg('ft', 'http://localhost:5173');
const FT_DIR = resolve(ROOT, arg('ft-dir', '../bilig_ft'));
const ONLY = arg('only', '')?.split(',').filter(Boolean);
const SIZE = Number(arg('size', '384'));
/** Existing thumbnails (e.g. hand-made in an asset pipeline) are kept unless --force. */
const FORCE = process.argv.includes('--force');
/** Only these samples (`topic/sample`, comma-separated). */
const SAMPLES = arg('samples', '')?.split(',').filter(Boolean);
/** Write `<topic>__<sample>.webp` into this folder instead of content/assets (no ASSET.json changes): for iterating on specs. */
const PREVIEW = arg('preview', '') ? resolve(arg('preview', '')) : null;
const VIEW = 720;

const packages = Object.fromEntries(
  readdirSync(join(CONTENT, 'packages'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const p = JSON.parse(readFileSync(join(CONTENT, 'packages', f), 'utf8'));
      return [p.topic.key, p];
    }),
);
const specsFile = join(CONTENT, 'src', 'thumbs.json');
const specs = existsSync(specsFile) ? JSON.parse(readFileSync(specsFile, 'utf8')) : {};
for (const [topicKey, samples] of Object.entries(specs)) {
  if (!packages[topicKey]) throw new Error(`thumbs.json: unknown topic ${topicKey}`);
  for (const k of Object.keys(samples)) {
    if (!packages[topicKey].topic.samples.some((s) => s.key === k)) throw new Error(`thumbs.json: ${topicKey} has no sample ${k}`);
  }
}

// Static server for the real GLBs (content/assets/<topicKey>/…), with CORS for the dev page.
const TYPES = { '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ktx2': 'image/ktx2' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = resolve(CONTENT, 'assets', '.' + path);
  if (!file.startsWith(join(CONTENT, 'assets')) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const assetPort = server.address().port;

const { chromium } = await import(pathToFileURL(join(FT_DIR, 'node_modules/@playwright/test/index.mjs')).href);
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });

/** Render one spec; returns a transparent PNG buffer. */
async function render(spec) {
  const page = await browser.newPage({ viewport: { width: VIEW, height: VIEW } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((s) => {
    window.__THUMB__ = s;
  }, spec);
  await page.goto(`${FT_URL}/thumb.html`);
  try {
    // First frame, then let GLBs, textures and the camera framing settle.
    await page.waitForFunction(() => !!window.__thumbCapture?.(), null, { timeout: 90_000, polling: 500 });
    // The viewer veils the stage while the model downloads and compiles (and on
    // failure): wait for the real model instead of a fixed delay, so a large GLB
    // on a slow machine is never captured as its stand-in.
    await page.waitForTimeout(1000);
    await page.waitForFunction(() => !document.querySelector('.stage__veil'), null, { timeout: 180_000, polling: 500 }).catch(async () => {
      const failed = await page.evaluate(() => !!document.querySelector('.stage__progress--failed'));
      throw new Error(failed ? 'model failed to load' : 'model still loading after 180 s');
    });
    await page.waitForTimeout(spec.assetBaseUrl ? 3000 : 2000);
    const data = await page.evaluate(() => window.__thumbCapture());
    if (!data) throw new Error('no frame');
    return Buffer.from(data.split(',')[1], 'base64');
  } catch (e) {
    throw new Error(`${e.message}${errors.length ? ` (page: ${errors.join('; ')})` : ''}`);
  } finally {
    await page.close();
  }
}

/**
 * Crop to the model with a margin, square, SIZE px WebP. Bounds come from opaque pixels, so the
 * contact shadow and translucent hulls don't inflate them; `bounds: "soft"` (spec) counts every
 * drawn pixel instead (scenes whose meaning is in translucent parts). `crop: false` keeps the
 * camera framing, so sizes stay comparable between sibling samples.
 */
async function toThumb(png, opts = {}) {
  const enc = (img) => img.webp({ quality: 84, alphaQuality: 90, effort: 6 }).toBuffer();
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const box = (min) => {
    let [x0, y0, x1, y1, n] = [info.width, info.height, -1, -1, 0];
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++)
        if (data[(y * info.width + x) * 4 + 3] > min) {
          n++;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
    return { x0, y0, x1, y1, n };
  };
  const area = info.width * info.height;
  const soft = box(12);
  if (soft.n < area * 0.005) throw new Error('empty render (under 0.5% of the frame is drawn)');
  if (opts.crop === false) return enc(sharp(png).resize(SIZE, SIZE, { fit: 'cover' }));
  const hard = opts.bounds === 'soft' ? soft : box(96);
  const b = hard.n > area * 0.002 ? hard : soft;
  const side = Math.min(Math.max(b.x1 - b.x0, b.y1 - b.y0) * 1.16, Math.max(info.width, info.height));
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  const left = Math.round(Math.max(0, Math.min(info.width - side, cx - side / 2)));
  const top = Math.round(Math.max(0, Math.min(info.height - side, cy - side / 2)));
  const s = Math.round(Math.min(side, info.width - left, info.height - top));
  return enc(sharp(png).extract({ left, top, width: s, height: s }).resize(SIZE, SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }));
}

function assetMeta(topicKey) {
  const f = join(CONTENT, 'assets', topicKey, 'ASSET.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { topicKey, files: [] };
}

function rights(sceneTopicKey, asset) {
  const own = { license: 'CC0-1.0', author: 'Bilig', source: 'rendered from the topic’s procedural 3D scene (scripts/assets/thumbs.mjs)' };
  if (!asset) return own;
  const glb = assetMeta(sceneTopicKey).files.find((f) => f.path === asset);
  if (!glb) return own;
  return {
    license: glb.license,
    author: glb.author,
    source: glb.source,
    ...(glb.attribution ? { attribution: glb.attribution } : {}),
    derivedFrom: `${sceneTopicKey}/${asset} (render)`,
  };
}

const cache = new Map();
const failures = [];
let written = 0;
for (const pkg of Object.values(packages)) {
  const topic = pkg.topic;
  if (ONLY.length && !ONLY.includes(topic.key)) continue;
  const meta = assetMeta(topic.key);
  for (const sample of topic.samples) {
    if (SAMPLES.length && !SAMPLES.includes(`${topic.key}/${sample.key}`)) continue;
    const s = specs[topic.key]?.[sample.key] ?? {};
    const sceneTopic = s.topicKey ?? sample.topicKey ?? topic.key;
    const scenePkg = packages[sceneTopic];
    if (!scenePkg) {
      failures.push(`${topic.key}/${sample.key}: unknown topic ${sceneTopic}`);
      continue;
    }
    const scene = { ...scenePkg.topic.scene, ...s.scene };
    const asset = scene.plugin === 'gltf' && scene.asset && existsSync(join(CONTENT, 'assets', sceneTopic, scene.asset)) ? scene.asset : null;
    const spec = {
      pkg: scenePkg,
      scene: s.scene,
      modes: s.modes,
      focus: s.focus ?? null,
      isolate: s.isolate,
      hide: s.hide,
      process: s.process,
      assetBaseUrl: asset ? `http://127.0.0.1:${assetPort}/${sceneTopic}/` : undefined,
    };
    const out = PREVIEW ? join(PREVIEW, `${topic.key}__${sample.key}.webp`) : join(CONTENT, 'assets', topic.key, sample.thumb);
    if (!PREVIEW && !FORCE && existsSync(out)) {
      process.stdout.write(`keep ${topic.key}/${sample.thumb}\n`);
      continue;
    }
    const id = JSON.stringify([sceneTopic, s]);
    try {
      if (!cache.has(id)) cache.set(id, await toThumb(await render(spec), s));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, cache.get(id));
      if (!PREVIEW) meta.files = [...meta.files.filter((f) => f.path !== sample.thumb), { path: sample.thumb, ...rights(sceneTopic, asset), rendered: new Date().toISOString().slice(0, 10) }];
      written++;
      process.stdout.write(`ok ${topic.key}/${sample.thumb}${sceneTopic !== topic.key ? ` (scene: ${sceneTopic})` : ''}\n`);
    } catch (e) {
      failures.push(`${topic.key}/${sample.key}: ${e.message}`);
      process.stdout.write(`FAIL ${topic.key}/${sample.key}: ${e.message}\n`);
    }
  }
  meta.files.sort((a, b) => a.path.localeCompare(b.path));
  if (!PREVIEW && meta.files.length) writeFileSync(join(CONTENT, 'assets', topic.key, 'ASSET.json'), JSON.stringify(meta, null, 2) + '\n');
}

await browser.close();
server.close();
process.stdout.write(`thumbnails written=${written} renders=${cache.size} failed=${failures.length}\n`);
if (failures.length) process.exit(1);
