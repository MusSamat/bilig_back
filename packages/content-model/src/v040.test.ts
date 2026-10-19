import { describe, expect, it } from 'vitest';
import {
  AdminGeneratedListQuerySchema,
  ENDPOINTS,
  GeneratedFeedbackRequestSchema,
  GeneratedQuizItemSchema,
  TutorAskRequestSchema,
  TutorGenerateRequestSchema,
  collectTutorStream,
  parseSseEvents,
  encodeSseEvent,
} from './api/index.js';
import { CONTRACT_VERSION } from './i18n.js';

const ID = '018f2d4e-1a2b-7c3d-8e4f-5a6b7c8d9e0f';

describe('contract 0.4.0', () => {
  it('version is 0.4.0 or later', () => expect(CONTRACT_VERSION >= '0.4.0').toBe(true));

  it('ask: context envelope and intent are optional and validated', () => {
    const base = { topicKey: 'methane', question: 'А сколько атомов?', lang: 'ru' };
    expect(TutorAskRequestSchema.safeParse(base).success).toBe(true);
    expect(TutorAskRequestSchema.safeParse({ ...base, intent: 'simpler', context: { mode: 'explore', sampleKey: 'methane', quote: { text: 'связь C–H', source: 'concept', conceptKey: 'chem.bond' } } }).success).toBe(true);
    expect(TutorAskRequestSchema.safeParse({ ...base, context: { quote: { text: 'x'.repeat(501) } } }).success).toBe(false);
    expect(TutorAskRequestSchema.safeParse({ ...base, intent: 'hack' }).success).toBe(false);
  });

  it('suggestions stream event round-trips and folds into JSON mode', () => {
    const frames = encodeSseEvent({ type: 'token', text: 'x' }) + encodeSseEvent({ type: 'suggestions', items: ['Что такое метан?'] });
    const { events } = parseSseEvents(frames);
    expect(events).toHaveLength(2);
    expect(collectTutorStream(events)).toEqual({ answer: 'x', citations: [], suggestions: ['Что такое метан?'] });
  });

  it('generate request defaults; quiz answer must be an option', () => {
    expect(TutorGenerateRequestSchema.parse({ topicKey: 'methane', lang: 'ky', kind: 'quiz' })).toMatchObject({ count: 3, exclude: [] });
    expect(TutorGenerateRequestSchema.safeParse({ topicKey: 'methane', lang: 'ky', kind: 'quiz', count: 6 }).success).toBe(false);
    const q = { id: ID, prompt: 'p', options: [{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }], answer: 'a', explanation: 'e' };
    expect(GeneratedQuizItemSchema.safeParse(q).success).toBe(true);
    expect(GeneratedQuizItemSchema.safeParse({ ...q, answer: 'c' }).success).toBe(false);
    expect(GeneratedQuizItemSchema.safeParse({ ...q, options: [{ key: 'a', text: 'A' }, { key: 'a', text: 'B' }] }).success).toBe(false);
  });

  it('feedback: a report needs a reason', () => {
    expect(GeneratedFeedbackRequestSchema.safeParse({ vote: 'good' }).success).toBe(true);
    expect(GeneratedFeedbackRequestSchema.safeParse({ vote: 'bad' }).success).toBe(false);
    expect(GeneratedFeedbackRequestSchema.safeParse({ vote: 'bad', reason: 'wrong' }).success).toBe(true);
  });

  it('endpoints and admin list query', () => {
    expect(ENDPOINTS.tutorGenerate).toMatchObject({ method: 'POST', path: '/tutor/generate', auth: 'assistant.ask.online' });
    expect(ENDPOINTS.tutorGeneratedFeedback.path).toBe('/tutor/generated/:id/feedback');
    expect(ENDPOINTS.adminGeneratedList.auth).toBe('content.draft.edit');
    expect(AdminGeneratedListQuerySchema.parse({ reported: 'true', sort: 'bad', order: 'desc' })).toMatchObject({ reported: true, sort: 'bad' });
  });
});
