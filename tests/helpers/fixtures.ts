import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { sha256 } from "../../src/middleware/auth";

export type ExamQuestion = { id: string; optionIds: string[]; correctOptionId: string };
export type Exam = {
  streamId: string;
  quizId: string;
  marks: number;
  negativeMarks: number;
  questions: ExamQuestion[];
};
export type Student = { id: string; cookie: string[]; csrf: string };

const MINUTE = 60_000;
export const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * MINUTE);

/** A published quiz. Option index 0 ("A") is always the correct one. */
export async function createExam(
  options: { questionCount?: number; marks?: number; negativeMarks?: number; endsInMinutes?: number; durationMinutes?: number } = {}
): Promise<Exam> {
  const { questionCount = 3, marks = 2, negativeMarks = 0.5, endsInMinutes = 60, durationMinutes = 30 } = options;
  const suffix = randomUUID().slice(0, 8);
  const stream = await prisma.stream.create({ data: { code: `T${suffix}`, name: `Test stream ${suffix}` } });
  const quiz = await prisma.quiz.create({
    data: {
      title: `Reliability test ${suffix}`,
      startsAt: minutesFromNow(-120),
      endsAt: minutesFromNow(endsInMinutes),
      durationMinutes,
      defaultMarks: marks,
      status: "PUBLISHED",
      publishedAt: new Date(),
      streams: { create: [{ streamId: stream.id }] }
    }
  });
  const questions: ExamQuestion[] = [];
  for (let i = 0; i < questionCount; i++) {
    const question = await prisma.question.create({
      data: {
        quizId: quiz.id,
        text: `Question ${i + 1}`,
        marks,
        negativeMarks,
        position: i,
        options: { create: [0, 1, 2, 3].map((j) => ({ text: `Option ${"ABCD"[j]}`, position: j, isCorrect: j === 0 })) }
      },
      include: { options: { orderBy: { position: "asc" } } }
    });
    questions.push({ id: question.id, optionIds: question.options.map((o) => o.id), correctOptionId: question.options[0].id });
  }
  return { streamId: stream.id, quizId: quiz.id, marks, negativeMarks, questions };
}

/** A student plus a real session row, so requests go through the real auth + CSRF middleware. */
export async function createStudent(streamId: string): Promise<Student> {
  const suffix = randomUUID();
  const user = await prisma.user.create({
    data: { studentId: `test-${suffix}`, passwordHash: "not-a-real-hash", fullName: `Test ${suffix.slice(0, 8)}`, role: "STUDENT", streamId, mustChangePassword: false }
  });
  const token = randomBytes(32).toString("base64url");
  await prisma.session.create({ data: { tokenHash: sha256(token), userId: user.id, expiresAt: minutesFromNow(60) } });
  const csrf = randomBytes(16).toString("base64url");
  return { id: user.id, cookie: [`quizora_session=${token}`, `quizora_csrf=${csrf}`], csrf };
}

/** An administrator with a real session (same shape as a student, so `call()` works for both). */
export async function createAdmin(): Promise<Student> {
  const suffix = randomUUID();
  const user = await prisma.user.create({
    data: { studentId: `test-admin-${suffix}`, passwordHash: "not-a-real-hash", fullName: "Test Admin", role: "ADMIN", mustChangePassword: false }
  });
  const token = randomBytes(32).toString("base64url");
  await prisma.session.create({ data: { tokenHash: sha256(token), userId: user.id, expiresAt: minutesFromNow(60) } });
  const csrf = randomBytes(16).toString("base64url");
  return { id: user.id, cookie: [`quizora_session=${token}`, `quizora_csrf=${csrf}`], csrf };
}

type Method = "get" | "post" | "put";
export function call(student: Student, method: Method, path: string, body?: unknown) {
  const req = request(app)[method](`/api/v1${path}`).set("Cookie", student.cookie).set("x-csrf-token", student.csrf);
  return method === "get" ? req : req.send(body ?? {});
}

export type StartedAttempt = { id: string; questions: Array<{ id: string; options: Array<{ id: string }> }> };
export async function startAttempt(student: Student, quizId: string): Promise<StartedAttempt> {
  const res = await call(student, "post", `/student/quizzes/${quizId}/attempts`);
  if (res.status !== 200) throw new Error(`start attempt failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as StartedAttempt;
}

/** `seq` is the optional per-question client sequence number; omit it to behave like a legacy client. */
export const saveAnswer = (student: Student, attemptId: string, questionId: string, selectedOptionId: string | null, seq?: number) =>
  call(student, "put", `/student/attempts/${attemptId}/answers/${questionId}`, seq === undefined ? { selectedOptionId } : { selectedOptionId, seq });

export const submit = (student: Student, attemptId: string) => call(student, "post", `/student/attempts/${attemptId}/submit`);

/** Creates an attempt directly in the database (bypasses the start route), e.g. already past its deadline. */
export async function createAttemptDirect(userId: string, exam: Exam, deadlineAt: Date) {
  return prisma.attempt.create({
    data: {
      quizId: exam.quizId,
      userId,
      startedAt: minutesFromNow(-45),
      deadlineAt,
      questions: { create: exam.questions.map((q, i) => ({ questionId: q.id, displayOrder: i, optionOrderSnapshot: q.optionIds })) }
    }
  });
}

/** Makes an existing attempt look expired without waiting for real time to pass. */
export const expireAttempt = (attemptId: string) =>
  prisma.attempt.update({ where: { id: attemptId }, data: { deadlineAt: minutesFromNow(-10) } });

export const answerRows = (attemptId: string) => prisma.attemptAnswer.findMany({ where: { attemptId } });
export const getAttempt = (attemptId: string) => prisma.attempt.findUniqueOrThrow({ where: { id: attemptId } });

/** Removes everything a test created, in foreign-key-safe order. */
export async function cleanup(exam: Exam | undefined, students: Student[]) {
  if (exam) await prisma.attempt.deleteMany({ where: { quizId: exam.quizId } });
  if (students.length) await prisma.user.deleteMany({ where: { id: { in: students.map((s) => s.id) } } });
  if (exam) {
    await prisma.quiz.deleteMany({ where: { id: exam.quizId } });
    await prisma.stream.deleteMany({ where: { id: exam.streamId } });
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
