import { execSync } from "node:child_process";
import Redis from "ioredis";
import { assertSafeTestDatabaseUrl, assertSafeTestRedisUrl } from "./safety";

/**
 * Runs once before the test run. When a test database is configured it is brought to the current schema with
 * `prisma migrate deploy`, which doubles as a continuous check that the migrations can initialise a fresh PostgreSQL database.
 * When a test Redis is configured it is checked for safety, and every key the run created (private prefix) is deleted afterwards.
 */
export default async function setup(): Promise<(() => Promise<void>) | void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    console.warn("[tests] TEST_DATABASE_URL is not set: database integration tests will be SKIPPED.");
  } else {
    assertSafeTestDatabaseUrl(url);
    execSync("npx prisma migrate deploy", {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }
    });
  }

  const redisUrl = process.env.TEST_REDIS_URL;
  if (!redisUrl) {
    console.warn("[tests] TEST_REDIS_URL is not set: Redis integration tests will be SKIPPED.");
    return;
  }
  assertSafeTestRedisUrl(redisUrl);
  const prefix = process.env.TEST_REDIS_KEY_PREFIX;
  return async () => {
    if (!prefix) return;
    const client = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
      await client.connect();
      let cursor = "0";
      do {
        const [next, keys] = await client.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 200);
        cursor = next;
        if (keys.length) await client.del(...keys);
      } while (cursor !== "0");
    } finally {
      client.disconnect();
    }
  };
}
