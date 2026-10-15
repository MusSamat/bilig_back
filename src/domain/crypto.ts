/** Small crypto helpers: opaque tokens, hashes, HMAC pseudonyms, constant-time compare. */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** 256-bit URL-safe random token (refresh tokens, reset links, invites). */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export const sha256Hex = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

/** Tokens are stored only as sha256 (a DB leak does not leak live tokens). */
export const hashToken = (token: string): string => sha256Hex(`bilig:token:${token}`);

/** Learning-event actor pseudonym: HMAC-SHA256(userId), truncated (TZ §8). */
export const pseudonym = (secret: string, userId: string): string =>
  createHmac('sha256', secret).update(userId).digest('base64url').slice(0, 22);

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Unambiguous alphabet for class join codes (no 0/O, 1/I/L). */
export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function joinCode(len = 6): string {
  let s = '';
  for (let i = 0; i < len; i++) s += JOIN_CODE_ALPHABET[randomInt(JOIN_CODE_ALPHABET.length)];
  return s;
}

/** Random numeric PIN (default 6 digits; contract allows 4–6). */
export function randomPin(len = 6): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String(randomInt(10));
  return s;
}

/** Stable JSON (sorted keys) for request hashing and package hashes. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}
