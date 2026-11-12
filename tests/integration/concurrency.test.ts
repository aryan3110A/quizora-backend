import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { runFinalizerOnce } from "../../src/services/finalizer";
import { scoreAttempt } from "../../src/services/scoring";
import { describeDb } from "../helpers/db";
import {
  answerRows, call, cleanup, createAttemptDirect, createExam, createStudent, expireAttempt, getAttempt, minutesFromNow,
  saveAnswer, sleep, startAttempt, submit, type Exam, type Student
} from "../helpers/fixtures";

describeDb("concurrency: workers, answer saves and submissions", () => {
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

  it("several workers running at once finalize every expired attempt exactly once", async () => {
    const ATTEMPTS = 24;
    const ids: string[] = [];
    for (let i = 0; i < ATTEMPTS; i++) {
      const student = await newStudent();
      const attempt = await createAttemptDirect(student.id, exam, minutesFromNow(-10));
      await prisma.attemptAnswer.create({
        data: { attemptId: attempt.id, questionId: exam.questions[0].id, selectedOptionId: exam.questions[0].correctOptionId }
      });
      ids.push(attempt.id);
    }

    // Four independent workers with a small batch size so they constantly collide on the same candidates.
    async function drain() {
      const finalized: string[] = [];
      const failed: string[] = [];
      for (let pass = 0; pass < 200; pass++) {
        const result = await runFinalizerOnce({ batchSize: 5 });
        finalized.push(...result.finalized);
        failed.push(...result.failed.map((f) => f.error));
        if (result.found === 0) break;
      }
      return { finalized, failed };
    }
    const workers = await Promise.all([drain(), drain(), drain(), drain()]);

    expect(workers.flatMap((w) => w.failed)).toEqual([]);
    const mine = workers.flatMap((w) => w.finalized).filter((id) => ids.includes(id));
    expect(mine).toHaveLength(ATTEMPTS); // no attempt finalized twice...
    expect(new Set(mine).size).toBe(ATTEMPTS); // ...and none missed

    const rows = await prisma.attempt.findMany({ where: { id: { in: ids } } });
    expect(rows.every((r) => r.status === "EXPIRED" && r.finalizedAt !== null && r.score === 2 && r.totalMarks === 6)).toBe(true);
  });

  it("answers saved concurrently for the same question leave exactly one consistent row", async () => {
    const student = await newStudent();
    const attempt = await startAttempt(student, exam.quizId);
    const q = exam.questions[0];

    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, i) => saveAnswer(student, attempt.id, q.id, q.optionIds[i % 4]))
    );
    expect(responses.map((r) => r.status)).toEqual(Array(30).fill(200));

    const rows = (await answerRows(attempt.id)).filter((r) => r.questionId === q.id);
    expect(rows).toHaveLength(1);
    expect(q.optionIds).toContain(rows[0].selectedOptionId);

    // Many questions at once: one row per question, nothing lost.
    await Promise.all(
      exam.questions.flatMap((question) =>
        Array.from({ length: 10 }, (_, i) => saveAnswer(student, attempt.id, question.id, question.optionIds[i % 4]))
      )
    );
    expect(await answerRows(attempt.id)).toHaveLength(exam.questions.length);
  });

  it("saves racing with submit never leave an answer that was not scored, and nothing is accepted afterwards", async () => {
    const ROUNDS = 8;
    let acceptedAfterSubmitStarted = 0;
    let rejected = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const student = await newStudent();
      const attempt = await startAttempt(student, exam.quizId);
      const [q1, q2] = exam.questions;
      await saveAnswer(student, attempt.id, q1.id, q1.optionIds[1]); // baseline answer

      const jitter = () => sleep(Math.floor(Math.random() * 6));
      const saves = Array.from({ length: 16 }, (_, i) =>
        jitter().then(() => saveAnswer(student, attempt.id, i % 2 ? q1.id : q2.id, (i % 2 ? q1 : q2).optionIds[i % 4]))
      );
      const submission = jitter().then(() => submit(student, attempt.id));
      const [submitRes, ...saveRes] = await Promise.all([submission, ...saves]);

      expect(submitRes.status).toBe(200);
      for (const r of saveRes) expect([200, 409]).toContain(r.status);
      rejected += saveRes.filter((r) => r.status === 409).length;
      acceptedAfterSubmitStarted += saveRes.filter((r) => r.status === 200).length;

      // Invariant: the stored score is exactly the score of the answers that exist now. If any save had
      // slipped in after scoring read the answers, these two would differ.
      const finalRow = await getAttempt(attempt.id);
      const questions = await prisma.question.findMany({
        where: { quizId: exam.quizId },
        select: { id: true, marks: true, negativeMarks: true, options: { select: { id: true, isCorrect: true } } }
      });
      const recomputed = scoreAttempt(questions, await answerRows(attempt.id));
      expect(finalRow.finalizedAt).not.toBeNull();
      expect(finalRow.score).toBe(recomputed.score);
      expect(finalRow.totalMarks).toBe(recomputed.totalMarks);

      // And the door is shut for good.
      const afterwards = await saveAnswer(student, attempt.id, q1.id, q1.correctOptionId);
      expect(afterwards.status).toBe(409);
      expect(await getAttempt(attempt.id)).toMatchObject({ score: recomputed.score });
    }
    // Sanity: across all rounds both outcomes (accepted before / rejected after) are legitimate.
    expect(acceptedAfterSubmitStarted + rejected).toBe(ROUNDS * 16);
  });

  it("duplicate concurrent submits finalize once and every call succeeds", async () => {
    const student = await newStudent();
    const attempt = await startAttempt(student, exam.quizId);
    await saveAnswer(student, attempt.id, exam.questions[0].id, exam.questions[0].correctOptionId);

    const responses = await Promise.all(Array.from({ length: 8 }, () => submit(student, attempt.id)));
    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(responses.every((r) => r.body.ok === true && r.body.finalized === true)).toBe(true);
    expect(responses.every((r) => !("score" in r.body))).toBe(true); // no caller is ever told the score

    const row = await getAttempt(attempt.id);
    expect(row.status).toBe("SUBMITTED");
    expect(row.score).toBe(2);
    await sleep(50);
    expect(await getAttempt(attempt.id)).toMatchObject({ finalizedAt: row.finalizedAt, submittedAt: row.submittedAt });
  });

  it("a worker and the student's own submit racing on an expired attempt finalize it once", async () => {
    const student = await newStudent();
    const attempt = await startAttempt(student, exam.quizId);
    await saveAnswer(student, attempt.id, exam.questions[0].id, exam.questions[0].correctOptionId);
    await expireAttempt(attempt.id);

    const [submitRes, ...runs] = await Promise.all([submit(student, attempt.id), runFinalizerOnce(), runFinalizerOnce(), runFinalizerOnce()]);
    expect(submitRes.status).toBe(200);
    expect((runs as Array<Awaited<ReturnType<typeof runFinalizerOnce>>>).flatMap((r) => r.failed)).toEqual([]);

    const row = await getAttempt(attempt.id);
    expect(row.status).toBe("EXPIRED");
    expect(row.score).toBe(2);
    expect(row.finalizedAt).not.toBeNull();
  });

  it("concurrent attempt starts by the same student produce a single attempt", async () => {
    const student = await newStudent();
    const responses = await Promise.all(Array.from({ length: 10 }, () => call(student, "post", `/student/quizzes/${exam.quizId}/attempts`)));
    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
    expect(await prisma.attempt.count({ where: { quizId: exam.quizId, userId: student.id } })).toBe(1);
  });
});
