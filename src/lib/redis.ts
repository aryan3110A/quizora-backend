import Redis from "ioredis";
import { env } from "../config/env";
import { logger } from "./logger";

/**
 * Redis (ElastiCache) access. Redis is OPTIONAL: with REDIS_URL unset everything falls back to in-process behaviour, which is
 * correct for a single instance and for local development.
 *
 * What Redis is used for — and what it must never be used for:
 *   - used:   shared rate-limit counters, short-lived import previews (both expire on their own);
 *   - never:  answers, attempts, scores or any record that must survive. PostgreSQL is the only system of record.
 *
 * Connection model: ONE shared client per process, created on first use (so nothing connects unless Redis is configured).
 * It fails fast instead of queueing commands while disconnected (a Redis outage must not stall exam traffic), and reconnects
 * in the background with a capped back-off.
 */

let shared: Redis | undefined;
let lastErrorLogAt = 0;

export function redisEnabled(): boolean {
  return env.REDIS_URL !== undefined;
}

/** Builds a client with the application's connection policy. Used for the shared client and, in tests, for extra clients. */
export function createRedisClient(url: string, connectionName = "quizora"): Redis {
  const client = new Redis(url, {
    connectionName,
    connectTimeout: 3_000,
    commandTimeout: 1_500,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false, // fail fast while disconnected; callers have a safe fallback
    retryStrategy: (attempt) => Math.min(200 * 2 ** Math.min(attempt, 5), 5_000)
  });
  // Without an 'error' listener ioredis would throw on connection errors. Log at most once every 30 s (no URL, no secrets).
  client.on("error", (error: Error) => {
    const now = Date.now();
    if (now - lastErrorLogAt > 30_000) {
      lastErrorLogAt = now;
      logger.warn({ err: error.message }, "redis connection problem (falling back where possible)");
    }
  });
  return client;
}

/** The process-wide client, or null when Redis is not configured. */
export function getRedis(): Redis | null {
  if (!env.REDIS_URL) return null;
  shared ??= createRedisClient(env.REDIS_URL, "quizora-api");
  return shared;
}

/** Waits (bounded) for the shared client to become ready. Never throws: the app starts even if Redis is down. */
export async function connectRedis(timeoutMs = 3_000): Promise<boolean> {
  const client = getRedis();
  if (!client) return false;
  if (client.status === "ready") return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => done(false), timeoutMs);
    const done = (ready: boolean) => {
      clearTimeout(timer);
      client.off("ready", onReady);
      resolve(ready);
    };
    const onReady = () => done(true);
    client.on("ready", onReady);
  });
}

/** True if Redis answers PING within the timeout. */
export async function pingRedis(client: Redis | null = getRedis(), timeoutMs = 1_000): Promise<boolean> {
  if (!client) return false;
  try {
    const reply = await Promise.race([
      client.ping(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("redis ping timeout")), timeoutMs).unref())
    ]);
    return reply === "PONG";
  } catch {
    return false;
  }
}

/** Graceful close (QUIT lets pending replies finish); falls back to a hard disconnect. Safe to call repeatedly. */
export async function closeRedis(): Promise<void> {
  const client = shared;
  shared = undefined;
  if (!client) return;
  try {
    await Promise.race([client.quit(), new Promise((resolve) => setTimeout(resolve, 1_000).unref())]);
  } catch {
    /* already closed or never connected */
  }
  client.disconnect();
}
