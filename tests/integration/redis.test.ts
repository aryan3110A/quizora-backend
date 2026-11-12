import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { closeRedis, connectRedis, getRedis, pingRedis, redisEnabled } from "../../src/lib/redis";
import { RedisRateLimitStore } from "../../src/lib/rateLimitStore";
import { RedisImportPreviewStore, type ImportPreview } from "../../src/services/importStore";
import { closeTestClients, describeRedis, newDeadClient, newReadyClient, testPrefix } from "../helpers/redis";
import { sleep } from "../helpers/fixtures";

afterAll(async () => {
  await closeTestClients();
  await closeRedis();
});

const preview = (n = 2): ImportPreview => ({
  adminId: "admin-1",
  quizId: "quiz-1",
  questions: Array.from({ length: n }, (_, i) => ({
    question: `Q${i}`, optionA: "a", optionB: "b", optionC: "c", optionD: "d", correctAnswer: "B" as const, marks: 2, negativeMarks: 0.5, row: i + 2
  }))
});

describeRedis("Redis client service", () => {
  it("is enabled from REDIS_URL and hands out ONE shared client per process", async () => {
    expect(redisEnabled()).toBe(true);
    const a = getRedis();
    expect(a).not.toBeNull();
    expect(getRedis()).toBe(a);
    expect(await connectRedis()).toBe(true);
    expect(await pingRedis()).toBe(true);
  });

  it("closes gracefully, is safe to close twice, and opens a fresh client afterwards", async () => {
    const before = getRedis();
    await closeRedis();
    await closeRedis();
    const after = getRedis();
    expect(after).not.toBe(before);
    expect(await connectRedis()).toBe(true);
  });

  it("pingRedis is false (not an exception) for an unreachable Redis", async () => {
    expect(await pingRedis(newDeadClient(), 500)).toBe(false);
  });
});

describeRedis("RedisRateLimitStore", () => {
  const options = (windowMs: number) => ({ windowMs }) as never;

  it("shares one counter between independent clients (= backend instances)", async () => {
    const prefix = testPrefix("rl-shared");
    const a = new RedisRateLimitStore(await newReadyClient(), prefix);
    const b = new RedisRateLimitStore(await newReadyClient(), prefix);
    a.init(options(60_000));
    b.init(options(60_000));
    expect((await a.increment("1.2.3.4")).totalHits).toBe(1);
    expect((await b.increment("1.2.3.4")).totalHits).toBe(2);
    expect((await a.increment("1.2.3.4")).totalHits).toBe(3);
    expect((await b.increment("5.6.7.8")).totalHits).toBe(1); // another client IP: its own counter
  });

  it("is a fixed window that starts at the first hit and then resets", async () => {
    const store = new RedisRateLimitStore(await newReadyClient(), testPrefix("rl-window"));
    store.init(options(1_200));
    const first = await store.increment("ip");
    expect(first.totalHits).toBe(1);
    const left = first.resetTime!.getTime() - Date.now();
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(1_200);
    expect((await store.increment("ip")).totalHits).toBe(2);
    await sleep(1_400);
    expect((await store.increment("ip")).totalHits).toBe(1);
  });

  it("counts correctly under concurrent increments from several instances", async () => {
    const prefix = testPrefix("rl-race");
    const stores = await Promise.all([0, 1, 2, 3].map(async () => {
      const s = new RedisRateLimitStore(await newReadyClient(), prefix);
      s.init(options(60_000));
      return s;
    }));
    const hits = await Promise.all(Array.from({ length: 40 }, (_, i) => stores[i % 4].increment("ip")));
    expect(hits.map((h) => h.totalHits).sort((x, y) => x - y)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1)); // no lost or duplicate counts
  });

  it("supports decrement and reset", async () => {
    const store = new RedisRateLimitStore(await newReadyClient(), testPrefix("rl-ops"));
    store.init(options(60_000));
    await store.increment("ip");
    await store.increment("ip");
    await store.decrement("ip");
    expect((await store.increment("ip")).totalHits).toBe(2);
    await store.resetKey("ip");
    expect((await store.increment("ip")).totalHits).toBe(1);
  });

  it("falls back to per-instance counting instead of failing when Redis is down", async () => {
    const store = new RedisRateLimitStore(newDeadClient(), testPrefix("rl-dead"));
    store.init(options(60_000));
    expect((await store.increment("ip")).totalHits).toBe(1);
    expect((await store.increment("ip")).totalHits).toBe(2);
  });
});

describeRedis("rate limit across two backend instances", () => {
  const LIMIT = 3;
  const login = (app: ReturnType<typeof createApp>) => request(app).post("/api/v1/auth/login").send({});

  it("one limit applies to the whole fleet: requests served by A and B count together", async () => {
    // Two instances = two apps, each with ITS OWN Redis connection; they share only Redis.
    const options = { authRateLimit: { windowMs: 60_000, max: LIMIT } };
    const instanceA = createApp({ ...options, redis: await newReadyClient() });
    const instanceB = createApp({ ...options, redis: await newReadyClient() });
    const keyPrefix = process.env.REDIS_KEY_PREFIX;
    expect(keyPrefix).toBeTruthy();

    expect((await login(instanceA)).status).toBe(400); // hit 1
    expect((await login(instanceA)).status).toBe(400); // hit 2
    expect((await login(instanceB)).status).toBe(400); // hit 3 (on the other instance) - still within the limit
    const blockedOnB = await login(instanceB);
    expect(blockedOnB.status).toBe(429); // hit 4 is refused although B itself only saw two requests
    expect((await login(instanceA)).status).toBe(429); // and A refuses too
    expect(blockedOnB.body.error.code).toBe("RATE_LIMITED");
  });

  it("keeps serving, with per-instance limits, when Redis is unreachable (never a 500)", async () => {
    const app = createApp({ authRateLimit: { windowMs: 60_000, max: LIMIT }, redis: newDeadClient() });
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT + 2; i++) statuses.push((await login(app)).status);
    expect(statuses).toEqual([400, 400, 400, 429, 429]);
  });
});

describeRedis("RedisImportPreviewStore", () => {
  it("hands a preview from one instance to another (shared through Redis)", async () => {
    const prefix = testPrefix("imp");
    const instanceA = new RedisImportPreviewStore(await newReadyClient(), prefix);
    const instanceB = new RedisImportPreviewStore(await newReadyClient(), prefix);
    await instanceA.put("tok-1", preview(3));
    const seenByB = await instanceB.get("tok-1");
    expect(seenByB?.questions).toHaveLength(3);
    expect(seenByB?.adminId).toBe("admin-1");
    expect((await instanceB.take("tok-1"))?.questions).toHaveLength(3);
    expect(await instanceA.get("tok-1")).toBeNull(); // consumed for everybody
  });

  it("stores previews with a TTL (default 15 minutes) so they cannot pile up", async () => {
    const client = await newReadyClient();
    const prefix = testPrefix("imp-ttl");
    const store = new RedisImportPreviewStore(client, prefix);
    await store.put("tok", preview());
    const ttl = await client.pttl(`${prefix}import:tok`);
    expect(ttl).toBeGreaterThan(800_000);
    expect(ttl).toBeLessThanOrEqual(900_000);
  });

  it("treats an expired preview as missing", async () => {
    const store = new RedisImportPreviewStore(await newReadyClient(), testPrefix("imp-exp"));
    await store.put("tok", preview(), 1);
    await sleep(1_300);
    expect(await store.get("tok")).toBeNull();
    expect(await store.take("tok")).toBeNull();
  });

  it("returns null for an unknown token and for a corrupt entry", async () => {
    const client = await newReadyClient();
    const prefix = testPrefix("imp-bad");
    const store = new RedisImportPreviewStore(client, prefix);
    expect(await store.get("missing")).toBeNull();
    await client.set(`${prefix}import:corrupt`, "{not json", "EX", 60);
    expect(await store.get("corrupt")).toBeNull();
  });

  it("take() is atomic across instances: of many concurrent confirms exactly one gets the preview", async () => {
    const prefix = testPrefix("imp-atomic");
    const stores = await Promise.all([0, 1, 2, 3].map(async () => new RedisImportPreviewStore(await newReadyClient(), prefix)));
    await stores[0].put("tok", preview());
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => stores[i % 4].take("tok")));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("can be restored after a failed import", async () => {
    const store = new RedisImportPreviewStore(await newReadyClient(), testPrefix("imp-restore"));
    await store.put("tok", preview(2));
    const taken = await store.take("tok");
    await store.put("tok", taken as ImportPreview);
    expect((await store.get("tok"))?.questions).toHaveLength(2);
  });

  it("fails with 503 IMPORT_STORE_UNAVAILABLE when Redis is down — it must not silently keep the preview in one instance's memory", async () => {
    const store = new RedisImportPreviewStore(newDeadClient(), testPrefix("imp-dead"));
    for (const op of [() => store.put("t", preview()), () => store.get("t"), () => store.take("t")]) {
      await expect(op()).rejects.toMatchObject({ status: 503, code: "IMPORT_STORE_UNAVAILABLE" });
    }
  });
});
