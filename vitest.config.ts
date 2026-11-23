import { defineConfig } from "vitest/config";

/**
 * Test safety: the test process NEVER inherits the real DATABASE_URL / REDIS_URL from .env.
 *   - TEST_DATABASE_URL set   -> DB integration tests run against it (must be a local *_test database;
 *                                tests/setup/safety.ts enforces that and refuses anything else).
 *   - TEST_DATABASE_URL unset -> DATABASE_URL points at an unreachable placeholder and the DB integration tests are skipped.
 *   - TEST_REDIS_URL set      -> Redis integration tests run against it (local Redis only), using a private key prefix that is
 *                                deleted afterwards. Unset -> REDIS_URL is empty, the app uses its in-process fallbacks and the
 *                                Redis tests are skipped.
 * Unit tests always run. dotenv (src/config/env.ts) never overrides variables that are already set, so .env cannot leak in.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const effectiveUrl = testDatabaseUrl ?? "postgresql://invalid:invalid@127.0.0.1:1/quizora_test_unconfigured";
const testRedisUrl = process.env.TEST_REDIS_URL;
const redisKeyPrefix = `quizora:test:${process.pid}-${Date.now()}:`;
process.env.TEST_REDIS_KEY_PREFIX = redisKeyPrefix; // read by tests/setup/global-setup.ts to clean up afterwards

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/setup/global-setup.ts"],
    // The integration tests share one database and one Redis, so test files run one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: effectiveUrl,
      DIRECT_URL: effectiveUrl,
      REDIS_URL: testRedisUrl ?? "",
      REDIS_KEY_PREFIX: redisKeyPrefix,
      // Single-instance defaults regardless of the developer's .env
      TRUST_PROXY_HOPS: "0",
      COOKIE_SECURE: "",
      DB_CONNECTION_LIMIT: "",
      // Dummy, test-only values so src/config/env.ts validates without a real .env.
      SESSION_SECRET: "test-only-session-secret-0123456789abcdef",
      CSRF_SECRET: "test-only-csrf-secret-0123456789abcdefgh"
    }
  }
});
