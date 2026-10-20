# Contract 0.7.0: phone-first teacher accounts

Contract `@bilig/content-model` and `@bilig/permissions` 0.6.0 → **0.7.0**.
Additive: e-mail login (staff, admin audience) and the 0.6.0 e-mail
registration keep working; the client stops offering them to teachers.

Teachers in Kyrgyzstan live on WhatsApp. A teacher account is a Kyrgyz mobile
number (`+996` and 9 digits) and a password; the number is proven with a
one-time code sent to its WhatsApp.

## 1. Numbers

`PhoneSchema` normalizes input (`0555 12-34-56`, `996555123456`, `555123456`
→ `+996555123456`) and accepts only `+996\d{9}`. `formatKgPhone` prints
`+996 555 12 34 56`.

## 2. Registration (3 steps) and password reset

| Step | Endpoint | Body | Response |
|---|---|---|---|
| 1 | `POST /auth/otp/start` | `{ phone, purpose: register \| reset, locale? }` | `{ ok, channel: 'whatsapp', expiresIn, resendAfter }` |
| 2 | `POST /auth/otp/verify` | `{ phone, purpose, code }` | `{ token, expiresIn }` |
| 3 | `POST /auth/register/complete` | `{ token, password }` | `TokenResponse` (signed in) |
| 3 | `POST /auth/password/set` | `{ token, password }` | `TokenResponse` (signed in, other sessions revoked) |

- The client asks for the password twice and compares; the server gets one.
- Step 1 answers the same whether or not the number has an account. A
  `register` start for a taken number sends «you already have an account»
  instead of a code; a `reset` start for an unknown number sends nothing.
- Codes: 6 digits, 10 minutes, 5 wrong tries burn the code, resend after 60 s,
  limits per IP and per number. Tokens: single use, 15 minutes, bound to the
  number and the purpose.
- Delivery: an `OtpSender` port. Today `AUTH_FIXED_OTP=012345` (server env)
  makes every code that value and nothing is sent (a startup warning says so).
  A WhatsApp Business provider plugs in later behind the same port.
- `register/complete` creates the user (phone verified, display name = the
  formatted number until the teacher sets one), a personal school (origin
  `self`), the `teacher` grant and an empty trial licence (`TRIAL_DAYS`).

## 3. Login

`POST /auth/login { phone | email, password, totp? }` — exactly one of
`phone` and `email`. Teachers use the phone; staff accounts created by e-mail
invite keep their e-mail. The admin audience stays e-mail + TOTP.

## 4. The cabinet finishes the setup

- `GET /me`: `phone`, and `setup: { name, school, teaching }` for
  self-registered teachers — what is already filled in.
- `PATCH /me { displayName?, schoolName?, region?, teaching? }`: the teacher
  names themself and their school, picks subjects and grades (the trial
  licence follows). `schoolName` / `region` only for the teacher's own
  (self) school, else 403.

## 5. Students

The student sign-in (class code + PIN) stays in the API; the client hides it
for now.
