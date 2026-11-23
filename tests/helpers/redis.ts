import { describe } from "vitest";
import type Redis from "ioredis";
import { createRedisClient } from "../../src/lib/redis";
import { assertSafeTestRedisUrl } from "../setup/safety";

export const REDIS_TESTS_ENABLED = Boolean(process.env.TEST_REDIS_URL);

if (REDIS_TESTS_ENABLED) {
  assertSafeTestRedisUrl(process.env.TEST_REDIS_URL as string);
  assertSafeTestRedisUrl(process.env.REDIS_URL ?? "", "REDIS_URL");
}

/** `describe` for tests that need Redis; skipped when TEST_REDIS_URL is not set. */
export const describeRedis = REDIS_TESTS_ENABLED ? describe : describe.skip;

const opened: Redis[] = [];

/** A new independent client = one more "backend instance". Closed by closeTestClients(). */
export function newTestClient(url = process.env.TEST_REDIS_URL as string): Redis {
  const client = createRedisClient(url, "quizora-test");
  opened.push(client);
  return client;
}

export async function closeTestClients(): Promise<void> {
  await Promise.all(opened.splice(0).map((c) => c.quit().catch(() => c.disconnect())));
}

/** Like newTestClient() but resolves only once the connection is ready (clients fail fast until then, by design). */
export async function newReadyClient(url = process.env.TEST_REDIS_URL as string): Promise<Redis> {
  const client = newTestClient(url);
  if (client.status !== "ready") {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("test redis did not become ready")), 5_000);
      client.once("ready", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  return client;
}

/** A key prefix no other test (or the application) uses; removed afterwards by the global teardown. */
export const testPrefix = (name: string) => `${process.env.TEST_REDIS_KEY_PREFIX ?? "quizora:test:"}${name}:${Math.random().toString(36).slice(2, 8)}:`;

/** A client for a Redis that is not there (nothing listens on port 1): simulates an outage. */
export function newDeadClient(): Redis {
  return newTestClient("redis://127.0.0.1:1");
}
