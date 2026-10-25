/**
 * v0.10.0: the teacher cabinet v3 — the school calendar, scheduling a КТП on the teacher's lesson days,
 * a КТП from the subject standard, the lesson pages (content, «conducted», the assistant, the slides) and
 * the «Сегодня» agenda. Owner-only like КТП: another user's plan is 404. Lesson content lives in its own
 * table, so saving a lesson never bumps the plan version.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DEFAULT_LESSON_MODEL, lessonModel, t, type Lang, type Textbook } from '@bilig/content-model';
import {
  AGENDA_MAX_DAYS,
  SCHOOL_WEEKS,
  dateOf,
  isoOf,
  schoolCalendar,
  schoolYearOfIso,
  type AgendaLesson,
  type AttentionItem,
  type LessonAssistResponse,
} from '@bilig/content-model/api';
import type { Deps } from '../deps.js';
import { fail } from '../http/errors.js';
import { route } from '../http/route.js';
import type { ClassRec, TeachingPlanRec } from '../repo/types.js';
import type { GenerateRequest } from '../services/tutor-provider.js';
import { ktpClass, planDocOf, recheck, toTeachingPlan, type PlanDoc } from '../ktp/teaching-plan.js';
import { scheduleRows, settleHours, withoutDraftMark } from '../ktp/schedule.js';
import { emptyLessonBody, lessonBodyIssues, lessonBodyOf, toLessonContent } from '../ktp/lesson-content.js';
import { renderLessonSlides } from '../ktp/lesson-slides.js';
import { ASK_SCHEMA, ASSIST_SYSTEM, DRAFT_SCHEMA, MATERIALS_SCHEMA, STANDARD_SCHEMA, answerOf, askPrompt, draftOf, draftPrompt, materialsOf, materialsPrompt, standardOf, standardPrompt, type LessonContext } from '../ktp/assist.js';
import { buildTopicIndex, matchTitle } from '../ktp/match.js';
import { getTutorSettings } from '../services/tutor-settings.js';
import { taughtClasses } from '../services/profile.js';
import { usageCostUsd } from '../config.js';
import { budgetKey } from './tutor.js';
import { assignmentSummaries, localDate } from './classes.js';
import { KTP_CONTENTS_PER_HOUR, createBookPlan } from './ktp.js';

/** Topic lessons of a КТП from the standard: the year's hours less 4 СОЧ and 2 СОР a quarter (at least 60 %). */
export const standardLessons = (hours: number) => Math.max(Math.ceil(hours * 0.6), hours - 4 - 2 * 4);

/** Assistant requests per teacher and hour (lesson pages). */
export const LESSON_ASSIST_PER_HOUR = 30;
/** «Требует внимания»: assignments due from 3 days ago to 3 days ahead. */
export const ASSIGNMENT_DUE_DAYS = 3;
const ASSIST_MAX_TOKENS = { materials: 1800, ask: 900, draft: 3000 } as const;
const PPTX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const LIST_PAGE = 200;

const addDays = (iso: string, n: number) => {
  const d = dateOf(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return isoOf(d);
};
const fmtDate = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '');
const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 60) || 'lesson';
const STANDARD_NAME: Record<Lang, string> = { ky: 'Предметтик стандарт', ru: 'Предметный стандарт', en: 'Subject standard' };
const LAB_WORD: Record<Lang, string> = { ky: 'Лабораториялык иш', ru: 'Лабораторная работа', en: 'Lab work' };
const LAB_RE = /лаборатор|lab(oratory)? work|практикалык иш|практическая работа/i;

export function registerCabinet(app: FastifyInstance, deps: Deps) {
  const { repo, clock, content, limiter, audit, config } = deps;

  /** Today in Asia/Bishkek. */
  const today = () => localDate(clock.now());

  async function own(uid: string, id: string): Promise<TeachingPlanRec & { doc: PlanDoc }> {
    const p = /^[0-9a-f-]{36}$/i.test(id) ? await repo.getTeachingPlan(id) : null;
    if (!p || p.ownerId !== uid) fail('not_found', { detail: 'teaching_plan' });
    return { ...p, doc: planDocOf(p) };
  }

  function rowOf(doc: PlanDoc, uid: string) {
    const row = doc.rows.find((r) => r.uid === uid);
    if (!row) fail('not_found', { detail: 'lesson' });
    return row!;
  }

  function classOf(doc: PlanDoc, asked: string): string {
    const cls = ktpClass(asked);
    if (!doc.classes.includes(cls)) fail('validation_failed', { detail: `class must be one of: ${doc.classes.join(', ')}`, issues: [{ path: ['class'], message: 'Not a class of this КТП' }] });
    return cls;
  }

  /** One model call of the cabinet: the tutor's provider, settings and daily budget (503 when offline or spent). */
  async function generate(req: FastifyRequest, purpose: string, call: Omit<GenerateRequest, 'model'>): Promise<unknown> {
    const settings = await getTutorSettings(repo, config);
    const provider = deps.tutor;
    if (!provider || !settings.enabled || provider.name === 'dev') fail('tutor_unavailable', { detail: 'offline' });
    if ((await limiter.get(budgetKey(clock.now()))) >= settings.dailyTokenBudget) fail('tutor_unavailable', { detail: 'budget_exhausted' });
    try {
      const res = await provider!.generate({ ...call, model: settings.model });
      await limiter.add(budgetKey(clock.now()), res.usage.inputTokens + res.usage.outputTokens, 2 * 86400);
      req.log.info({ purpose, inputTokens: res.usage.inputTokens, cachedInputTokens: res.usage.cachedInputTokens ?? 0, outputTokens: res.usage.outputTokens, costUsd: Number(usageCostUsd(res.usage, config.tutorPrices).toFixed(6)) }, 'tutor.usage');
      return res.data;
    } catch (err) {
      req.log.warn({ err }, `${purpose}: provider failed`);
      fail('tutor_unavailable', { detail: 'provider_error' });
    }
  }

  /** Every plan of a teacher (the list pages through). */
  async function allPlans(ownerId: string): Promise<TeachingPlanRec[]> {
    const out: TeachingPlanRec[] = [];
    let cursor: string | undefined;
    do {
      const res = await repo.listTeachingPlans(ownerId, { limit: LIST_PAGE, ...(cursor ? { cursor } : {}) });
      out.push(...res.items);
      cursor = res.nextCursor ?? undefined;
    } while (cursor);
    return out;
  }

  // --- calendar and scheduling ----------------------------------------------------------

  // GET /calendar?year= — the school calendar (default: the current school year in Bishkek).
  route(app, deps, 'calendar', ({ query }) => schoolCalendar(query.year ?? schoolYearOfIso(today())));

  // POST /ktp/:id/schedule — the dates of a class column from its lesson days.
  route(app, deps, 'ktpSchedule', async ({ userId, params, body, ifMatch, ip }) => {
    const uid = userId();
    const cur = await own(uid, params.id);
    if (ifMatch !== body.version || cur.version !== ifMatch) fail('version_mismatch', { detail: `current version is ${cur.version}` });
    const cls = classOf(cur.doc, body.class);
    const cal = schoolCalendar(cur.doc.year ?? schoolYearOfIso(today()));
    const scheduled = scheduleRows(cur.doc.rows, cal, { cls, classes: cur.doc.classes, weekdays: body.weekdays, mode: body.mode, ...(body.from ? { from: body.from } : {}), assessments: body.assessments ?? false, lang: cur.doc.lang });
    const { rows, declaredHours } = settleHours(scheduled);
    // Impossible dates (kept by row index) follow their rows; those of the scheduled class are replaced.
    const oldIndex = new Map(cur.doc.rows.map((r) => [r.uid, String(r.index)]));
    const invalidDates: PlanDoc['invalidDates'] = {};
    for (const r of rows) {
      const old = oldIndex.get(r.uid);
      const inv = old ? cur.doc.invalidDates[old] : undefined;
      if (!inv) continue;
      const { [cls]: _replaced, ...others } = inv;
      if (Object.keys(others).length) invalidDates[String(r.index)] = others;
    }
    const { issues: _i, totalHours: _t, ...rest } = cur.doc;
    const title = withoutDraftMark(rest.title);
    const doc = recheck({ ...rest, title, declaredHours, year: rest.year ?? cal.year, rows, invalidDates, schedule: { ...(rest.schedule ?? {}), [cls]: body.weekdays } });
    const res = await repo.updateTeachingPlan(cur.id, { doc, title: withoutDraftMark(cur.title) }, ifMatch);
    if (res === 'not_found') fail('not_found', { detail: 'teaching_plan' });
    if (res === 'version_mismatch') fail('version_mismatch');
    await audit.log(uid, 'ktp.updated', { type: 'teaching_plan', id: cur.id, label: res.title }, {
      ip,
      after: { schedule: true, class: cls, weekdays: body.weekdays, mode: body.mode, assessments: !!body.assessments, lessons: rows.length, version: res.version },
    });
    return toTeachingPlan(res);
  });

  // POST /ktp/from-standard — a КТП without a textbook: the assistant drafts the chapters from the standard.
  route(app, deps, 'ktpFromStandard', async ({ req, auth, userId, body, ip }) => {
    const uid = userId();
    const r = await limiter.hit(`ktp-contents:${uid}`, KTP_CONTENTS_PER_HOUR, 3600);
    if (!r.allowed) fail('rate_limited', { retryAfter: r.retryAfter });
    const lang = body.lang ?? 'ky';
    const src = await content.ktpSources();
    if (!src.subjectKeys.has(body.subjectKey)) fail('validation_failed', { detail: 'subjectKey', issues: [{ path: ['subjectKey'], message: 'Unknown subject' }] });
    const subject = (await content.catalog(lang)).subjects.find((s) => s.key === body.subjectKey);
    const subjectName = subject ? (typeof subject.title === 'string' ? subject.title : t(subject.title, lang)) : body.subjectKey;
    // Topic lessons leave room for the assessments scheduling adds: a СОЧ and up to two СОР a quarter.
    const lessons = standardLessons(body.hoursPerWeek * (body.weeks ?? SCHOOL_WEEKS));
    const data = await generate(req, 'ktp.standard', { system: ASSIST_SYSTEM, prompt: standardPrompt({ subjectName, grade: body.grade, lang, lessons }), schema: STANDARD_SCHEMA, maxTokens: 8000 });
    const chapters = standardOf(data);
    if (!chapters.length) fail('tutor_unavailable', { detail: 'provider_error' });
    // The drafted chapters → the textbook shape of the from-textbook pipeline (topics matched like a КТП's).
    const index = buildTopicIndex(src.packages, src.textbooks);
    const L = (s: string) => ({ ky: s, ru: s, en: s });
    const book: Pick<Textbook, 'chapters'> & { grade: number | null } = {
      grade: body.grade,
      chapters: chapters.map((c, ci) => {
        let topic: string[] = [];
        return {
          key: `c${ci}`,
          number: String(ci + 1),
          title: L(c.title),
          subjectKey: body.subjectKey,
          lessons: c.lessons.map((l, li) => {
            if (l.kind === 'lesson') topic = [matchTitle(index, l.title, { subjectKey: body.subjectKey, grade: body.grade })?.topicKey].filter((k): k is string => !!k);
            const title = l.kind === 'lab' && !LAB_RE.test(l.title) ? `${LAB_WORD[lang]}: ${l.title}` : l.title;
            // A lab work goes after the lesson of its topic (the one before it).
            return { key: `c${ci}.l${li}`, number: '', kind: l.kind === 'lesson' ? ('lesson' as const) : l.kind === 'lab' ? ('extra' as const) : ('review' as const), title: L(title), topicKeys: l.kind === 'test' ? [] : [...topic] };
          }),
        };
      }),
    };
    const rec = await createBookPlan(deps, {
      ownerId: uid,
      teacherName: auth.user?.displayName ?? '',
      book,
      lang,
      subjectKey: body.subjectKey,
      sourceName: `${STANDARD_NAME[lang]}: ${subjectName}, ${body.grade}`,
      hoursPerWeek: body.hoursPerWeek,
      ...(body.weeks ? { weeks: body.weeks } : {}),
      ...(body.year ? { year: body.year } : {}),
      ...(body.classes ? { classes: body.classes } : {}),
      lessons,
      origin: 'standard',
    });
    await audit.log(uid, 'ktp.created', { type: 'teaching_plan', id: rec.id, label: rec.title }, { ip, diff: { from: `standard:${body.subjectKey}:${body.grade}`, lessons: (rec.doc as PlanDoc).rows.length, hoursPerWeek: body.hoursPerWeek } });
    return toTeachingPlan(rec);
  });

  // --- lesson pages ------------------------------------------------------------------------

  route(app, deps, 'lessonGet', async ({ userId, params }) => {
    const plan = await own(userId(), params.id);
    rowOf(plan.doc, params.uid);
    return toLessonContent(plan.id, params.uid, await repo.getLessonContent(plan.id, params.uid));
  });

  route(app, deps, 'lessonPut', async ({ userId, params, body, ifMatch }) => {
    const uid = userId();
    const plan = await own(uid, params.id);
    rowOf(plan.doc, params.uid);
    const { version, ...doc } = body;
    const issues = lessonBodyIssues(doc);
    if (issues.length) fail('validation_failed', { detail: 'lesson', issues });
    // The version read (body or If-Match): stale → 409; without one the last write wins.
    const expected = version ?? (ifMatch >= 0 ? ifMatch : null);
    const res = await repo.saveLessonContent({ planId: plan.id, uid: params.uid, ownerId: uid }, { doc }, expected);
    if (res === 'version_mismatch') fail('version_mismatch', { detail: 'lesson_content' });
    return toLessonContent(plan.id, params.uid, res);
  });

  route(app, deps, 'lessonConducted', async ({ userId, params, body }) => {
    const uid = userId();
    const plan = await own(uid, params.id);
    rowOf(plan.doc, params.uid);
    const cls = classOf(plan.doc, body.class);
    const cur = await repo.getLessonContent(plan.id, params.uid);
    const conducted = { ...(cur?.conducted ?? {}) };
    if (body.conducted) conducted[cls] = clock.now().toISOString();
    else delete conducted[cls];
    const res = await repo.saveLessonContent({ planId: plan.id, uid: params.uid, ownerId: uid }, cur ? { conducted } : { doc: emptyLessonBody(), conducted }, null);
    if (res === 'version_mismatch') fail('version_mismatch');
    return toLessonContent(plan.id, params.uid, res);
  });

  route(app, deps, 'lessonAssist', async ({ req, userId, params, body }) => {
    const uid = userId();
    const plan = await own(uid, params.id);
    const row = rowOf(plan.doc, params.uid);
    const r = await limiter.hit(`lesson-assist:${uid}`, LESSON_ASSIST_PER_HOUR, 3600);
    if (!r.allowed) fail('rate_limited', { retryAfter: r.retryAfter });
    const lang = body.lang ?? plan.doc.lang;
    const pub = row.topicKey ? await content.getPublished(row.topicKey) : null;
    const ctx: LessonContext = {
      title: row.title,
      section: row.section?.title ?? null,
      subjectName: plan.doc.subjectName,
      grade: plan.doc.grade,
      topicTitle: pub ? t(pub.build.pkg.topic.title, lang) : null,
      homework: row.homework,
    };
    let out: LessonAssistResponse;
    switch (body.task) {
      case 'materials': {
        const exclude = body.exclude ?? [];
        const data = await generate(req, 'lesson.materials', { system: ASSIST_SYSTEM, prompt: materialsPrompt(ctx, body.kind, body.count, exclude, lang), schema: MATERIALS_SCHEMA, maxTokens: ASSIST_MAX_TOKENS.materials });
        out = { task: 'materials', kind: body.kind, items: materialsOf(data, body.count, exclude) };
        break;
      }
      case 'ask': {
        const data = await generate(req, 'lesson.ask', { system: ASSIST_SYSTEM, prompt: askPrompt(ctx, body, lang), schema: ASK_SCHEMA, maxTokens: ASSIST_MAX_TOKENS.ask });
        const answer = answerOf(data);
        if (!answer) fail('tutor_unavailable', { detail: 'provider_error' });
        out = { task: 'ask', answer };
        break;
      }
      case 'draft': {
        const model = lessonModel(body.modelId);
        const data = await generate(req, 'lesson.draft', { system: ASSIST_SYSTEM, prompt: draftPrompt(ctx, model, lang), schema: DRAFT_SCHEMA, maxTokens: ASSIST_MAX_TOKENS.draft });
        out = { task: 'draft', ...draftOf(data, model) };
        break;
      }
    }
    return out;
  });

  route(app, deps, 'lessonSlides', async ({ userId, params, query }) => {
    const uid = userId();
    const plan = await own(uid, params.id);
    const row = rowOf(plan.doc, params.uid);
    const cls = classOf(plan.doc, query.class);
    const r = await limiter.hit(`ktp-doc:${uid}`, 300, 3600);
    if (!r.allowed) fail('rate_limited', { retryAfter: r.retryAfter });
    const body = lessonBodyOf(await repo.getLessonContent(plan.id, params.uid));
    const owner = body.modelId ? null : await repo.getUser(uid);
    const lang = query.lang ?? plan.doc.lang;
    const buf = await renderLessonSlides({
      title: row.title || '—',
      subjectName: plan.doc.subjectName,
      classLabel: cls,
      date: fmtDate(row.dates[cls]),
      homework: row.homework,
      lang,
      model: lessonModel(body.modelId ?? owner?.defaultLessonModel ?? DEFAULT_LESSON_MODEL),
      body,
    });
    return { body: buf, contentType: PPTX_MEDIA_TYPE, filename: `lesson_${safeName(cls)}_${row.dates[cls] ?? 'no-date'}_${row.index}.pptx` };
  });

  // --- «Сегодня» --------------------------------------------------------------------------

  route(app, deps, 'teacherAgenda', async ({ userId, query, lang }) => {
    const uid = userId();
    const now = today();
    const from = query.from ?? now;
    const to = query.to ?? (query.from ? addDays(from, 7) : addDays(now, 7));
    if (to < from) fail('validation_failed', { detail: 'to < from' });
    const days = Math.round((dateOf(to).getTime() - dateOf(from).getTime()) / 86400_000) + 1;
    if (days > AGENDA_MAX_DAYS) fail('validation_failed', { detail: `at most ${AGENDA_MAX_DAYS} days`, issues: [{ path: ['to'], message: `At most ${AGENDA_MAX_DAYS} days` }] });

    const plans = (await allPlans(uid)).map((p) => ({ rec: p, doc: planDocOf(p) }));
    const conducted = new Map((await repo.listLessonContents({ planIds: plans.map((p) => p.rec.id) })).map((c) => [`${c.planId}:${c.uid}`, c.conducted]));
    const lessons: (AgendaLesson & { planTitle: string })[] = [];
    for (const { rec, doc } of plans)
      for (const row of doc.rows)
        for (const cls of doc.classes) {
          const date = row.dates[cls] ?? null;
          if (!date || date < from || date > to) continue;
          lessons.push({
            planId: rec.id,
            uid: row.uid,
            index: row.index,
            class: cls,
            classId: doc.classLinks?.[cls] ?? null,
            subjectKey: doc.subjectKey,
            subjectName: doc.subjectName,
            title: row.title,
            date,
            type: row.type,
            hours: row.hours,
            topicKey: row.topicKey,
            section: row.section?.title ?? null,
            conducted: !!conducted.get(`${rec.id}:${row.uid}`)?.[cls],
            planTitle: rec.title,
          });
        }
    lessons.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.planTitle.localeCompare(b.planTitle, 'ru') || a.index - b.index || a.class.localeCompare(b.class, 'ru')));

    const attention: AttentionItem[] = [];
    // A КТП with errors.
    for (const { rec, doc } of plans) {
      const errors = doc.issues.filter((i) => i.severity === 'error').length;
      if (!errors) continue;
      const linked = doc.classes.find((c) => doc.classLinks?.[c]);
      const cls = linked ?? doc.classes[0] ?? null;
      attention.push({ kind: 'ktp_issues', planId: rec.id, classId: linked ? doc.classLinks![linked]! : null, class: cls, subjectKey: doc.subjectKey, subjectName: doc.subjectName, errors, warnings: doc.issues.filter((i) => i.severity === 'warning').length });
    }
    // A subject of the teacher's class without a КТП linked to the class (any teacher of the class, as /classes/:id/subjects).
    const classes = await taughtClasses(repo, uid);
    const plansOf = new Map<string, PlanDoc[]>([[uid, plans.map((p) => p.doc)]]);
    for (const cls of classes) {
      const keys = cls.subjectKeys ?? (cls.subjectKey ? [cls.subjectKey] : []);
      if (!keys.length) continue;
      const owners = new Set([uid, ...(await repo.listEnrollments({ classId: cls.id, role: 'teacher' })).map((e) => e.userId)]);
      const docs: PlanDoc[] = [];
      for (const o of owners) {
        if (!plansOf.has(o)) plansOf.set(o, (await allPlans(o)).map((p) => planDocOf(p)));
        docs.push(...plansOf.get(o)!);
      }
      for (const subjectKey of keys)
        if (!docs.some((d) => d.subjectKey === subjectKey && Object.values(d.classLinks ?? {}).includes(cls.id))) attention.push({ kind: 'no_ktp', classId: cls.id, className: cls.name, subjectKey });
    }
    attention.push(...(await dueAssignments(classes, lang)));
    return { today: now, from, to, lessons: lessons.map(({ planTitle: _p, ...l }) => l), attention };
  });

  /** Assignments of the teacher's classes due within ASSIGNMENT_DUE_DAYS (either side of now) that not everyone has done. */
  async function dueAssignments(classes: readonly ClassRec[], lang: Lang): Promise<AttentionItem[]> {
    const now = clock.now().getTime();
    const window = ASSIGNMENT_DUE_DAYS * 86400_000;
    const out: AttentionItem[] = [];
    for (const cls of classes) {
      const list = [];
      let cursor: string | undefined;
      do {
        const res = await repo.listAssignments({ classIds: [cls.id] }, { limit: LIST_PAGE, ...(cursor ? { cursor } : {}) });
        list.push(...res.items.filter((a) => a.dueAt && Math.abs(a.dueAt.getTime() - now) <= window));
        cursor = res.nextCursor ?? undefined;
      } while (cursor);
      for (const s of await assignmentSummaries(deps, cls.id, list, lang))
        if (s.done < s.totalStudents) out.push({ kind: 'assignment_due', assignmentId: s.id, classId: cls.id, className: cls.name, title: s.displayTitle, done: s.done, total: s.totalStudents, dueAt: s.dueAt! });
    }
    return out.sort((a, b) => ((a as { dueAt: string }).dueAt < (b as { dueAt: string }).dueAt ? -1 : 1));
  }
}
