/**
 * Rate limits and counters (TZ §6 «Rate limit … (Redis)»). Redis is used when
 * REDIS_URL is set; otherwise an in-memory fixed-window store (single
 * instance only). Keys never contain raw e-mails: callers hash them first.
 */
import type { Redis } from 'ioredis';
import type { Clock } from './clock.js';

export interface HitResult {
  allowed: boolean;
  count: number;
  /** Seconds until the window resets. */
  retryAfter: number;
}

export interface Limiter {
  readonly kind: 'memory' | 'redis';
  /** Count one hit in a fixed window; `allowed` is false once `count > limit`. */
  hit(key: string, limit: number, windowSec: number): Promise<HitResult>;
  /** Add to a counter that expires `ttlSec` after creation; returns the new total. */
  add(key: string, amount: number, ttlSec: number): Promise<number>;
  get(key: string): Promise<number>;
  reset(key: string): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export class MemoryLimiter implements Limiter {
  readonly kind = 'memory' as const;
  private m = new Map<string, { n: number; exp: number }>();
  constructor(private clock: Clock) {}

  private cur(key: string, ttlSec: number) {
    const now = this.clock.now().getTime();
    let e = this.m.get(key);
    if (!e || e.exp <= now) {
      e = { n: 0, exp: now + ttlSec * 1000 };
      this.m.set(key, e);
    }
    if (this.m.size > 100_000) this.sweep(now);
    return { e, now };
  }
  private sweep(now: number) {
    for (const [k, v] of this.m) if (v.exp <= now) this.m.delete(k);
  }
  async hit(key: string, limit: number, windowSec: number): Promise<HitResult> {
    const { e, now } = this.cur(key, windowSec);
    e.n++;
    return { allowed: e.n <= limit, count: e.n, retryAfter: Math.max(1, Math.ceil((e.exp - now) / 1000)) };
  }
  async add(key: string, amount: number, ttlSec: number) {
    const { e } = this.cur(key, ttlSec);
    e.n += amount;
    return e.n;
  }
  async get(key: string) {
    const e = this.m.get(key);
    return e && e.exp > this.clock.now().getTime() ? e.n : 0;
  }
  async reset(key: string) {
    this.m.delete(key);
  }
  async ping() {
    return true;
  }
  async close() {}
}

export class RedisLimiter implements Limiter {
  readonly kind = 'redis' as const;
  constructor(private redis: Redis, private prefix = 'bilig:rl:') {}

  async hit(key: string, limit: number, windowSec: number): Promise<HitResult> {
    const k = this.prefix + key;
    const [[, n], [, ttl]] = (await this.redis.multi().incr(k).ttl(k).exec()) as [[null, number], [null, number]];
    let left = ttl;
    if (ttl < 0) {
      await this.redis.expire(k, windowSec);
      left = windowSec;
    }
    return { allowed: n <= limit, count: n, retryAfter: Math.max(1, left) };
  }
  async add(key: string, amount: number, ttlSec: number) {
    const k = this.prefix + key;
    const n = await this.redis.incrby(k, amount);
    if (n === amount) await this.redis.expire(k, ttlSec);
    return n;
  }
  async get(key: string) {
    return Number((await this.redis.get(this.prefix + key)) ?? 0);
  }
  async reset(key: string) {
    await this.redis.del(this.prefix + key);
  }
  async ping() {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
  async close() {
    this.redis.disconnect();
  }
}

/** Connect to Redis when configured, else fall back to memory (logged by the caller). */
export async function createLimiter(redisUrl: string | undefined, clock: Clock): Promise<Limiter> {
  if (!redisUrl) return new MemoryLimiter(clock);
  const { Redis } = await import('ioredis');
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2, enableOfflineQueue: false });
  try {
    await redis.connect();
    return new RedisLimiter(redis);
  } catch {
    redis.disconnect();
    return new MemoryLimiter(clock);
  }
}
