import { describe, expect, it } from "vitest";
import { retryDelayMs } from "../../src/services/finalizer";
import { assertSafeTestDatabaseUrl } from "../setup/safety";

describe("retryDelayMs (worker failure back-off)", () => {
  it("doubles on each consecutive failure starting at 5 seconds", () => {
    expect([1, 2, 3, 4].map((n) => retryDelayMs(n))).toEqual([5_000, 10_000, 20_000, 40_000]);
  });

  it("is capped at 5 minutes", () => {
    expect(retryDelayMs(10)).toBe(300_000);
    expect(retryDelayMs(100)).toBe(300_000);
  });

  it("never returns less than the base delay", () => {
    expect(retryDelayMs(0)).toBe(5_000);
  });
});

describe("assertSafeTestDatabaseUrl (keeps tests away from Neon/RDS)", () => {
  it("accepts a local *_test database", () => {
    expect(() => assertSafeTestDatabaseUrl("postgresql://u:p@localhost:5432/quizora_test")).not.toThrow();
    expect(() => assertSafeTestDatabaseUrl("postgresql://u:p@127.0.0.1:5432/anything_test")).not.toThrow();
  });

  it("rejects remote hosts, including Neon and RDS", () => {
    expect(() => assertSafeTestDatabaseUrl("postgresql://u:p@ep-x.neon.tech/neondb_test")).toThrow(/not local/);
    expect(() => assertSafeTestDatabaseUrl("postgresql://u:p@db.abc.rds.amazonaws.com/quizora_test")).toThrow(/not local/);
  });

  it("rejects a local database that is not named *_test", () => {
    expect(() => assertSafeTestDatabaseUrl("postgresql://u:p@localhost:5432/quizora")).toThrow(/_test/);
  });

  it("does not leak credentials in the error message", () => {
    try {
      assertSafeTestDatabaseUrl("postgresql://admin:SuperSecret@ep-x.neon.tech/neondb");
    } catch (err) {
      expect(String((err as Error).message)).not.toContain("SuperSecret");
    }
  });
});
