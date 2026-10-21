/**
 * POST /tutor/ask (TZ W-32, §6, §10): SSE stream of token / citation / done
 * events, or one JSON body with `Accept: application/json`.
 *
 * Safety & cost controls, in order: provider configured and enabled (else 503
 * → client falls back to its offline index), per-IP / per-role / per-school
 * limits (429), daily token budget (503 when spent — automatic offline mode),
 * licence gate, PII masking (names, phones, e-mails), stop topics and an
 * injection heuristic (refused without calling the LLM). Context is built
 * server-side from the PUBLISHED package only; no user ids leave the server.
 *
 * v0.4.0: the context envelope (what is on screen + a selected quote + a
 * quick-action intent), follow-up `suggestions` after an off-topic question,
 * POST /tutor/generate (examples / practice questions from a reviewed pool,
 * topped up by the model) and teacher feedback on generated items.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { suggestQuestions, t, topicConcepts, type ContentPackage, type DraftExample, type DraftQuizItem, type Lang } from '@bilig/content-model';
import {
  SSE_CONTENT_TYPE,
  encodeSseEvent,
  type GeneratedExample,
  type GeneratedQuizItem,
  type TutorAskResponse,
  type TutorContext,
  type TutorSettings,
  type TutorStreamEvent,
} from '@bilig/content-model/api';
import type { FastifyRequest } from 'fastify';
import { newId } from '../ids.js';
import type { Deps } from '../deps.js';
import { route } from '../http/route.js';
import { fail } from '../http/errors.js';
import type { AuthCtx } from '../http/auth-context.js';
import { detectLang } from '../domain/lang.js';
import { maskPii } from '../domain/masking.js';
import { CitationParser, buildSystemPrompt, looksLikeInjection, refusalText, stopTopicHit, wrapQuestion, type QuestionContext } from '../domain/tutor.js';
import { buildGeneratePrompt, generateSchema, payloadLine, payloadSignature, suitsGrade, validateGenerated, type GenKind } from '../domain/generate.js';
import type { GeneratedRec } from '../repo/types.js';
import type { ProviderChunk, ProviderMessage, ProviderUsage } from '../services/tutor-provider.js';
import { usageCostUsd } from '../config.js';
import { getTutorSettings } from '../services/tutor-settings.js';

/** Answers are 2–4 sentences (≈ 80–200 tokens in ky/ru): the cap stops a runaway answer, output costs 4× input. */
const MAX_TOKENS = 450;
/** Up to 5 short items as JSON (≈ 120–200 tokens each). */
/** Output cap for generation: room for `count` items (a Kyrgyz quiz item is up to ~450 tokens), never more than 1200. */
const generateMaxTokens = (count: number) => Math.min(1200, 150 + 450 * count);
/** Pool rows considered per (topic, concept, kind, language). */
const POOL_SCAN = 500;
/** Votes are counted once per teacher (or IP for guests) per item, for this long. */
const VOTE_TTL_SEC = 90 * 86400;
const HISTORY_MESSAGES = 2;
/** History sent to the model: the latest turns, each trimmed, within a total budget (the question itself is not trimmed). */
const HISTORY_CHARS_PER_MESSAGE = 400;
const HISTORY_CHARS_TOTAL = 1600;

/** The latest turns that fit the budget, oldest first; long ones keep their beginning. */
export function trimHistory(history: ProviderMessage[]): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  let total = 0;
  for (const m of [...history].reverse()) {
    const text = m.text.length > HISTORY_CHARS_PER_MESSAGE ? `${m.text.slice(0, HISTORY_CHARS_PER_MESSAGE)}…` : m.text;
    if (total + text.length > HISTORY_CHARS_TOTAL) break;
    total += text.length;
    out.unshift({ role: m.role, text });
  }
  // The model expects the conversation to start with the user.
  while (out[0]?.role === 'assistant') out.shift();
  return out;
}
export const dayKey = (d: Date) => d.toISOString().slice(0, 10);
export const budgetKey = (d: Date) => `tutor:tokens:${dayKey(d)}`;

async function schoolOf(deps: Deps, auth: AuthCtx): Promise<string | null> {
  const direct = auth.grants.find((g) => g.scope === 'school' && g.scopeId);
  if (direct) return direct.scopeId;
  const cls = auth.grants.find((g) => g.scope === 'class' && g.scopeId);
  if (cls) return (await deps.repo.getClass(cls.scopeId!))?.schoolId ?? null;
  return null;
}

/** Names that must never reach the provider: the asker and the classmates/students they can see. */
async function knownNames(deps: Deps, auth: AuthCtx): Promise<string[]> {
  if (!auth.user) return [];
  const names = [auth.user.displayName];
  const enr = await deps.repo.listEnrollments({ userId: auth.user.id });
  const classIds = enr.map((e) => e.classId).slice(0, 20);
  if (classIds.length) {
    const members = await deps.repo.listEnrollments({ classIds, role: 'student' });
    const users = await deps.repo.getUsers(members.map((m) => m.userId).slice(0, 1000));
    names.push(...users.map((u) => u.displayName));
  }
  return names;
}

/** Per-IP / per-role / per-school limits and the daily token budget, shared by ask and generate. */
async function enforceLimits(deps: Deps, req: FastifyRequest, auth: AuthCtx, ip: string, settings: TutorSettings): Promise<string | null> {
  const { limiter, clock } = deps;
  const now = clock.now();
  const hit = async (key: string, max: number, windowSec: number) => {
    const r = await limiter.hit(key, max, windowSec);
    if (!r.allowed) fail('rate_limited', { retryAfter: r.retryAfter, detail: key.split(':')[1] });
  };
  await hit(`tutor:ip:${ip}`, settings.limits.ipPerHour, 3600);
  if (!auth.user) {
    const ua = String(req.headers['user-agent'] ?? '').slice(0, 200);
    await hit(`tutor:guest:${ip}:${ua.length}`, settings.limits.guestPerHour, 3600);
  } else if (auth.user.kind === 'student') await hit(`tutor:user:${auth.user.id}`, settings.limits.studentPerHour, 3600);
  else await hit(`tutor:user:${auth.user.id}`, settings.limits.adultPerHour, 3600);
  const schoolId = await schoolOf(deps, auth);
  if (schoolId) await hit(`tutor:school:${schoolId}:${dayKey(now)}`, settings.limits.schoolPerDay, 86400);
  if ((await limiter.get(budgetKey(now))) >= settings.dailyTokenBudget) fail('tutor_unavailable', { detail: 'budget_exhausted' });
  return schoolId;
}

/** Resolve the client's context envelope against the package: unknown keys are ignored, titles come from the package. */
export function resolveContext(pkg: ContentPackage, lang: Lang, ctx: TutorContext | undefined, focusKey: string | undefined): Omit<QuestionContext, 'quote' | 'intent'> {
  const focus = focusKey ? topicConcepts(pkg).find((c) => c.key === focusKey) ?? pkg.concepts.find((c) => c.key === focusKey) : undefined;
  const sample = ctx?.sampleKey ? pkg.topic.samples.find((s) => s.key === ctx.sampleKey) : undefined;
  const process = ctx?.processKey ? pkg.processes.find((p) => p.key === ctx.processKey) : undefined;
  const step = process && ctx?.stepIndex !== undefined ? process.steps[ctx.stepIndex] : undefined;
  return {
    ...(focus ? { focus: { key: focus.key, title: t(focus.title, lang) } } : {}),
    ...(sample ? { sample: t(sample.title, lang) } : {}),
    ...(process ? { process: { title: t(process.title, lang), ...(step ? { step: t(step.title, lang) } : {}) } } : {}),
    ...(ctx?.mode ? { mode: ctx.mode } : {}),
  };
}

/** Pool rows that may be shown: approved ones unless heavily reported, new ones until the first report. */
export const servable = (g: GeneratedRec): boolean => (g.status === 'approved' && g.bad < 3) || (g.status === 'new' && g.bad === 0);
/** Approved first, then the best-rated, then the oldest. */
const poolOrder = (a: GeneratedRec, b: GeneratedRec) =>
  Number(b.status === 'approved') - Number(a.status === 'approved') || b.good - b.bad - (a.good - a.bad) || (a.id < b.id ? -1 : 1);

function toExample(g: GeneratedRec): GeneratedExample {
  const p = g.payload as DraftExample;
  return { id: g.id, title: p.title, text: p.text, ...(p.field ? { field: p.field } : {}), ...(p.conceptKey ? { conceptKey: p.conceptKey } : {}), ...(g.status === 'approved' ? { reviewed: true } : {}), ...(p.grades ? { grades: p.grades } : {}) };
}
function toQuiz(g: GeneratedRec): GeneratedQuizItem {
  const p = g.payload as DraftQuizItem;
  return { id: g.id, prompt: p.prompt, options: p.options, answer: p.answer, explanation: p.explanation, ...(p.conceptKey ? { conceptKey: p.conceptKey } : {}), ...(g.status === 'approved' ? { reviewed: true } : {}), ...(p.grades ? { grades: p.grades } : {}) };
}

/**
 * v0.9.1: the pool a card draws from. A concept is often taught in several grades (speed in the 7th
 * and the 8th): its items are shared by every topic on that concept whose grade is in the item's range;
 * a topic-level item stays with its topic. Items without a range stay with the topic they were made for.
 */
function poolFilter(pkg: ContentPackage, conceptKey: string | null, kind: GenKind, lang: Lang) {
  const filter = conceptKey ? { conceptKey, kind, lang } : { topicKey: pkg.topic.key, conceptKey: null, kind, lang };
  const grade = pkg.course?.grade;
  const fits = (g: GeneratedRec) => g.topicKey === pkg.topic.key || suitsGrade((g.payload as DraftExample).grades, grade);
  return { filter, fits };
}

/** A question as the answer cache compares it: case, spacing and the closing punctuation don't matter. */
export const normQuestion = (q: string): string =>
  q
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s?!.…,;:]+$/u, '')
    .trim();

/** Shared-answer key: the topic version (package hash), language, question, quick action and what is on screen. */
function answerKey(pkg: ContentPackage, lang: Lang, question: string, intent: string, screen: Omit<QuestionContext, 'quote' | 'intent'>): string {
  const ctx = [screen.focus?.key ?? '', screen.sample ?? '', screen.process?.title ?? '', screen.process?.step ?? '', screen.mode ?? ''];
  return createHash('sha256').update(JSON.stringify([pkg.topic.key, pkg.manifest.hash, lang, question, intent, ...ctx])).digest('hex');
}

export function registerTutor(app: FastifyInstance, deps: Deps) {
  const { repo, limiter, clock, content, config } = deps;
  /** One line per model call: tokens, how much hit the provider's prompt cache, and the cost. */
  const logUsage = (req: FastifyRequest, purpose: string, topicKey: string, u: ProviderUsage) =>
    req.log.info(
      { purpose, topicKey, inputTokens: u.inputTokens, cachedInputTokens: u.cachedInputTokens ?? 0, outputTokens: u.outputTokens, costUsd: Number(usageCostUsd(u, config.tutorPrices).toFixed(6)) },
      'tutor.usage',
    );

  route(app, deps, 'tutorAsk', async ({ req, reply, auth, body, ip }) => {
    const settings = await getTutorSettings(repo, config);
    const provider = deps.tutor;
    if (!provider || !settings.enabled) fail('tutor_unavailable', { detail: 'offline' });
    const now = clock.now();

    const schoolId = await enforceLimits(deps, req, auth, ip, settings);

    // --- grounding ------------------------------------------------------------------
    const pub = await content.getPublished(body.topicKey);
    if (!pub) fail('not_found', { detail: 'topic' });
    const verdict = await content.canOpen(auth, pub);
    if (verdict !== 'ok') fail(verdict, { detail: 'license_required' });
    const pkg = pub.build.pkg;

    let thread = body.threadId ? await repo.getThread(body.threadId) : null;
    if (body.threadId && (!thread || thread.userId !== (auth.user?.id ?? null) || thread.topicKey !== body.topicKey)) fail('not_found', { detail: 'thread' });
    if (!thread) {
      thread = { id: newId(), userId: auth.user?.id ?? null, topicKey: body.topicKey, createdAt: now };
      await repo.createThread(thread);
    }
    const threadId = thread.id;
    const lang: Lang = detectLang(body.question, body.lang);
    const names = await knownNames(deps, auth);
    const masked = maskPii(body.question, names);
    const rawQuote = body.context?.quote?.text;
    const quote = rawQuote ? maskPii(rawQuote, names) : undefined;
    const intent = body.intent ?? 'ask';
    // The focus is the explicit concept, else the concept the quote came from.
    const focusKey = body.conceptKey ?? body.context?.quote?.conceptKey;
    const screen = resolveContext(pkg, lang, body.context, focusKey);
    const validKeys = new Set(pkg.concepts.map((c) => c.key));
    const wantsJson = String(req.headers.accept ?? '').includes('application/json');
    const suggestions = () => suggestQuestions(pkg, lang, { conceptKey: screen.focus?.key, processKey: body.context?.processKey });

    const record = async (answer: string, citations: string[], tokens: ProviderUsage, flagged: boolean) => {
      const base = { threadId, topicKey: body.topicKey, schoolId, createdAt: clock.now() };
      const userText = quote ? `«${quote}» ${masked}` : masked;
      await repo.addTutorMessage({ ...base, id: newId(), role: 'user', text: userText, citations: [], inputTokens: tokens.inputTokens, cachedTokens: tokens.cachedInputTokens ?? 0, outputTokens: 0, flagged });
      await repo.addTutorMessage({ ...base, id: newId(), role: 'assistant', text: answer, citations, inputTokens: 0, outputTokens: tokens.outputTokens, flagged });
    };

    // --- refusals without calling the provider ------------------------------------------
    const stop = stopTopicHit(masked, settings.stopTopics) ?? (quote ? stopTopicHit(quote, settings.stopTopics) : null);
    if (stop || looksLikeInjection(body.question) || (rawQuote && looksLikeInjection(rawQuote))) {
      const answer = refusalText(lang, stop ? 'stop_topic' : 'injection');
      await record(answer, [], { inputTokens: 0, outputTokens: 0 }, true);
      const items = suggestions();
      const res: TutorAskResponse = { answer, citations: [], threadId, suggestions: items };
      if (wantsJson) return res;
      return sendSse(reply, [{ type: 'token', text: answer }, { type: 'suggestions', items }, { type: 'done', threadId, usage: { inputTokens: 0, outputTokens: 0 } }]) as never;
    }

    // History comes from the server-side thread (already masked), never from client text.
    const history = (await repo.listTutorMessages({ threadId, limit: HISTORY_MESSAGES })).map<ProviderMessage>((m) => ({ role: m.role, text: m.text }));

    // v0.9.1 shared answers: a self-contained question — the first of a thread, or a starter / suggested
    // question (they never depend on history) — with no selection, on the same topic version, language and
    // screen, is answered once for everyone; repeats cost no tokens.
    const asked = normQuestion(masked);
    const isStarter = [...(pkg.topic.starters ?? []).map((s) => t(s, lang)), ...suggestQuestions(pkg, lang, { count: 6 })].some((s) => normQuestion(s) === asked);
    const selfContained = !quote && (history.length === 0 || isStarter);
    const cacheKey = config.tutorAnswerCache && selfContained ? answerKey(pkg, lang, asked, intent, screen) : null;
    const cached = cacheKey ? await repo.getTutorAnswer(cacheKey) : null;
    if (cached && cacheKey) {
      const replay = new CitationParser(validKeys);
      const pieces = [...replay.push(cached.raw), ...replay.end()];
      const answer = replay.answer.trim();
      await repo.hitTutorAnswer(cacheKey);
      await record(answer, replay.citations, { inputTokens: 0, outputTokens: 0 }, false);
      logUsage(req, 'ask.cached', pkg.topic.key, { inputTokens: 0, outputTokens: 0 });
      if (wantsJson) return { answer, citations: replay.citations, threadId };
      const events: TutorStreamEvent[] = pieces.flatMap((p): TutorStreamEvent[] => {
        if (p.type === 'text') return [{ type: 'token', text: p.text }];
        if (p.type !== 'citation') return [];
        const c = pkg.concepts.find((x) => x.key === p.key);
        return [{ type: 'citation', conceptKey: p.key, ...(c ? { label: t(c.title, lang) } : {}) }];
      });
      return sendSse(reply, [...events, { type: 'done', threadId, usage: { inputTokens: 0, outputTokens: 0 } }]) as never;
    }
    const messages: ProviderMessage[] = [...(selfContained ? [] : trimHistory(history)), { role: 'user', text: wrapQuestion(masked, { ...screen, quote, intent }) }];
    const system = buildSystemPrompt(pkg, lang, settings.systemPrompts[lang]);
    const grounding = { pkg, lang, question: masked, intent, ...(screen.focus ? { conceptKey: screen.focus.key } : {}), ...(quote ? { quote } : {}) };

    const abort = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) abort.abort();
    });
    const iter = provider.stream({ model: settings.model, system, messages, maxTokens: MAX_TOKENS, signal: abort.signal, grounding })[Symbol.asyncIterator]();

    // Pull the first chunk before committing to a 200, so a dead provider → 503 problem (client goes offline).
    let first: IteratorResult<ProviderChunk>;
    try {
      first = await iter.next();
    } catch {
      fail('tutor_unavailable', { detail: 'provider_error' });
    }

    const parser = new CitationParser(validKeys);
    const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    let refused = false;
    let failed = false;
    let modelText = '';
    const consume = (c: ProviderChunk) => {
      if (c.type === 'text') {
        modelText += c.text;
        return parser.push(c.text);
      }
      if (c.type === 'usage') {
        usage.inputTokens += c.inputTokens;
        usage.outputTokens += c.outputTokens;
        usage.cachedInputTokens += c.cachedInputTokens ?? 0;
      } else if (c.type === 'refusal') refused = true;
      return [];
    };
    const finish = async (tail: ReturnType<CitationParser['end']>) => {
      void tail;
      await limiter.add(budgetKey(clock.now()), usage.inputTokens + usage.outputTokens, 2 * 86400);
      logUsage(req, 'ask', pkg.topic.key, usage);
      const answer = refused && !parser.answer.trim() ? refusalText(lang, 'refused') : parser.answer.trim();
      const flagged = refused || failed || parser.noAnswer;
      await record(answer, parser.citations, usage, flagged);
      // Only a complete, grounded answer is shared (never a refusal, an off-topic reply or a cut-off stream).
      if (cacheKey && !flagged && answer) await repo.putTutorAnswer({ key: cacheKey, topicKey: pkg.topic.key, lang, raw: modelText, hits: 0, createdAt: clock.now() });
      return answer;
    };

    if (wantsJson) {
      try {
        if (!first.done) consume(first.value);
        for (let r = await iter.next(); !r.done; r = await iter.next()) consume(r.value);
      } catch {
        failed = true;
      }
      const answer = await finish(parser.end());
      if (failed && !answer) fail('tutor_unavailable', { detail: 'provider_error' });
      return { answer, citations: parser.citations, threadId, ...(parser.noAnswer || refused ? { suggestions: suggestions() } : {}) };
    }

    // SSE: hijack and stream frames as they arrive.
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      'content-type': `${SSE_CONTENT_TYPE}; charset=utf-8`,
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    });
    const write = (ev: TutorStreamEvent) => raw.write(encodeSseEvent(ev));
    const emit = (pieces: ReturnType<CitationParser['push']>) => {
      for (const p of pieces) {
        if (p.type === 'text') write({ type: 'token', text: p.text });
        else if (p.type === 'citation') {
          const c = pkg.concepts.find((x) => x.key === p.key);
          write({ type: 'citation', conceptKey: p.key, ...(c ? { label: t(c.title, lang) } : {}) });
        }
      }
    };
    try {
      if (!first.done) emit(consume(first.value));
      for (let r = await iter.next(); !r.done; r = await iter.next()) emit(consume(r.value));
    } catch {
      failed = true;
    }
    const tail = parser.end();
    emit(tail);
    const hadText = parser.answer.trim().length > 0;
    const answer = await finish(tail);
    if (refused && !hadText) write({ type: 'token', text: answer });
    if (failed) write({ type: 'error', code: 'tutor_unavailable', i18nKey: 'errors.tutor_unavailable' });
    else if (parser.noAnswer || refused) write({ type: 'suggestions', items: suggestions() });
    write({ type: 'done', threadId, usage });
    raw.end();
    return reply as never;
  });

  // --- v0.4.0: «Ещё примеры» / «Ещё вопросы» --------------------------------------------
  route(app, deps, 'tutorGenerate', async ({ req, auth, body, ip }) => {
    const settings = await getTutorSettings(repo, config);
    const provider = deps.tutor;
    if (!provider || !settings.enabled) fail('tutor_unavailable', { detail: 'offline' });
    await enforceLimits(deps, req, auth, ip, settings);

    const pub = await content.getPublished(body.topicKey);
    if (!pub) fail('not_found', { detail: 'topic' });
    const verdict = await content.canOpen(auth, pub);
    if (verdict !== 'ok') fail(verdict, { detail: 'license_required' });
    const pkg = pub.build.pkg;
    const kind = body.kind as GenKind;
    const focus = body.conceptKey ? topicConcepts(pkg).find((c) => c.key === body.conceptKey) : undefined;
    if (body.conceptKey && !focus) fail('not_found', { detail: 'concept' });
    const conceptKey = focus?.key ?? null;
    const lang = body.lang;
    const want = body.count;
    const exclude = new Set(body.exclude);

    // 1. The pool: reviewed and well-rated items first; nothing already on screen, and (v0.9.1)
    //    nothing this user already got — the model is asked only when every pooled item was seen.
    const { filter, fits } = poolFilter(pkg, conceptKey, kind, lang);
    // Every grade's items count as «do not repeat»; only the ones that suit this grade are served.
    const all = (await repo.listGenerated(filter, { limit: POOL_SCAN })).items;
    const uid = auth.user?.id ?? null;
    const seen = new Set(uid ? (await repo.listSeenGenerated(uid, filter, POOL_SCAN)).map((g) => g.id) : []);
    const picked = all.filter((g) => fits(g) && servable(g) && !exclude.has(g.id) && !seen.has(g.id)).sort(poolOrder).slice(0, want);

    // 2. Top up from the model. Everything in the pool (dismissed included) and on the card is «avoid».
    let fresh: GeneratedRec[] = [];
    if (picked.length < want) {
      const need = want - picked.length;
      const avoidSigs = new Set(all.map((g) => g.signature));
      const shown = focus ? focus.examples : pkg.topic.examples;
      const authored = kind === 'quiz' ? [] : [...shown.simple, ...shown.stem].map((e) => ({ title: t(e.title, lang), text: t(e.text, lang) }));
      for (const e of authored) avoidSigs.add(payloadSignature('simple', e));
      const avoidLines = [...all.map((g) => payloadLine(kind, g.payload as DraftExample)), ...authored.map((e) => payloadLine('simple', e))];
      try {
        const res = await provider.generate({
          model: settings.model,
          // The chat's own system prompt: chat and generation share one cached prefix per topic + language.
          system: buildSystemPrompt(pkg, lang, settings.systemPrompts[lang]),
          prompt: buildGeneratePrompt(kind, lang, need, focus, pkg, avoidLines),
          schema: generateSchema(kind),
          maxTokens: generateMaxTokens(need),
          grounding: { pkg, lang, kind, count: need, avoid: [...avoidSigs], ...(conceptKey ? { conceptKey } : {}) },
        });
        await limiter.add(budgetKey(clock.now()), res.usage.inputTokens + res.usage.outputTokens, 2 * 86400);
        logUsage(req, `generate.${kind}`, pkg.topic.key, res.usage);
        const v = validateGenerated(kind, res.data, new Set(pkg.concepts.map((c) => c.key)), avoidSigs, need, lang, pkg.course?.grade);
        if (v.rejected) req.log.warn({ kind, topicKey: pkg.topic.key, rejected: v.rejected }, 'tutor.generate: items rejected by validation');
        const now = clock.now();
        fresh = [...v.examples, ...v.quiz].map((payload) => ({
          id: newId(),
          kind,
          topicKey: pkg.topic.key,
          conceptKey,
          lang,
          payload,
          signature: payloadSignature(kind, payload),
          status: 'new' as const,
          good: 0,
          bad: 0,
          reasons: {},
          served: 0,
          createdAt: now,
          reviewedAt: null,
          reviewedBy: null,
          promotedTo: null,
        }));
        await repo.addGenerated(fresh);
      } catch (err) {
        // A dead provider still serves the pool; with nothing to show, the client goes offline.
        req.log.warn({ err }, 'tutor.generate: provider failed');
        if (!picked.length) fail('tutor_unavailable', { detail: 'provider_error' });
      }
    }

    const out = [...picked, ...fresh];
    await repo.countGenerated(out.map((g) => g.id), { served: 1 });
    if (uid) await repo.markGeneratedSeen(uid, out.map((g) => g.id), clock.now());
    return {
      kind,
      lang,
      examples: kind === 'quiz' ? [] : out.map(toExample),
      quiz: kind === 'quiz' ? out.map(toQuiz) : [],
      exhausted: out.length < want,
    };
  });

  // v0.9.1: what this user already got for a card — shown again after a reload. Read only and
  // free (no model call), so it works while the assistant is switched off.
  route(app, deps, 'tutorGeneratedSeen', async ({ auth, query }) => {
    const pub = await content.getPublished(query.topicKey);
    if (!pub) fail('not_found', { detail: 'topic' });
    const verdict = await content.canOpen(auth, pub);
    if (verdict !== 'ok') fail(verdict, { detail: 'license_required' });
    const kind = query.kind as GenKind;
    const { filter, fits } = poolFilter(pub.build.pkg, query.conceptKey ?? null, kind, query.lang);
    const uid = auth.user?.id ?? null;
    const mine = uid ? (await repo.listSeenGenerated(uid, filter, POOL_SCAN)).filter((g) => fits(g) && servable(g)) : [];
    const ids = new Set(mine.map((g) => g.id));
    const unseen = uid ? (await repo.listGenerated(filter, { limit: POOL_SCAN })).items.filter((g) => fits(g) && servable(g) && !ids.has(g.id)).length : 0;
    return {
      kind,
      lang: query.lang,
      examples: kind === 'quiz' ? [] : mine.map(toExample),
      quiz: kind === 'quiz' ? mine.map(toQuiz) : [],
      unseen,
    };
  });

  route(app, deps, 'tutorGeneratedFeedback', async ({ auth, body, params, ip }) => {
    const g = await repo.getGenerated(params.id);
    if (!g) fail('not_found', { detail: 'generated' });
    // One vote per teacher (or IP for guests) per item; repeats are accepted and ignored.
    const who = auth.user ? `u:${auth.user.id}` : `ip:${ip}`;
    const first = await limiter.hit(`tutor:vote:${g.id}:${who}`, 1, VOTE_TTL_SEC);
    if (first.allowed) {
      await limiter.hit(`tutor:votes:${ip}`, 200, 3600).then((r) => {
        if (!r.allowed) fail('rate_limited', { retryAfter: r.retryAfter, detail: 'votes' });
      });
      await repo.countGenerated([g.id], body.vote === 'good' ? { good: 1 } : { bad: 1, reason: body.reason });
    }
    return { ok: true as const };
  });
}

function sendSse(reply: FastifyReply, events: TutorStreamEvent[]) {
  reply.hijack();
  reply.raw.writeHead(200, {
    ...(reply.getHeaders() as Record<string, string>),
    'content-type': `${SSE_CONTENT_TYPE}; charset=utf-8`,
    'cache-control': 'no-cache, no-transform',
  });
  reply.raw.end(events.map(encodeSseEvent).join(''));
  return reply;
}
