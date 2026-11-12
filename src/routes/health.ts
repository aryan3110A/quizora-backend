import { Router } from "express";
import { env } from "../config/env";
import { isShuttingDown } from "../lib/lifecycle";
import { prisma } from "../lib/prisma";
import { getRedis, pingRedis, redisEnabled } from "../lib/redis";

/**
 * Health endpoints for the load balancer (ALB target group) and container orchestration.
 *
 *   GET /health/live   LIVENESS  - "the process is up and the event loop answers". Never touches the database or Redis, so a
 *                      database outage can never make a healthy process look dead (which would restart/replace every instance
 *                      at once and turn a dependency problem into a full outage).
 *   GET /health/ready  READINESS - "this instance can serve traffic": the database answers `SELECT 1`; and, when Redis is
 *                      configured, Redis answers PING. 200 if ready, 503 otherwise (also 503 while shutting down, so the load
 *                      balancer drains the instance before it exits).
 *
 * Redis is a REQUIRED dependency of readiness only when REDIS_REQUIRED=true. By default a Redis failure is reported
 * (`redis:"fail"`, `degraded:true`) but the instance stays in service: rate limiting then degrades to per-instance counters and
 * exams do not use Redis at all. Responses contain statuses only: no hostnames, errors, versions or credentials.
 */

export type HealthDeps = {
  checkDatabase: () => Promise<void>;
  /** null when Redis is not configured. */
  checkRedis: (() => Promise<void>) | null;
  redisRequired: boolean;
  isShuttingDown: () => boolean;
  /** Per-check timeout. */
  timeoutMs?: number;
  /** Readiness results are reused for this long, so a flood of probes cannot become a flood of queries. */
  cacheMs?: number;
};

export function defaultHealthDeps(): HealthDeps {
  const redis = redisEnabled() ? getRedis() : null;
  return {
    checkDatabase: async () => {
      await prisma.$queryRaw`SELECT 1`;
    },
    checkRedis: redis
      ? async () => {
          if (!(await pingRedis(redis, 1_000))) throw new Error("redis not ready");
        }
      : null,
    redisRequired: env.REDIS_REQUIRED,
    isShuttingDown
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type ReadyBody = {
  status: "ready" | "unavailable" | "shutting_down";
  degraded?: true;
  checks?: { database: "ok" | "fail"; redis: "ok" | "fail" | "disabled" };
};

export function createHealthRouter(deps: HealthDeps): Router {
  const router = Router();
  const timeoutMs = deps.timeoutMs ?? 2_000;
  const cacheMs = deps.cacheMs ?? 1_000;
  type Result = { code: number; body: ReadyBody };
  let cached: (Result & { at: number }) | undefined;
  let inflight: Promise<Result> | undefined;

  async function check(): Promise<Result> {
    const [database, redis] = await Promise.all([
      withTimeout(deps.checkDatabase(), timeoutMs).then(() => true, () => false),
      deps.checkRedis ? withTimeout(deps.checkRedis(), timeoutMs).then(() => true, () => false) : Promise.resolve(null)
    ]);
    const redisFailed = redis === false;
    const ready = database && !(redisFailed && deps.redisRequired);
    const body: ReadyBody = {
      status: ready ? "ready" : "unavailable",
      ...(ready && redisFailed ? { degraded: true as const } : {}),
      checks: { database: database ? "ok" : "fail", redis: redis === null ? "disabled" : redis ? "ok" : "fail" }
    };
    return { code: ready ? 200 : 503, body };
  }

  router.get("/live", (_req, res) => {
    res.set("Cache-Control", "no-store").status(200).json({ status: "alive" });
  });

  router.get("/ready", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    if (deps.isShuttingDown()) {
      res.status(503).json({ status: "shutting_down" } satisfies ReadyBody);
      return;
    }
    if (cached && Date.now() - cached.at < cacheMs) {
      res.status(cached.code).json(cached.body);
      return;
    }
    // Probes that arrive while a check is running share it: a burst costs one database query, not one per probe.
    inflight ??= check().finally(() => {
      inflight = undefined;
    });
    const result = await inflight;
    cached = { at: Date.now(), ...result };
    res.status(result.code).json(result.body);
  });

  return router;
}
