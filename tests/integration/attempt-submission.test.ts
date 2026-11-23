import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { describeDb } from "../helpers/db";
import {
  answerRows, call, cleanup, createExam, createStudent, getAttempt, saveAnswer, startAttempt, submit,
  type Exam, type Student
} from "../helpers/fixtures";

describeDb("normal examination submission", () => {
  let exam: Exam;
  const students: Student[] = [];
  const newStudent = async () => {
    const s = await createStudent(exam.streamId);
    students.push(s);
    return s;
  };

  beforeAll(async () => {
    exam = await createExam({ questionCount: 3, marks: 2, negativeMarks: 0.5 });
  });
  afterAll(async () => {
    await cleanup(exam, students);
  });

  it("starts an attempt and never exposes the answer key", async () => {
    const student = await newStudent();
    const res = await call(student, "post", `/student/quizzes/${exam.quizId}/attempts`);
    expect(res.status).toBe(200);
    expect(res.body.questions).toHaveLength(3);
    expect(JSON.stringify(res.body)).not.toContain("isCorrect");
  });

  it("submits on time, scores on the server (+marks, -negative marks, unanswered = 0) and is idempotent", async () => {
    const student = await newStudent();
    const attempt = await startAttempt(student, exam.quizId);
    const [q1, q2] = exam.questions;
    expect((await saveAnswer(student, attempt.id, q1.id, q1.correctOptionId)).status).toBe(200); // +2
    expect((await saveAnswer(student, attempt.id, q2.id, q2.optionIds[1])).status).toBe(200); // -0.5, q3 unanswered

    const first = await submit(student, attempt.id);
    expect(first.status).toBe(200);
    // The score is stored (checked below) but never returned here: results are released only after the quiz closes.
    expect(first.body).toEqual({ ok: true, finalized: true });

    const row = await getAttempt(attempt.id);
    expect(row.status).toBe("SUBMITTED");
    expect(row.score).toBe(1.5);
    expect(row.totalMarks).toBe(6);
    expect(row.submittedAt).not.toBeNull();
    expect(row.finalizedAt).not.toBeNull();

    const second = await submit(student, attempt.id);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true, finalized: true });
    const after = await getAttempt(attempt.id);
    expect(after.finalizedAt).toEqual(row.finalizedAt);
    expect(after.submittedAt).toEqual(row.submittedAt);
    expect(after.score).toBe(1.5);
  });

  it("rejects any answer change after final submission and leaves the stored answer untouched", async () => {
    const student = await newStudent();
    const attempt = await startAttempt(student, exam.quizId);
    const q = exam.questions[0];
    await saveAnswer(student, attempt.id, q.id, q.correctOptionId);
    await submit(student, attempt.id);

    const late = await saveAnswer(student, attempt.id, q.id, q.optionIds[2]);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("ATTEMPT_CLOSED");
    const clear = await saveAnswer(student, attempt.id, q.id, null);
    expect(clear.status).toBe(409);

    const rows = await answerRows(attempt.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].selectedOptionId).toBe(q.correctOptionId);
    expect((await getAttempt(attempt.id)).score).toBe(2);
  });

  it("lets a student clear an answer while the attempt is open (cleared = unanswered)", async () => {
    const student = await newStudent();
    const attempt = await startAttempt(student, exam.quizId);
    const q = exam.questions[0];
    await saveAnswer(student, attempt.id, q.id, q.correctOptionId);
    expect((await saveAnswer(student, attempt.id, q.id, null)).status).toBe(200);
    expect((await answerRows(attempt.id))[0].selectedOptionId).toBeNull();
    await submit(student, attempt.id);
    expect((await getAttempt(attempt.id)).score).toBe(0);
  });

  it("keeps validating the option and question like before", async () => {
    const student = await newStudent();
    const attempt = await startAttempt(student, exam.quizId);
    const [q1, q2] = exam.questions;
    const wrongOption = await saveAnswer(student, attempt.id, q1.id, q2.optionIds[0]);
    expect(wrongOption.status).toBe(400);
    expect(wrongOption.body.error.code).toBe("INVALID_OPTION");
    const unknownQuestion = await saveAnswer(student, attempt.id, "11111111-1111-4111-8111-111111111111", q1.optionIds[0]);
    expect(unknownQuestion.status).toBe(404);
  });

  it("is ownership-checked: another student cannot save to or submit someone else's attempt", async () => {
    const owner = await newStudent();
    const intruder = await newStudent();
    const attempt = await startAttempt(owner, exam.quizId);
    const q = exam.questions[0];
    expect((await saveAnswer(intruder, attempt.id, q.id, q.correctOptionId)).status).toBe(404);
    expect((await submit(intruder, attempt.id)).status).toBe(404);
    expect((await getAttempt(attempt.id)).status).toBe("IN_PROGRESS");
  });

  it("answers malformed ids with 404 instead of a server error", async () => {
    const student = await newStudent();
    expect((await submit(student, "not-a-uuid")).status).toBe(404);
    expect((await saveAnswer(student, "not-a-uuid", exam.questions[0].id, null)).status).toBe(404);
  });

  it("keeps the delayed result-release rule: hidden until the quiz closes, then released", async () => {
    const student = await newStudent();
    const attempt = await startAttempt(student, exam.quizId);
    const q = exam.questions[0];
    await saveAnswer(student, attempt.id, q.id, q.correctOptionId);
    await submit(student, attempt.id);

    const before = await call(student, "get", `/student/attempts/${attempt.id}/result`);
    expect(before.body).toEqual({ released: false });

    await prisma.quiz.update({ where: { id: exam.quizId }, data: { endsAt: new Date(Date.now() - 1000) } });
    const after = await call(student, "get", `/student/attempts/${attempt.id}/result`);
    expect(after.body.released).toBe(true);
    expect(after.body.score).toBe(2);
    expect(after.body.totalMarks).toBe(6);
    // restore the window for any later test in this file
    await prisma.quiz.update({ where: { id: exam.quizId }, data: { endsAt: new Date(Date.now() + 60 * 60_000) } });
  });
});
