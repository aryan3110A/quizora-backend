import { describe, expect, it } from "vitest";
import { withConnectionParams } from "../../src/lib/dbUrl";
import { resolveCookieSecure } from "../../src/lib/cookies";

describe("withConnectionParams (per-process Prisma pool size)", () => {
  const base = "postgresql://quizora:p%40ss%2Fword@db.example.internal:5432/quizora?sslmode=require";

  it("returns the URL untouched when nothing is configured", () => {
    expect(withConnectionParams(base, {})).toBe(base);
  });

  it("adds connection_limit and pool_timeout and keeps every other parameter and the encoded password", () => {
    const url = new URL(withConnectionParams(base, { connectionLimit: 10, poolTimeoutSeconds: 20 }));
    expect(url.searchParams.get("connection_limit")).toBe("10");
    expect(url.searchParams.get("pool_timeout")).toBe("20");
    expect(url.searchParams.get("sslmode")).toBe("require");
    expect(url.password).toBe("p%40ss%2Fword");
    expect(url.hostname).toBe("db.example.internal");
  });

  it("lets the per-process setting override a value already in the URL (e.g. worker 3 vs shared URL 10)", () => {
    const shared = `${base}&connection_limit=10&pgbouncer=true`;
    const url = new URL(withConnectionParams(shared, { connectionLimit: 3 }));
    expect(url.searchParams.get("connection_limit")).toBe("3");
    expect(url.searchParams.get("pgbouncer")).toBe("true");
  });

  it("does not choke on a value that is not a URL", () => {
    expect(withConnectionParams("not a url", { connectionLimit: 5 })).toBe("not a url");
  });
});

describe("resolveCookieSecure", () => {
  it("keeps the original behaviour by default: Secure in production only", () => {
    expect(resolveCookieSecure(undefined, "production", false)).toBe(true);
    expect(resolveCookieSecure(undefined, "development", true)).toBe(false);
    expect(resolveCookieSecure(undefined, "test", true)).toBe(false);
  });

  it("honours an explicit true / false", () => {
    expect(resolveCookieSecure("true", "development", false)).toBe(true);
    expect(resolveCookieSecure("false", "production", true)).toBe(false);
  });

  it("'auto' follows whether the request really came over HTTPS (as reported by the trusted proxy)", () => {
    expect(resolveCookieSecure("auto", "production", true)).toBe(true);
    expect(resolveCookieSecure("auto", "production", false)).toBe(false);
  });
});
