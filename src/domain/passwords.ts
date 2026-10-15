/**
 * Passwords & PINs (TZ §6): argon2id, ≥10 chars, leaked-password check
 * against a bundled list (data/leaked-passwords.txt, SecLists top lists
 * filtered to ≥10 chars).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hash, verify } from '@node-rs/argon2';

// argon2id (the library default algorithm; asserted in tests) with the OWASP baseline m=19 MiB, t=2, p=1.
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashSecret = (secret: string): Promise<string> => hash(secret, OPTS);

export async function verifySecret(hashStr: string, secret: string): Promise<boolean> {
  try {
    return await verify(hashStr, secret);
  } catch {
    return false;
  }
}

/** A fixed hash verified for unknown e-mails, so timing does not reveal account existence. */
let dummy: Promise<string> | null = null;
export async function verifyDummy(secret: string): Promise<false> {
  dummy ??= hashSecret('bilig-dummy-password-for-timing');
  await verifySecret(await dummy, secret);
  return false;
}

export const MIN_PASSWORD_LENGTH = 10;

let leaked: Set<string> | null = null;
function leakedSet(): Set<string> {
  if (!leaked) {
    const path = fileURLToPath(new URL('../../data/leaked-passwords.txt', import.meta.url));
    leaked = new Set(
      readFileSync(path, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#')),
    );
  }
  return leaked;
}

export type PasswordProblem = 'too_short' | 'leaked' | 'too_simple';

/** Returns null when acceptable, else the reason (reported as `password_weak`). */
export function checkPassword(pw: string, context: string[] = []): PasswordProblem | null {
  if ([...pw].length < MIN_PASSWORD_LENGTH) return 'too_short';
  const lower = pw.toLowerCase();
  if (leakedSet().has(lower)) return 'leaked';
  if (new Set(lower).size <= 2) return 'too_simple';
  for (const c of context) {
    const v = c.toLowerCase().split('@')[0];
    if (v.length >= 4 && lower.includes(v)) return 'too_simple';
  }
  return null;
}
