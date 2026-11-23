import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createHealthRouter, type HealthDeps } from "../../src/routes/health";

function appWith(overrides: Partial<HealthDeps> = {}) {
  const deps: HealthDeps = {
    checkDatabase: async () => undefined,
    checkRedis: null,
    redisRequired: false,
    isShuttingDown: () => false,
    cacheMs: 0,
    ...overrides
  };
  const app = express();
  app.use("/health", createHealthRouter(deps));
  return app;
}
const fail = (message = "boom") => async () => {
  throw new Error(message);
};

describe("GET /health/live", () => {
  it("is 200 and never touches the database or Redis, even when both are down", async () => {
    const checkDatabase = vi.fn(fail());
    const checkRedis = vi.fn(fail());
    const res = await request(appWith({ checkDatabase, checkRedis })).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "alive" });
    expect(checkDatabase).not.toHaveBeenCalled();
    expect(checkRedis).not.toHaveBeenCalled();
  });

  it("stays 200 while the instance is shutting down (the process is still alive)", async () => {
    expect((await request(appWith({ isShuttingDown: () => true })).get("/health/live")).status).toBe(200);
  });
});

describe("GET /health/ready", () => {
  it("is 200 when the database is reachable (Redis not configured -> 'disabled')", async () => {
    const res = await request(appWith()).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", checks: { database: "ok", redis: "disabled" } });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("is 503 when the database check fails", async () => {
    const res = await request(appWith({ checkDatabase: fail() })).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "unavailable", checks: { database: "fail", redis: "disabled" } });
  });

  it("is 200 and ready when both database and Redis answer", async () => {
    const res = await request(appWith({ checkRedis: async () => undefined })).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ database: "ok", redis: "ok" });
  });

  it("keeps serving (200, degraded) when Redis fails but is NOT required: exams do not depend on it", async () => {
    const res = await request(appWith({ checkRedis: fail(), redisRequired: false })).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", degraded: true, checks: { database: "ok", redis: "fail" } });
  });

  it("is 503 when Redis fails and REDIS_REQUIRED=true", async () => {
    const res = await request(appWith({ checkRedis: fail(), redisRequired: true })).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ database: "ok", redis: "fail" });
  });

  it("is 503 as soon as shutdown starts, so the load balancer drains the instance", async () => {
    const checkDatabase = vi.fn(async () => undefined);
    const res = await request(appWith({ isShuttingDown: () => true, checkDatabase })).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "shutting_down" });
    expect(checkDatabase).not.toHaveBeenCalled();
  });

  it("does not hang on a stuck dependency: it times out and reports 503", async () => {
    const started = Date.now();
    const res = await request(appWith({ checkDatabase: () => new Promise<void>(() => undefined), timeoutMs: 50 })).get("/health/ready");
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("never exposes error text, hosts or credentials", async () => {
    const secret = "password=hunter2 host=db.internal.example:5432";
    const res = await request(appWith({ checkDatabase: fail(secret), checkRedis: fail(secret) })).get("/health/ready");
    const text = JSON.stringify(res.body) + JSON.stringify(res.headers);
    expect(text).not.toMatch(/hunter2|db\.internal|postgres|5432|password/i);
  });

  it("reuses a result for a moment so a burst of probes is one database query", async () => {
    const checkDatabase = vi.fn(async () => undefined);
    const app = appWith({ checkDatabase, cacheMs: 5_000 });
    await Promise.all([request(app).get("/health/ready"), request(app).get("/health/ready")]);
    await request(app).get("/health/ready");
    expect(checkDatabase).toHaveBeenCalledTimes(1);
  });
});
