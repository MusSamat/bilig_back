/** v0.10.0: stable КТП row ids (lesson content hangs on them; they survive inserts, removals, re-numbering). */
import { randomBytes } from 'node:crypto';

/** A fresh row uid: «r» + 10 base36 chars. */
export const newRowUid = (): string => `r${BigInt(`0x${randomBytes(8).toString('hex')}`).toString(36).padStart(10, '0').slice(0, 10)}`;

/** The uid a row of a plan stored before 0.10.0 gets on read (deterministic; kept by the next write). */
export const legacyRowUid = (planId: string, index: number): string => `r${planId.replace(/-/g, '').slice(0, 8)}_${index}`;
