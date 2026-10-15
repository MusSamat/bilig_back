/** Tutor settings (A-18), stored as a versioned Setting row; defaults when absent. */
import { TutorSettingsSchema, type TutorSettings } from '@bilig/content-model/api';
import type { Config } from '../config.js';
import type { Repository, WriteResult } from '../repo/types.js';

export const TUTOR_SETTINGS_KEY = 'tutor.settings';

export function defaultTutorSettings(config: Pick<Config, 'tutorModel' | 'tutorDailyTokenBudget'>): TutorSettings {
  return {
    enabled: true,
    provider: 'anthropic',
    model: config.tutorModel,
    systemPrompts: { ky: '', ru: '', en: '' },
    limits: { guestPerHour: 5, studentPerHour: 30, adultPerHour: 60, ipPerHour: 60, schoolPerDay: 2000 },
    dailyTokenBudget: config.tutorDailyTokenBudget,
    stopTopics: [],
    regressionQuestions: [],
    version: 0,
  };
}

export async function getTutorSettings(repo: Repository, config: Pick<Config, 'tutorModel' | 'tutorDailyTokenBudget'>): Promise<TutorSettings> {
  const row = await repo.getSetting(TUTOR_SETTINGS_KEY);
  if (!row) return defaultTutorSettings(config);
  const parsed = TutorSettingsSchema.safeParse({ ...(row.value as object), version: row.version });
  return parsed.success ? parsed.data : { ...defaultTutorSettings(config), version: row.version };
}

/** Optimistic write: `expectedVersion` is the version the admin saw (0 = defaults). */
export async function putTutorSettings(repo: Repository, value: Omit<TutorSettings, 'version'>, expectedVersion: number): Promise<WriteResult<TutorSettings>> {
  const cur = await repo.getSetting(TUTOR_SETTINGS_KEY);
  if ((cur?.version ?? 0) !== expectedVersion) return 'version_mismatch';
  const res = await repo.putSetting(TUTOR_SETTINGS_KEY, value, cur ? expectedVersion : null);
  if (res === 'not_found' || res === 'version_mismatch') return res;
  return { ...value, version: res.version };
}
