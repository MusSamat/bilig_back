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
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { t, type Lang } from '@bilig/content-model';
import { SSE_CONTENT_TYPE, encodeSseEvent, type TutorAskResponse, type TutorStreamEvent } from '@bilig/content-model/api';
import { newId } from '../ids.js';
import type { Deps } from '../deps.js';
import { route } from '../http/route.js';
import { fail } from '../http/errors.js';
import type { AuthCtx } from '../http/auth-context.js';
import { detectLang } from '../domain/lang.js';
import { maskPii } from '../domain/masking.js';
import { CitationParser, buildSystemPrompt, looksLikeInjection, refusalText, stopTopicHit, wrapQuestion } from '../domain/tutor.js';
import type { ProviderChunk, ProviderMessage } from '../services/tutor-provider.js';
import { getTutorSettings } from '../services/tutor-settings.js';

const MAX_TOKENS = 700;
const HISTORY_MESSAGES = 8;
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

export function registerTutor(app: FastifyInstance, deps: Deps) {
  const { repo, limiter, clock, content, config } = deps;

  route(app, deps, 'tutorAsk', async ({ req, reply, auth, body, ip }) => {
    const settings = await getTutorSettings(repo, config);
    const provider = deps.tutor;
    if (!provider || !settings.enabled) fail('tutor_unavailable', { detail: 'offline' });
    const now = clock.now();

    // --- limits -----------------------------------------------------------------
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
    const masked = maskPii(body.question, await knownNames(deps, auth));
    const focus = body.conceptKey ? pkg.concepts.find((c) => c.key === body.conceptKey) : undefined;
    const validKeys = new Set(pkg.concepts.map((c) => c.key));
    const wantsJson = String(req.headers.accept ?? '').includes('application/json');

    const record = async (answer: string, citations: string[], tokens: { inputTokens: number; outputTokens: number }, flagged: boolean) => {
      const base = { threadId, topicKey: body.topicKey, schoolId, createdAt: clock.now() };
      await repo.addTutorMessage({ ...base, id: newId(), role: 'user', text: masked, citations: [], inputTokens: tokens.inputTokens, outputTokens: 0, flagged });
      await repo.addTutorMessage({ ...base, id: newId(), role: 'assistant', text: answer, citations, inputTokens: 0, outputTokens: tokens.outputTokens, flagged });
    };

    // --- refusals without calling the provider ------------------------------------------
    const stop = stopTopicHit(masked, settings.stopTopics);
    if (stop || looksLikeInjection(body.question)) {
      const answer = refusalText(lang, stop ? 'stop_topic' : 'injection');
      await record(answer, [], { inputTokens: 0, outputTokens: 0 }, true);
      const res: TutorAskResponse = { answer, citations: [], threadId };
      if (wantsJson) return res;
      return sendSse(reply, [{ type: 'token', text: answer }, { type: 'done', threadId, usage: { inputTokens: 0, outputTokens: 0 } }]) as never;
    }

    // History comes from the server-side thread (already masked), never from client text.
    const history = (await repo.listTutorMessages({ threadId, limit: HISTORY_MESSAGES })).map<ProviderMessage>((m) => ({ role: m.role, text: m.text }));
    const messages: ProviderMessage[] = [...history, { role: 'user', text: wrapQuestion(masked, focus ? t(focus.title, lang) : undefined, focus?.key) }];
    const system = buildSystemPrompt(pkg, lang, settings.systemPrompts[lang]);

    const abort = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) abort.abort();
    });
    const iter = provider.stream({ model: settings.model, system, messages, maxTokens: MAX_TOKENS, signal: abort.signal })[Symbol.asyncIterator]();

    // Pull the first chunk before committing to a 200, so a dead provider → 503 problem (client goes offline).
    let first: IteratorResult<ProviderChunk>;
    try {
      first = await iter.next();
    } catch {
      fail('tutor_unavailable', { detail: 'provider_error' });
    }

    const parser = new CitationParser(validKeys);
    const usage = { inputTokens: 0, outputTokens: 0 };
    let refused = false;
    let failed = false;
    const consume = (c: ProviderChunk) => {
      if (c.type === 'text') return parser.push(c.text);
      if (c.type === 'usage') {
        usage.inputTokens += c.inputTokens;
        usage.outputTokens += c.outputTokens;
      } else if (c.type === 'refusal') refused = true;
      return [];
    };
    const finish = async (tail: ReturnType<CitationParser['end']>) => {
      void tail;
      await limiter.add(budgetKey(clock.now()), usage.inputTokens + usage.outputTokens, 2 * 86400);
      const answer = refused && !parser.answer.trim() ? refusalText(lang, 'refused') : parser.answer.trim();
      await record(answer, parser.citations, usage, refused || failed || parser.noAnswer);
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
      return { answer, citations: parser.citations, threadId };
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
    write({ type: 'done', threadId, usage });
    raw.end();
    return reply as never;
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
