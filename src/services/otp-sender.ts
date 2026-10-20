/**
 * Contract 0.7.0 — the port that delivers phone one-time codes to the teacher's
 * WhatsApp. Chosen by `OTP_SENDER` (src/config.ts → resolveOtpSender):
 *  - `fixed`    AUTH_FIXED_OTP is set: every code is that value and nothing is
 *               sent (TEMPORARY, insecure; a start-up warning says so);
 *  - `console`  development: prints «WhatsApp → +996…: …» to stdout (refused in production);
 *  - `whatsapp` the WhatsApp Business provider — a stub until it is configured
 *               (config refuses to start with it, `send` throws).
 * Tests use `MemoryOtpSender` (an outbox).
 */
import type { Lang } from '@bilig/content-model';
import type { OtpPurpose } from '@bilig/content-model/api';
import { formatKgPhone } from '@bilig/content-model/api';
import type { OtpSenderKind } from '../config.js';

/** `account_exists`: a registration was started for a number that already has an account (no code). */
export type OtpMessagePurpose = OtpPurpose | 'account_exists';

export interface OtpSender {
  readonly kind: OtpSenderKind | 'memory';
  /** `code` is null for `account_exists`. */
  send(phone: string, code: string | null, locale: Lang, purpose: OtpMessagePurpose): Promise<void>;
}

const MESSAGES: Record<Lang, (purpose: OtpMessagePurpose, code: string | null, minutes: number) => string> = {
  ky: (p, code, min) =>
    p === 'account_exists'
      ? 'Bilig: бул номер менен аккаунт мурунтан эле бар. Сырсөздү унутсаңыз, кирүү бетинде «Сырсөздү унуттуңузбу?» баскычын басыңыз.'
      : `Bilig: ${p === 'register' ? 'катталуу' : 'сырсөздү калыбына келтирүү'} коду ${code}. Код ${min} мүнөт жарактуу. Аны эч кимге айтпаңыз.`,
  ru: (p, code, min) =>
    p === 'account_exists'
      ? 'Bilig: с этим номером уже есть аккаунт. Если вы забыли пароль, нажмите «Забыли пароль?» на странице входа.'
      : `Bilig: код ${p === 'register' ? 'регистрации' : 'восстановления пароля'} ${code}. Код действует ${min} минут. Никому его не сообщайте.`,
  en: (p, code, min) =>
    p === 'account_exists'
      ? 'Bilig: there is already an account with this number. If you forgot your password, tap “Forgot password?” on the sign-in page.'
      : `Bilig: your ${p === 'register' ? 'sign-up' : 'password reset'} code is ${code}. It is valid for ${min} minutes. Do not share it.`,
};

/** The WhatsApp text in the user's language. */
export const otpMessage = (locale: Lang, purpose: OtpMessagePurpose, code: string | null, minutes = 10) =>
  (MESSAGES[locale] ?? MESSAGES.ky)(purpose, code, minutes);

/** AUTH_FIXED_OTP mode: the code is the fixed value, nothing leaves the server. */
export class FixedOtpSender implements OtpSender {
  readonly kind = 'fixed' as const;
  async send() {}
}

/** Development: prints the message to stdout (not the structured log, to keep numbers out of logs). */
export class ConsoleOtpSender implements OtpSender {
  readonly kind = 'console' as const;
  constructor(private write: (s: string) => void = (s) => void process.stdout.write(s)) {}
  async send(phone: string, code: string | null, locale: Lang, purpose: OtpMessagePurpose) {
    this.write(`\n--- WhatsApp → ${formatKgPhone(phone)}: ${otpMessage(locale, purpose, code)}${code ? ` (code ${code})` : ''}\n`);
  }
}

/**
 * WhatsApp Business (Cloud API) — NOT IMPLEMENTED. To plug it in: add the
 * provider's env (access token, phone number id, approved template names per
 * language) to src/config.ts, send an authentication template with the code
 * here, and let `resolveOtpSender` accept `whatsapp` once those are set.
 */
export class WhatsAppOtpSender implements OtpSender {
  readonly kind = 'whatsapp' as const;
  async send(): Promise<void> {
    throw new Error('WhatsApp OTP sender is not configured');
  }
}

/** Tests: keeps an outbox. */
export interface SentOtp {
  phone: string;
  code: string | null;
  locale: Lang;
  purpose: OtpMessagePurpose;
  text: string;
}
export class MemoryOtpSender implements OtpSender {
  readonly kind = 'memory' as const;
  readonly outbox: SentOtp[] = [];
  async send(phone: string, code: string | null, locale: Lang, purpose: OtpMessagePurpose) {
    this.outbox.push({ phone, code, locale, purpose, text: otpMessage(locale, purpose, code) });
  }
  last(phone?: string): SentOtp | undefined {
    return [...this.outbox].reverse().find((m) => !phone || m.phone === phone);
  }
}

export function createOtpSender(kind: OtpSenderKind): OtpSender {
  switch (kind) {
    case 'fixed':
      return new FixedOtpSender();
    case 'console':
      return new ConsoleOtpSender();
    case 'whatsapp':
      return new WhatsAppOtpSender();
  }
}
