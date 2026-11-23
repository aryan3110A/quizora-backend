import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";

/**
 * Rate limiting is keyed by client IP, so the proxy configuration decides WHO gets limited:
 *   - too little trust (0 behind an ALB): every user shares the ALB's address and one student locks out everybody;
 *   - too much trust (`true`): a client types its own X-Forwarded-For and escapes the limit.
 * supertest connects from 127.0.0.1, which plays the role of "the load balancer" (the direct TCP peer of the app).
 * An empty JSON body makes /auth/login answer 400 before it needs a database, so these tests only measure the limiter.
 */
const LIMIT = 3;
const instance = (trustProxyHops: number) =>
  createApp({ trustProxyHops, redis: null, authRateLimit: { windowMs: 60_000, max: LIMIT } });

async function hit(app: ReturnType<typeof createApp>, forwardedFor?: string) {
  const req = request(app).post("/api/v1/auth/login").send({});
  if (forwardedFor) req.set("X-Forwarded-For", forwardedFor);
  return (await req).status;
}

describe("auth rate limit and client-IP detection behind a proxy", () => {
  // express-rate-limit warns (console.error) when X-Forwarded-For arrives but no proxy is trusted; that is the point of the case.
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  it("returns 429 with a JSON error once the limit is exceeded, with standard rate-limit headers", async () => {
    const app = instance(0);
    for (let i = 0; i < LIMIT; i++) expect(await hit(app)).toBe(400);
    const res = await request(app).post("/api/v1/auth/login").send({});
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: { code: "RATE_LIMITED", message: expect.any(String) } });
    expect(res.headers["ratelimit-limit"]).toBe(String(LIMIT));
  });

  it("with no trusted proxy (0 hops) a client-supplied X-Forwarded-For is ignored, so it cannot be used to dodge the limit", async () => {
    const app = instance(0);
    expect(await hit(app, "1.1.1.1")).toBe(400);
    expect(await hit(app, "2.2.2.2")).toBe(400);
    expect(await hit(app, "3.3.3.3")).toBe(400);
    expect(await hit(app, "4.4.4.4")).toBe(429); // same real peer, whatever the header says
  });

  it("behind one ALB (1 hop) users are limited individually: the address the ALB appended is used, not the client's claim", async () => {
    const app = instance(1);
    // The ALB appends the real client address on the right; anything further left was typed by the client.
    for (let i = 0; i < LIMIT; i++) expect(await hit(app, `spoof-${i}, 198.51.100.7`)).toBe(400);
    expect(await hit(app, "yet-another-spoof, 198.51.100.7")).toBe(429); // same real client: limited despite changing the spoofed part
    expect(await hit(app, "198.51.100.8")).toBe(400); // a different real client has its own allowance
    expect(await hit(app, "198.51.100.9")).toBe(400);
  });

  it("behind CloudFront + ALB (2 hops) the client address two hops from the app is used", async () => {
    const app = instance(2);
    // X-Forwarded-For as the app sees it: "<client>, <CloudFront edge appended by the ALB>"
    for (let i = 0; i < LIMIT; i++) expect(await hit(app, `spoof, 198.51.100.7, 10.0.${i}.5`)).toBe(400); // edge address varies
    expect(await hit(app, "spoof2, 198.51.100.7, 10.0.9.5")).toBe(429);
    expect(await hit(app, "spoof, 198.51.100.8, 10.0.0.5")).toBe(400);
  });

  it("with the wrong hop count the whole user base would share one bucket (documented failure mode of trusting too little)", async () => {
    const app = instance(0); // misconfigured: an ALB is in front but no hop is trusted
    expect(await hit(app, "198.51.100.1")).toBe(400);
    expect(await hit(app, "198.51.100.2")).toBe(400);
    expect(await hit(app, "198.51.100.3")).toBe(400);
    expect(await hit(app, "198.51.100.4")).toBe(429); // a 4th, different user is blocked
  });
});
