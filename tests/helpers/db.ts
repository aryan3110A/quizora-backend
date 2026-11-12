import { describe } from "vitest";
import { assertSafeTestDatabaseUrl } from "../setup/safety";

export const DB_TESTS_ENABLED = Boolean(process.env.TEST_DATABASE_URL);

if (DB_TESTS_ENABLED) {
  // Second line of defence: the URL the application code will actually use must also be the safe test database.
  assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL as string);
  assertSafeTestDatabaseUrl(process.env.DATABASE_URL ?? "", "DATABASE_URL");
}

/** `describe` for tests that need PostgreSQL; skipped when TEST_DATABASE_URL is not set. */
export const describeDb = DB_TESTS_ENABLED ? describe : describe.skip;
