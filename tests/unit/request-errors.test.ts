import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";

/**
 * Client mistakes must be answered with a 4xx. A 500 would be counted as a server fault (and would trip a 5xx alarm on the load
 * balancer) and tells the client nothing useful. These are the errors raised by Express' own body parser.
 */
describe("malformed requests are 4xx, never 500", () => {
  const app = createApp({ redis: null });

  it("a JSON body over the 1 MB limit -> 413 PAYLOAD_TOO_LARGE", async () => {
    const res = await request(app).post("/api/v1/auth/login").set("Content-Type", "application/json").send(`{"studentId":"${"a".repeat(1_100_000)}"}`);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: { code: "PAYLOAD_TOO_LARGE", message: expect.any(String) } });
  });

  it("malformed JSON -> 400 INVALID_JSON", async () => {
    const res = await request(app).post("/api/v1/auth/login").set("Content-Type", "application/json").send('{"studentId": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });

  it("does not leak parser details in the message", async () => {
    const res = await request(app).post("/api/v1/auth/login").set("Content-Type", "application/json").send("{nope");
    expect(JSON.stringify(res.body)).not.toMatch(/Unexpected token|SyntaxError|position|body-parser/i);
  });

  it("valid requests are unaffected (empty object still reaches validation -> 400 VALIDATION_ERROR)", async () => {
    const res = await request(app).post("/api/v1/auth/login").send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("unknown routes are still a JSON 404", async () => {
    const res = await request(app).get("/api/v1/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
