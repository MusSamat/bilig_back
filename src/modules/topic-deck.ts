/**
 * v0.6.0 GET /topics/:key/deck — the topic's ready-made presentation
 * (.pptx / .pdf), built from the published package. Same access as the
 * topic (demo topics for everyone, others by licence). Rendering takes a
 * second or two, so results are kept per package hash × language × format.
 */
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps.js';
import { route } from '../http/route.js';
import { fail } from '../http/errors.js';
import { renderPptx } from '../export/pptx.js';
import { renderDeckPdf } from '../export/deck-pdf.js';
import { AssetStore } from '../services/assets.js';
import { DEFAULT_CONTENT_DIR } from '../services/seed.js';
import { buildTopicDeck, deckFileName } from '../services/topic-deck.js';

const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const CACHE_MAX = 40;

export function registerTopicDeck(app: FastifyInstance, deps: Deps, assets = new AssetStore(join(deps.config.contentDir ?? DEFAULT_CONTENT_DIR, 'assets'))) {
  const { content } = deps;
  /** Insertion-ordered map used as a small LRU. */
  const cache = new Map<string, Promise<Buffer>>();

  route(app, deps, 'topicDeck', async ({ auth, params, query, lang: acceptLang, reply }) => {
    const pub = await content.getPublished(params.key ?? '');
    if (!pub) fail('not_found', { detail: 'topic' });
    const verdict = await content.canOpen(auth, pub!);
    if (verdict !== 'ok') fail(verdict, { detail: 'license_required', i18nKey: 'errors.license_required' });

    const pkg = pub!.build.pkg;
    const lang = query.lang ?? acceptLang;
    const format = query.format;
    const key = `${pkg.manifest.hash}:${lang}:${format}`;
    let job = cache.get(key);
    if (job) cache.delete(key); // refresh its LRU position
    else {
      job = (async () => {
        const catalog = await content.catalog(lang);
        const deck = await buildTopicDeck({ pkg, lang, textbooks: catalog.textbooks ?? [], assets });
        return format === 'pdf' ? renderDeckPdf(deck) : renderPptx(deck);
      })();
      job.catch(() => cache.delete(key)); // never cache a failure
    }
    cache.set(key, job);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);

    const body = await job;
    reply.header('Cache-Control', 'private, max-age=3600').header('Vary', 'Authorization, Accept-Language');
    return { body, contentType: format === 'pdf' ? 'application/pdf' : PPTX, filename: deckFileName(pkg, lang, format) };
  });
}
