import { afterAll, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { runFinalizerOnce } from "../../src/services/finalizer";
import { describeDb } from "../helpers/db";
import {
  call, cleanup, createAdmin, createAttemptDirect, createExam, createStudent, minutesFromNow, saveAnswer, startAttempt, submit,
  type Exam, type Student
} from "../helpers/fixtures";

/** Every response field that reveals a result, a mark or an answer key. */
const SENSITIVE = new Set(["score", "totalMarks", "percentage", "averageScore", "latestScore", "correctAnswer", "explanation", "isCorrect", "selectedAnswer"]);

/** Returns every sensitive field in `body` that carries an actual value (null/undefined are fine). */
function leaks(body: unknown, found: Array<[string, unknown]> = [], path = "$"): Array<[string, unknown]> {
  if (Array.isArray(body)) body.forEach((item, i) => leaks(item, found, `${path}[${i}]`));
  else if (body && typeof body === "object") {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (SENSITIVE.has(key) && value !== null && value !== undefined) found.push([`${path}.${key}`, value]);
      leaks(value, found, `${path}.${key}`);
    }
  }
  return found;
}

describeDb("hidden results protection", () => {
  let exam: Exam;
  let closedExam: Exam;
  let admin: Student;
  const students: Student[] = [];
  const newStudent = async (forExam: Exam = exam) => {
    const s = await createStudent(forExam.streamId);
    students.push(s);
    return s;
  };

  beforeAll(async () => {
    exam = await createExam({ questionCount: 3, marks: 7, negativeMarks: 0 });
    closedExam = await createExam({ questionCount: 3, marks: 7, negativeMarks: 0, endsInMinutes: -5 });
    admin = await createAdmin();
    students.push(admin);
  });
  afterAll(async () => {
    await cleanup(closedExam, []);
    await cleanup(exam, students);
  });

  /** Every student-facing endpoint that could possibly carry a result. */
  async function sweepStudentEndpoints(student: Student, attemptId: string, quizId: string) {
    const responses = {
      dashboard: await call(student, "get", "/student/dashboard"),
      performance: await call(student, "get", "/student/performance"),
      result: await call(student, "get", `/student/attempts/${attemptId}/result`),
      attempt: await call(student, "get", `/student/attempts/${attemptId}`),
      status: await call(student, "get", `/student/attempts/${attemptId}/status`),
      restart: await call(student, "post", `/student/quizzes/${quizId}/attempts`),
      available: await call(student, "get", "/student/quizzes/available"),
      upcoming: await call(student, "get", "/student/quizzes/upcoming"),
      notifications: await call(student, "get", "/student/notifications"),
      resubmit: await submit(student, attemptId)
    };
    return responses;
  }

  it("never returns the score from the submit endpoint — fresh, repeated or concurrent", async () => {
    const student = await newStudent();
    const attempt = await startAttempt(student, exam.quizId);
    await saveAnswer(student, attempt.id, exam.questions[0].id, exam.questions[0].correctOptionId);

    const [first, ...others] = await Promise.all([submit(student, attempt.id), submit(student, attempt.id), submit(student, attempt.id)]);
    for (const res of [first, ...others, await submit(student, attempt.id)]) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, finalized: true });
      expect(leaks(res.body)).toEqual([]);
    }
    // ...although it IS stored for later release.
    expect((await prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } })).score).toBe(7);
  });

  it("exposes no result field anywhere in the student API while the quiz is still open", async () => {
    const student = await newStudent();
    const attempt = await startAttempt(student, exam.quizId);
    await saveAnswer(student, attempt.id, exam.questions[0].id, exam.questions[0].correctOptionId);
    await submit(student, attempt.id);

    const responses = await sweepStudentEndpoints(student, attempt.id, exam.quizId);
    for (const [name, res] of Object.entries(responses)) {
      expect(leaks(res.body), `endpoint "${name}" leaked a hidden result field`).toEqual([]);
    }
    expect(responses.result.body).toEqual({ released: false });
    expect(responses.performance.body.results).toEqual([]);
    expect(responses.dashboard.body.stats.averageScore).toBeNull();
    const completed = responses.dashboard.body.completed.find((c: { attemptId: string }) => c.attemptId === attempt.id);
    expect(completed).toMatchObject({ isReleased: false, score: null, totalMarks: null, percentage: null });
  });

  it("keeps results hidden after the quiz closes until the attempt is finalized", async () => {
    // Quiz already closed, attempt past its deadline but not yet finalized (the worker has not run).
    const student = await newStudent(closedExam);
    const attempt = await createAttemptDirect(student.id, closedExam, minutesFromNow(-10));
    await prisma.attemptAnswer.create({ data: { attemptId: attempt.id, questionId: closedExam.questions[0].id, selectedOptionId: closedExam.questions[0].correctOptionId } });

    const before = await call(student, "get", `/student/attempts/${attempt.id}/result`);
    expect(before.body).toEqual({ released: false });
    expect(leaks((await call(student, "get", "/student/dashboard")).body)).toEqual([]);
    expect(leaks((await call(student, "get", "/student/performance")).body)).toEqual([]);

    await runFinalizerOnce();
    const after = await call(student, "get", `/student/attempts/${attempt.id}/result`);
    expect(after.body).toMatchObject({ released: true, score: 7, totalMarks: 21 });
  });

  it("releases the result — and only then — once the quiz has closed and the attempt is finalized", async () => {
    const student = await newStudent();
    const attempt = await startAttempt(student, exam.quizId);
    await saveAnswer(student, attempt.id, exam.questions[0].id, exam.questions[0].correctOptionId);
    await submit(student, attempt.id);
    expect((await call(student, "get", `/student/attempts/${attempt.id}/result`)).body).toEqual({ released: false });

    await prisma.quiz.update({ where: { id: exam.quizId }, data: { endsAt: new Date(Date.now() - 1000) } });
    const result = await call(student, "get", `/student/attempts/${attempt.id}/result`);
    expect(result.body).toMatchObject({ released: true, score: 7, totalMarks: 21 });
    const dashboard = await call(student, "get", "/student/dashboard");
    expect(dashboard.body.completed.find((c: { attemptId: string }) => c.attemptId === attempt.id)).toMatchObject({ isReleased: true, score: 7, totalMarks: 21 });
    expect((await call(student, "get", "/student/performance")).body.totalAttempts).toBe(1);
    await prisma.quiz.update({ where: { id: exam.quizId }, data: { endsAt: minutesFromNow(60) } });
  });

  it("does not let one student read another student's result, status or attempt", async () => {
    const owner = await newStudent();
    const other = await newStudent();
    const attempt = await startAttempt(owner, exam.quizId);
    await submit(owner, attempt.id);
    await prisma.quiz.update({ where: { id: exam.quizId }, data: { endsAt: new Date(Date.now() - 1000) } }); // even when released to the owner
    for (const path of [`/student/attempts/${attempt.id}/result`, `/student/attempts/${attempt.id}/status`, `/student/attempts/${attempt.id}`]) {
      const res = await call(other, "get", path);
      expect(res.status, path).toBe(404);
      expect(leaks(res.body)).toEqual([]);
    }
    await prisma.quiz.update({ where: { id: exam.quizId }, data: { endsAt: minutesFromNow(60) } });
  });

  it("rejects unauthenticated access to result and status endpoints", async () => {
    const student = await newStudent();
    const attempt = await startAttempt(student, exam.quizId);
    for (const path of [`/api/v1/student/attempts/${attempt.id}/result`, `/api/v1/student/attempts/${attempt.id}/status`, "/api/v1/student/dashboard"]) {
      expect((await request(app).get(path)).status, path).toBe(401);
    }
  });

  it("keeps administrators' authorized access to results, and keeps students out of admin routes", async () => {
    const student = await newStudent();
    const attempt = await startAttempt(student, exam.quizId);
    await saveAnswer(student, attempt.id, exam.questions[0].id, exam.questions[0].correctOptionId);
    await submit(student, attempt.id);
    // Still hidden from the student...
    expect((await call(student, "get", `/student/attempts/${attempt.id}/result`)).body).toEqual({ released: false });

    // ...but visible to the administrator (admin dashboard lists recent attempts with scores).
    const dashboard = await call(admin, "get", "/admin/dashboard");
    expect(dashboard.status).toBe(200);
    const row = dashboard.body.recentAttempts.find((a: { id: string }) => a.id === attempt.id);
    expect(row).toMatchObject({ score: 7, totalMarks: 21 });

    // Students cannot use admin endpoints to get at the same data.
    for (const path of ["/admin/dashboard", "/admin/students"]) {
      const res = await call(student, "get", path);
      expect(res.status, path).toBe(403);
      expect(leaks(res.body)).toEqual([]);
    }
  });
});
