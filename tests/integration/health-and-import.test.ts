import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, expect, it } from "vitest";
import { app, createApp } from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { connectRedis, redisEnabled } from "../../src/lib/redis";
import { describeDb } from "../helpers/db";
import { call, cleanup, createAdmin, createStudent, type Student } from "../helpers/fixtures";

describeDb("health endpoints against a real database", () => {
  beforeAll(async () => {
    await prisma.$connect(); // like the server does at startup: the first query otherwise takes ~2 s (engine start)
  });

  it("/health/live is 200", async () => {
    const res = await request(app).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "alive" });
  });

  it("/health/ready is 200 when PostgreSQL answers, also under /api/v1 (reachable through an ALB /api/* rule)", async () => {
    for (const path of ["/health/ready", "/api/v1/health/ready"]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(200);
      expect(res.body.status).toBe("ready");
      expect(res.body.checks.database).toBe("ok");
    }
  });

  it("does not set cookies or require authentication/CSRF", async () => {
    const res = await request(app).get("/health/ready");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("/health/ready is 503 when the database is genuinely unreachable, while /health/live stays 200", async () => {
    const unreachable = new PrismaClient({ datasources: { db: { url: "postgresql://nobody:nothing@127.0.0.1:1/none?connect_timeout=1" } }, log: [] });
    try {
      const broken = createApp({
        redis: null,
        health: { checkDatabase: async () => void (await unreachable.$queryRaw`SELECT 1`), timeoutMs: 3_000, cacheMs: 0 }
      });
      const ready = await request(broken).get("/health/ready");
      expect(ready.status).toBe(503);
      expect(ready.body.checks.database).toBe("fail");
      expect(JSON.stringify(ready.body)).not.toMatch(/nobody|nothing|127\.0\.0\.1|postgres/i); // no connection details leak
      expect((await request(broken).get("/health/live")).status).toBe(200);
    } finally {
      await unreachable.$disconnect();
    }
  });
});

describeDb("question import preview/confirm", () => {
  let admin: Student;
  let otherAdmin: Student;
  let student: Student;
  const quizIds: string[] = [];
  const csv = (n: number) =>
    ["Question,OptionA,OptionB,OptionC,OptionD,CorrectAnswer,Explanation,Topic,Marks,NegativeMarks"]
      .concat(Array.from({ length: n }, (_, i) => `Question number ${i} about topic ${i},a,b,c,d,B,because,Topic,2,0.5`))
      .join("\n");

  async function draftQuiz() {
    const quiz = await prisma.quiz.create({
      data: { title: `Import test ${Math.random().toString(36).slice(2, 8)}`, startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 7_200_000), durationMinutes: 30 }
    });
    quizIds.push(quiz.id);
    return quiz.id;
  }
  const preview = (who: Student, quizId: string, content: string) =>
    request(app).post(`/api/v1/admin/quizzes/${quizId}/questions/import/preview`).set("Cookie", who.cookie).set("x-csrf-token", who.csrf).attach("file", Buffer.from(content), "questions.csv");
  const confirm = (who: Student, quizId: string, importId: string) => call(who, "post", `/admin/quizzes/${quizId}/questions/import/confirm`, { importId });
  const questionCount = (quizId: string) => prisma.question.count({ where: { quizId } });

  beforeAll(async () => {
    if (redisEnabled()) expect(await connectRedis()).toBe(true); // the shared client fails fast until connected (the server connects at startup)
    admin = await createAdmin();
    otherAdmin = await createAdmin();
    student = await createStudent((await prisma.stream.create({ data: { code: `IMP${Math.random().toString(36).slice(2, 7)}`, name: "import test" } })).id);
  });
  afterAll(async () => {
    await prisma.quiz.deleteMany({ where: { id: { in: quizIds } } });
    const streamId = (await prisma.user.findUnique({ where: { id: student.id } }))?.streamId;
    await cleanup(undefined, [admin, otherAdmin, student]);
    if (streamId) await prisma.stream.deleteMany({ where: { id: streamId } });
  });

  it("previews, then confirms, and the questions are persisted in PostgreSQL", async () => {
    const quizId = await draftQuiz();
    const p = await preview(admin, quizId, csv(3));
    expect(p.status).toBe(200);
    expect(p.body.validCount).toBe(3);
    expect(p.body.errors).toEqual([]);
    expect(await questionCount(quizId)).toBe(0); // a preview writes nothing to the database

    const c = await confirm(admin, quizId, p.body.importId);
    expect(c.status).toBe(200);
    expect(c.body).toEqual({ imported: 3 });
    expect(await questionCount(quizId)).toBe(3);
    const option = await prisma.questionOption.findMany({ where: { question: { quizId } }, orderBy: [{ questionId: "asc" }, { position: "asc" }] });
    expect(option.filter((o) => o.isCorrect)).toHaveLength(3);
  });

  it("an unknown or malformed token is IMPORT_EXPIRED / VALIDATION_ERROR", async () => {
    const quizId = await draftQuiz();
    const unknown = await confirm(admin, quizId, "00000000-0000-4000-8000-000000000000");
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("IMPORT_EXPIRED");
    expect((await confirm(admin, quizId, "not-a-uuid")).body.error.code).toBe("VALIDATION_ERROR");
  });

  it("a confirmed preview cannot be confirmed again", async () => {
    const quizId = await draftQuiz();
    const p = await preview(admin, quizId, csv(2));
    expect((await confirm(admin, quizId, p.body.importId)).status).toBe(200);
    const again = await confirm(admin, quizId, p.body.importId);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("IMPORT_EXPIRED");
    expect(await questionCount(quizId)).toBe(2);
  });

  it("two simultaneous confirms import exactly once", async () => {
    const quizId = await draftQuiz();
    const p = await preview(admin, quizId, csv(4));
    const results = await Promise.all([confirm(admin, quizId, p.body.importId), confirm(admin, quizId, p.body.importId), confirm(admin, quizId, p.body.importId)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400 && r.body.error.code === "IMPORT_EXPIRED")).toHaveLength(2);
    expect(await questionCount(quizId)).toBe(4); // not 8, not 12
  });

  it("another admin, or the same admin for another quiz, cannot use the token — and it is not burned by the attempt", async () => {
    const quizId = await draftQuiz();
    const otherQuizId = await draftQuiz();
    const p = await preview(admin, quizId, csv(2));
    expect((await confirm(otherAdmin, quizId, p.body.importId)).body.error.code).toBe("IMPORT_EXPIRED");
    expect((await confirm(admin, otherQuizId, p.body.importId)).body.error.code).toBe("IMPORT_EXPIRED");
    expect((await confirm(admin, quizId, p.body.importId)).status).toBe(200); // the rightful owner can still confirm
  });

  it("keeps the preview when the import itself is refused, so the admin can retry without uploading again", async () => {
    const quizId = await draftQuiz();
    const p = await preview(admin, quizId, csv(2));
    await prisma.quiz.update({ where: { id: quizId }, data: { status: "PUBLISHED" } }); // no longer a draft
    const first = await confirm(admin, quizId, p.body.importId);
    expect(first.status).toBe(409);
    expect(first.body.error.code).toBe("INVALID_STATE");
    const second = await confirm(admin, quizId, p.body.importId);
    expect(second.body.error.code).toBe("INVALID_STATE"); // still found (not IMPORT_EXPIRED): it was handed back
    await prisma.quiz.update({ where: { id: quizId }, data: { status: "DRAFT" } });
    expect((await confirm(admin, quizId, p.body.importId)).status).toBe(200);
  });

  it("students cannot use the import endpoints", async () => {
    const quizId = await draftQuiz();
    const res = await preview(student, quizId, csv(1));
    expect(res.status).toBe(403);
  });
});
