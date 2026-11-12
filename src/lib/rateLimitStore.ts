import type Redis from "ioredis";
import { MemoryStore, type ClientRateLimitInfo, type Options, type Store } from "express-rate-limit";
import { logger } from "./logger";

/**
 * express-rate-limit store backed by Redis, so the limit is shared by every backend instance.
 *
 * Same semantics as the built-in MemoryStore: a FIXED window per key, started by the key's first hit. The counter increment and
 * the window expiry are done in one Lua script, so concurrent requests on different instances cannot race or leave a counter
 * without an expiry.
 *
 * Failure policy (safe by design): if Redis errors or is unreachable the call falls back to a per-instance MemoryStore. The limit
 * then applies per instance instead of globally — weaker, but login keeps working and brute-force is still throttled. It never
 * throws into the request and never turns a Redis outage into an application outage.
 */
const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if hits == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {hits, ttl}
`;

export class RedisRateLimitStore implements Store {
  /** Counters are shared between instances (tells express-rate-limit not to warn about double counting). */
  localKeys = false;
  private windowMs = 15 * 60_000;
  private readonly fallback = new MemoryStore();
  private lastFallbackLogAt = 0;

  constructor(
    private readonly client: Redis,
    private readonly keyPrefix = "quizora:rl:"
  ) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
    this.fallback.init(options);
  }

  private key(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  private noteFallback(error: unknown): void {
    const now = Date.now();
    if (now - this.lastFallbackLogAt > 30_000) {
      this.lastFallbackLogAt = now;
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, "rate limit store: Redis unavailable, using per-instance counters");
    }
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    try {
      const [totalHits, ttlMs] = (await this.client.eval(INCREMENT_SCRIPT, 1, this.key(key), String(this.windowMs))) as [number, number];
      return { totalHits, resetTime: new Date(Date.now() + ttlMs) };
    } catch (error) {
      this.noteFallback(error);
      return this.fallback.increment(key);
    }
  }

  async decrement(key: string): Promise<void> {
    try {
      await this.client.decr(this.key(key));
    } catch (error) {
      this.noteFallback(error);
      await this.fallback.decrement(key);
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      await this.client.del(this.key(key));
    } catch (error) {
      this.noteFallback(error);
    }
    await this.fallback.resetKey(key);
  }
}
