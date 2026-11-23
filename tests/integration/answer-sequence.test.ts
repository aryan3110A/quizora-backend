import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { runFinalizerOnce } from "../../src/services/finalizer";
import { describeDb } from "../helpers/db";
import {
  call, cleanup, createExam, createStudent, expireAttempt, startAttempt, saveAnswer, submit, type Exam, type Student
} from "../helpers/fixtures";

describeDb("out-of-order answer protection (clientSeq)", () => {
  let exam: Exam;
  const students: Student[] = [];
  const newAttempt = async () => {
    const student = await createStudent(exam.streamId);
    students.push(student);
    const attempt = await startAttempt(student, exam.quizId);
    return { student, attemptId: attempt.id };
  };
  const stored = (attemptId: string, questionId: string) =>
    prisma.attemptAnswer.findUniqueOrThrow({ where: { attemptId_questionId: { attemptId, questionId } } });

  beforeAll(async () => {
    exam = await createExam({ questionCount: 3, marks: 2, negativeMarks: 0.5 });
  });
  afterAll(async () => {
    await cleanup(exam, students);
  });

  it("applies requests in sequence order", async () => {
    const { student, attemptId } = await newAttempt();
    const q = exam.questions[0];
    const first = await saveAnswer(student, attemptId, q.id, q.optionIds[1], 1);
    expect(first.status).toBe(200);
    expect(first.body.applied).toBe(true);
    expect((await saveAnswer(student, attemptId, q.id, q.optionIds[2], 2)).body.applied).toBe(true);
    const row = await stored(attemptId, q.id);
    expect(row.selectedOptionId).toBe(q.optionIds[2]);
    expect(row.clientSeq).toBe(2n);
  });

  it("REJECTS an older request that arrives after a newer one and reports what is stored", async () => {
    const { student, attemptId } = await newAttempt();
    const q = exam.questions[0];
    expect((await saveAnswer(student, attemptId, q.id, q.optionIds[3], 5)).status).toBe(200); // the newer click arrives first
    const late = await saveAnswer(student, attemptId, q.id, q.optionIds[1], 4); // the older click arrives late
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("STALE_ANSWER");
    expect(late.body.current).toEqual({ selectedOptionId: q.optionIds[3], seq: 5 });
    const row = await stored(attemptId, q.id);
    expect(row.selectedOptionId).toBe(q.optionIds[3]);
    expect(row.clientSeq).toBe(5n);
  });

  it("treats an exact retry (same sequence, same option) as an idempotent success, but a conflicting reuse as stale", async () => {
    const { student, attemptId } = await newAttempt();
    const q = exam.questions[0];
    await saveAnswer(student, attemptId, q.id, q.optionIds[1], 7);
    const retry = await saveAnswer(student, attemptId, q.id, q.optionIds[1], 7);
    expect(retry.status).toBe(200);
    expect(retry.body.applied).toBe(false);
    const conflicting = await saveAnswer(student, attemptId, q.id, q.optionIds[2], 7); // e.g. two tabs picked the same number
    expect(conflicting.status).toBe(409);
    expect(conflicting.body.error.code).toBe("STALE_ANSWER");
    expect((await stored(attemptId, q.id)).selectedOptionId).toBe(q.optionIds[1]);
  });

  it("orders a cleared (null) answer like any other", async () => {
    const { student, attemptId } = await newAttempt();
    const q = exam.questions[0];
    await saveAnswer(student, attemptId, q.id, q.optionIds[1], 10);
    expect((await saveAnswer(student, attemptId, q.id, null, 11)).status).toBe(200);
    expect((await saveAnswer(student, attemptId, q.id, q.optionIds[2], 9)).status).toBe(409); // older, must not resurrect an answer
    expect((await stored(attemptId, q.id)).selectedOptionId).toBeNull();
  });

  it("stays compatible with existing answer records (NULL sequence) and with legacy clients that send none", async () => {
    const { student, attemptId } = await newAttempt();
    const q = exam.questions[0];
    // A record written before the column existed.
    await prisma.attemptAnswer.create({ data: { attemptId, questionId: q.id, selectedOptionId: q.optionIds[0] } });
    expect((await stored(attemptId, q.id)).clientSeq).toBeNull();

    expect((await saveAnswer(student, attemptId, q.id, q.optionIds[1], 3)).body.applied).toBe(true); // any sequence beats NULL
    expect((await stored(attemptId, q.id)).clientSeq).toBe(3n);

    const legacy = await saveAnswer(student, attemptId, q.id, q.optionIds[2]); // no `seq`: old behaviour, always applied
    expect(legacy.status).toBe(200);
    const row = await stored(attemptId, q.id);
    expect(row.selectedOptionId).toBe(q.optionIds[2]);
    expect(row.clientSeq).toBe(3n); // the stored sequence is preserved
    expect((await saveAnswer(student, attemptId, q.id, q.optionIds[3], 2)).status).toBe(409); // still protected afterwards
  });

  it("always converges on the highest sequence when many requests race in a shuffled order", async () => {
    for (let round = 0; round < 5; round++) {
      const { student, attemptId } = await newAttempt();
      const q = exam.questions[round % exam.questions.length];
      const seqs = Array.from({ length: 24 }, (_, i) => 100 + i);
      const optionFor = (seq: number) => q.optionIds[seq % 4];
      const shuffled = [...seqs].sort(() => Math.random() - 0.5);

      const responses = await Promise.all(shuffled.map((seq) => saveAnswer(student, attemptId, q.id, optionFor(seq), seq)));
      for (const res of responses) {
        expect([200, 409]).toContain(res.status);
        if (res.status === 409) expect(res.body.error.code).toBe("STALE_ANSWER");
      }
      const row = await stored(attemptId, q.id);
      expect(row.clientSeq).toBe(123n); // the newest request wins no matter the arrival order
      expect(row.selectedOptionId).toBe(optionFor(123));
    }
  });

  it("round-trips millisecond-epoch sequences and returns them on resume so a reloaded client can continue", async () => {
    const { student, attemptId } = await newAttempt();
    const q = exam.questions[1];
    const seq = Date.now();
    expect((await saveAnswer(student, attemptId, q.id, q.optionIds[1], seq)).status).toBe(200);
    const resumed = await call(student, "post", `/student/quizzes/${exam.quizId}/attempts`);
    expect(resumed.body.id).toBe(attemptId);
    expect(resumed.body.answerSeqs).toEqual({ [q.id]: seq });
    expect(resumed.body.answers[q.id]).toBe(q.optionIds[1]);
    const fetched = await call(student, "get", `/student/attempts/${attemptId}`);
    expect(fetched.body.answerSeqs).toEqual({ [q.id]: seq });
  });

  it("validates the sequence number", async () => {
    const { student, attemptId } = await newAttempt();
    const q = exam.questions[0];
    for (const bad of [-1, 1.5, "7", null, Number.MAX_SAFE_INTEGER + 2]) {
      const res = await call(student, "put", `/student/attempts/${attemptId}/answers/${q.id}`, { selectedOptionId: q.optionIds[0], seq: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("reports a closed attempt as closed (not stale), whatever the sequence", async () => {
    const { student, attemptId } = await newAttempt();
    const q = exam.questions[0];
    await saveAnswer(student, attemptId, q.id, q.optionIds[1], 5);
    await submit(student, attemptId);
    const res = await saveAnswer(student, attemptId, q.id, q.optionIds[2], 999);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ATTEMPT_CLOSED");
    expect((await stored(attemptId, q.id)).selectedOptionId).toBe(q.optionIds[1]);
  });

  it("returns the database clock as serverTime on start, resume, save and status", async () => {
    const { student, attemptId } = await newAttempt();
    const q = exam.questions[0];
    const near = (iso: string) => Math.abs(new Date(iso).getTime() - Date.now()) < 5_000;
    const resumed = await call(student, "post", `/student/quizzes/${exam.quizId}/attempts`);
    const fetched = await call(student, "get", `/student/attempts/${attemptId}`);
    const saved = await saveAnswer(student, attemptId, q.id, q.optionIds[1], 1);
    const status = await call(student, "get", `/student/attempts/${attemptId}/status`);
    for (const res of [resumed, fetched, saved, status]) expect(near(res.body.serverTime)).toBe(true);
  });

  it("reports attempt status: open, expired-but-unfinalized, then finalized — without any score", async () => {
    const { student, attemptId } = await newAttempt();
    const open = await call(student, "get", `/student/attempts/${attemptId}/status`);
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({ status: "IN_PROGRESS", finalized: false, expired: false });
    expect(new Date(open.body.deadlineAt).getTime()).toBeGreaterThan(Date.now());

    await expireAttempt(attemptId);
    expect((await call(student, "get", `/student/attempts/${attemptId}/status`)).body).toMatchObject({ status: "IN_PROGRESS", finalized: false, expired: true });

    await runFinalizerOnce();
    const done = await call(student, "get", `/student/attempts/${attemptId}/status`);
    expect(done.body).toMatchObject({ status: "EXPIRED", finalized: true, expired: true });
    expect(JSON.stringify(done.body)).not.toMatch(/score|totalMarks|percentage/);
  });

  it("answers status for malformed or foreign attempt ids with 404", async () => {
    const { attemptId } = await newAttempt();
    const stranger = await createStudent(exam.streamId);
    students.push(stranger);
    expect((await call(stranger, "get", `/student/attempts/${attemptId}/status`)).status).toBe(404);
    expect((await call(stranger, "get", "/student/attempts/not-a-uuid/status")).status).toBe(404);
  });
});
