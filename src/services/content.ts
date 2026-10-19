/**
 * Read side of content (TZ §9 Catalog): catalog from published builds,
 * localisation with the ky → ru → en chain, multilingual search, licence and
 * demo checks. Published data is cached in-process and invalidated on publish
 * (other instances pick it up after CACHE_TTL_MS).
 */
import {
  LANGS,
  filterTextbookTopics,
  summarizeTopic,
  t,
  topicConcepts,
  type Catalog,
  type ContentPackage,
  type Lang,
  type Localized,
  type Textbook,
} from '@bilig/content-model';
import type { SearchHit } from '@bilig/content-model/api';
import { grantFor, type Principal } from '@bilig/permissions';
import { localizeDeep } from '../domain/lang.js';
import type { PublishedRec, Repository } from '../repo/types.js';
import type { AuthCtx } from '../http/auth-context.js';
import type { Clock } from './clock.js';
import { PublishingService } from './publishing.js';

const CACHE_TTL_MS = 30_000;

interface Snapshot {
  at: number;
  base: Omit<Catalog, 'topics' | 'textbooks'>;
  /** v0.5.0: lessons list published topics only. */
  textbooks: Textbook[];
  published: Map<string, PublishedRec>;
  topics: Catalog['topics'];
  index: SearchDoc[];
}

interface SearchDoc {
  kind: 'topic' | 'concept';
  key: string;
  topicKey?: string;
  subjectKey: string;
  title: Localized;
  /** Lower-cased searchable fields per weight. */
  titleText: string;
  bodyText: string;
  snippet: Localized;
}

const norm = (s: string) => s.toLocaleLowerCase().normalize('NFC');
const allLangs = (v: Partial<Localized> | undefined) => (v ? LANGS.map((l) => v[l] ?? '').join(' \u0001 ') : '');

export class ContentService {
  private snap: Snapshot | null = null;
  readonly publishing: PublishingService;

  constructor(
    private repo: Repository,
    private clock: Clock,
    urls: { publicUrl: string; cdnBaseUrl?: string },
  ) {
    this.publishing = new PublishingService(repo, clock, urls);
  }

  invalidate() {
    this.snap = null;
  }

  private async snapshot(): Promise<Snapshot> {
    const now = this.clock.now().getTime();
    if (this.snap && now - this.snap.at < CACHE_TTL_MS) return this.snap;
    const all = async <K extends 'group' | 'subject' | 'course' | 'unit' | 'textbook'>(k: K) =>
      (await this.repo.content(k).list({}, { limit: 100_000 })).items.map((r) => r.data);
    const [groups, subjects, courses, units, textbooks, published] = await Promise.all([
      all('group'),
      all('subject'),
      all('course'),
      all('unit'),
      all('textbook'),
      this.repo.listPublished(),
    ]);
    const map = new Map(published.map((p) => [p.topic.key, p]));
    const topics = published.map((p) => ({ ...summarizeTopic(p.build.pkg), status: 'published' as const, demo: p.topic.demo }));
    this.snap = {
      at: now,
      base: {
        groups: [...groups].sort((a, b) => a.order - b.order),
        subjects: [...subjects].sort((a, b) => a.order - b.order),
        courses: [...courses].sort((a, b) => a.grade - b.grade || a.key.localeCompare(b.key)),
        units: [...units].sort((a, b) => a.order - b.order),
      },
      textbooks: [...textbooks]
        .sort((a, b) => a.order - b.order || a.grade - b.grade || a.key.localeCompare(b.key))
        .map((tb) => filterTextbookTopics(tb, (k) => map.has(k))),
      published: map,
      topics,
      index: buildIndex(published.map((p) => p.build.pkg)),
    };
    return this.snap;
  }

  async catalog(lang: Lang): Promise<Catalog> {
    const s = await this.snapshot();
    return localizeDeep({ ...s.base, topics: s.topics, textbooks: s.textbooks }, lang);
  }

  /**
   * v0.5.0 (КТП): every published package, the textbooks (all languages, lessons
   * list published topics only) and the subject keys — topic matching and lesson plans.
   */
  async ktpSources(): Promise<{ packages: ContentPackage[]; textbooks: Textbook[]; subjectKeys: Set<string> }> {
    const s = await this.snapshot();
    return {
      packages: [...s.published.values()].map((p) => p.build.pkg),
      textbooks: s.textbooks,
      subjectKeys: new Set(s.base.subjects.map((x) => x.key)),
    };
  }

  async getPublished(topicKey: string): Promise<PublishedRec | null> {
    return (await this.snapshot()).published.get(topicKey) ?? null;
  }

  /** The published topic whose current build has this package hash (CDN stand-in lookups). */
  async getPublishedByHash(hash: string): Promise<PublishedRec | null> {
    for (const p of (await this.snapshot()).published.values()) if (p.build.manifest.hash === hash) return p;
    return null;
  }

  /**
   * Licence / demo gate for a topic package (TZ §2): demo topics are open to
   * everyone; others need `topic.view` plus an active school licence covering
   * the subject and grade. Content staff and platform admins bypass licences.
   */
  async canOpen(auth: AuthCtx, pub: PublishedRec): Promise<'ok' | 'unauthorized' | 'forbidden'> {
    if (pub.topic.demo) return 'ok';
    const p: Principal = auth.principal;
    if (grantFor(p, 'topic.view') === false) return auth.user ? 'forbidden' : 'unauthorized';
    if (auth.grants.some((g) => g.role === 'superadmin' || g.role === 'author' || g.role === 'editor')) return 'ok';
    const schoolIds = new Set<string>();
    for (const g of auth.grants) {
      if (g.scope === 'school' && g.scopeId) schoolIds.add(g.scopeId);
      if (g.scope === 'class' && g.scopeId) {
        const c = await this.repo.getClass(g.scopeId);
        if (c) schoolIds.add(c.schoolId);
      }
    }
    if (!schoolIds.size) return 'forbidden';
    const now = this.clock.now();
    const grade = pub.build.pkg.course?.grade;
    const subject = pub.topic.subjectKey;
    const licenses = (await this.repo.listLicenses({ schoolIds: [...schoolIds] }, { limit: 1000 })).items;
    const ok = licenses.some(
      (l) => l.startsAt <= now && now < l.endsAt && l.subjects.includes(subject) && (grade === undefined || l.grades.includes(grade)),
    );
    if (!ok) return 'forbidden';
    const schools = await Promise.all([...schoolIds].map((id) => this.repo.getSchool(id)));
    return schools.some((s) => s?.status === 'active') ? 'ok' : 'forbidden';
  }

  /** Search topics and concepts in all languages; titles localised to `lang`. */
  async search(q: string, lang: Lang, kind?: 'topic' | 'concept', limit = 20): Promise<SearchHit[]> {
    const s = await this.snapshot();
    const terms = norm(q).split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const hits: SearchHit[] = [];
    for (const d of s.index) {
      if (kind && d.kind !== kind) continue;
      let score = 0;
      for (const term of terms) {
        const inTitle = d.titleText.includes(term);
        const inBody = d.bodyText.includes(term) || d.key.includes(term);
        if (!inTitle && !inBody) {
          score = 0;
          break;
        }
        const prefix = d.titleText.split(/[\s\u0001,.()-]+/).some((w) => w.startsWith(term));
        score += (inTitle ? 3 : 0) + (prefix ? 2 : 0) + (inBody ? 1 : 0);
      }
      if (score > 0) {
        if (d.kind === 'topic') score += 0.5;
        hits.push({
          kind: d.kind,
          key: d.key,
          ...(d.topicKey ? { topicKey: d.topicKey } : {}),
          subjectKey: d.subjectKey,
          title: t(d.title, lang),
          snippet: t(d.snippet, lang).slice(0, 160),
          score,
        });
      }
    }
    return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
  }
}

function buildIndex(pkgs: ContentPackage[]): SearchDoc[] {
  const out: SearchDoc[] = [];
  const seenConcepts = new Set<string>();
  for (const pkg of pkgs) {
    const tp = pkg.topic;
    out.push({
      kind: 'topic',
      key: tp.key,
      subjectKey: pkg.subject.key,
      title: tp.title,
      titleText: norm(allLangs(tp.title) + ' ' + (tp.formula ?? '')),
      bodyText: norm([allLangs(tp.description), allLangs(tp.classification), allLangs(tp.goal)].join(' ')),
      snippet: tp.description,
    });
    for (const c of topicConcepts(pkg)) {
      if (seenConcepts.has(c.key)) continue;
      seenConcepts.add(c.key);
      out.push({
        kind: 'concept',
        key: c.key,
        topicKey: tp.key,
        subjectKey: pkg.subject.key,
        title: c.title,
        titleText: norm(allLangs(c.title)),
        bodyText: norm([allLangs(c.subtitle), allLangs(c.description)].join(' ')),
        snippet: c.subtitle ?? c.description,
      });
    }
  }
  return out;
}
