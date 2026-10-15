import { describe, it, expect } from 'vitest';
import { t, LANGS, DEFAULT_LANG, type Localized } from './index.js';

describe('t() localized resolver (TZ: ky → ru → en fallback chain)', () => {
  it('returns the requested language when present', () => {
    const v: Localized = { ky: 'Суу', ru: 'Вода', en: 'Water' };
    expect(t(v, 'ky')).toBe('Суу');
    expect(t(v, 'ru')).toBe('Вода');
    expect(t(v, 'en')).toBe('Water');
  });

  it('falls back ky → ru → en when a language is missing', () => {
    expect(t({ ru: 'Вода', en: 'Water' }, 'ky')).toBe('Вода');
    expect(t({ en: 'Water' }, 'ky')).toBe('Water');
  });

  it('falls back to the first available value when source langs absent', () => {
    expect(t({ en: 'Water' }, 'ru')).toBe('Water');
  });

  it('returns empty string for undefined / empty', () => {
    expect(t(undefined, 'ky')).toBe('');
    expect(t({}, 'ky')).toBe('');
  });

  it('ky is the default/primary language', () => {
    expect(DEFAULT_LANG).toBe('ky');
    expect(LANGS).toEqual(['ky', 'ru', 'en']);
  });
});
