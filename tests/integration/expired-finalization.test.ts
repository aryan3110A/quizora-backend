import { afterAll, beforeAll, expect, it } from "vitest";
import { finalizeExpiredAttempt } from "../../src/services/attempts";
import { createFinalizerLoop, runFinalizerOnce } from "../../src/services/finalizer";
import { scoreAttempt } from "../../src/services/scoring";
import { describeDb } from "../helpers/db";
import {
  answerRows, cleanup, createAttemptDirect, createExam, createStudent, expireAttempt, getAttempt, minutesFromNow,
  saveAnswer, startAttempt, submit, type Exam, type Student
} from "../helpers/fixtures";

describeDb("automatic finalization of expired examinations", () => {
  let exam: Exam;
  let closedExam: Exam;
  const students: Student[] = [];
  const newStudent = async (forExam: Exam = exam) => {
    const s = await createStudent(forExam.streamId);
    students.push(s);
    return s;
  };
  /** Student starts an attempt and saves q1 correct (+2) and q2 wrong (-0.5). */
  async function startedAttemptWithAnswers() {
    const student = await newStudent();
    const attempt = await startAttempt(student, exam.quizId);
    await saveAnswer(student, attempt.id, exam.questions[0].id, exam.questions[0].correctOptionId);
    await saveAnswer(student, attempt.id, exam.questions[1].id, exam.questions[1].optionIds[1]);
    return { student, attemptId: attempt.id };
  }

  beforeAll(async () => {
    exam = await createExam({ questionCount: 3, marks: 2, negativeMarks: 0.5 });
    closedExam = await createExam({ questionCount: 3, marks: 2, negativeMarks: 0.5, endsInMinutes: -5 });
  });
  afterAll(async () => {
    await cleanup(closedExam, []);
    await cleanup(exam, students);
  });

  it("finalizes an expired IN_PROGRESS attempt with the answers that were saved", async () => {
    const { attemptId } = await startedAttemptWithAnswers();
    const expired = await expireAttempt(attemptId);

    const result = await runFinalizerOnce();
    expect(result.finalized).toContain(attemptId);
    expect(result.failed).toEqual([]);

    const row = await getAttempt(attemptId);
    expect(row.status).toBe("EXPIRED");
    expect(row.score).toBe(1.5);
    expect(row.totalMarks).toBe(6);
    expect(row.finalizedAt).not.toBeNull();
    // The submission time is the moment the attempt stopped accepting answers, not when the worker ran.
    expect(row.submittedAt).toEqual(expired.deadlineAt);
  });

  it("leaves attempts that are still within their deadline alone", async () => {
    const { attemptId } = await startedAttemptWithAnswers();
    const result = await runFinalizerOnce();
    expect(result.finalized).not.toContain(attemptId);
    const row = await getAttempt(attemptId);
    expect(row.status).toBe("IN_PROGRESS");
    expect(row.finalizedAt).toBeNull();
    expect(row.score).toBeNull();
  });

  it("also finalizes attempts whose quiz window has closed even if the personal deadline is later", async () => {
    const student = await newStudent(closedExam);
    const attempt = await createAttemptDirect(student.id, closedExam, minutesFromNow(20));
    const result = await runFinalizerOnce();
    expect(result.finalized).toContain(attempt.id);
    const row = await getAttempt(attempt.id);
    expect(row.status).toBe("EXPIRED");
    expect(row.score).toBe(0); // nothing answered
    expect(row.totalMarks).toBe(6);
  });

  it("is idempotent: finalizing again changes nothing", async () => {
    const { attemptId } = await startedAttemptWithAnswers();
    await expireAttempt(attemptId);
    await runFinalizerOnce();
    const first = await getAttempt(attemptId);

    const again = await runFinalizerOnce();
    expect(again.finalized).not.toContain(attemptId);
    expect(await finalizeExpiredAttempt(attemptId)).toEqual({ kind: "SKIPPED" });

    const second = await getAttempt(attemptId);
    expect(second.finalizedAt).toEqual(first.finalizedAt);
    expect(second.submittedAt).toEqual(first.submittedAt);
    expect(second.score).toBe(first.score);
    expect(second.updatedAt).toEqual(first.updatedAt);
  });

  it("handles a submission after the deadline: late answers are rejected and the attempt is finalized as EXPIRED", async () => {
    const { student, attemptId } = await startedAttemptWithAnswers();
    await expireAttempt(attemptId);

    const lateAnswer = await saveAnswer(student, attemptId, exam.questions[2].id, exam.questions[2].correctOptionId);
    expect(lateAnswer.status).toBe(409);
    expect(lateAnswer.body.error.code).toBe("ATTEMPT_CLOSED");

    const res = await submit(student, attemptId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, finalized: true }); // same shape as an on-time submit; never a score

    const row = await getAttempt(attemptId);
    expect(row.status).toBe("EXPIRED");
    expect(row.score).toBe(1.5); // only answers saved before the deadline count
    const rows = await answerRows(attemptId);
    expect(rows.map((r) => r.questionId).sort()).toEqual([exam.questions[0].id, exam.questions[1].id].sort());
  });

  it("rolls back completely when finalization fails, releases its lock, and succeeds on retry", async () => {
    const { attemptId } = await startedAttemptWithAnswers();
    await expireAttempt(attemptId);

    const failing = await runFinalizerOnce({
      scorer: () => {
        throw new Error("simulated scoring failure");
      }
    });
    expect(failing.failed.map((f) => f.id)).toContain(attemptId);
    expect(failing.finalized).not.toContain(attemptId);

    const untouched = await getAttempt(attemptId);
    expect(untouched.status).toBe("IN_PROGRESS");
    expect(untouched.finalizedAt).toBeNull();
    expect(untouched.score).toBeNull();

    const retry = await runFinalizerOnce(); // the lock was released, so the very next pass can take it
    expect(retry.finalized).toContain(attemptId);
    expect((await getAttempt(attemptId)).score).toBe(1.5);
  });

  it("backs off a failing attempt and retries it once its delay has passed", async () => {
    const { attemptId } = await startedAttemptWithAnswers();
    await expireAttempt(attemptId);

    let nowMs = 1_000_000;
    let failScoring = true;
    const loop = createFinalizerLoop({
      intervalMs: 1000,
      batchSize: 50,
      nowMs: () => nowMs,
      scorer: (questions, answers) => {
        if (failScoring) throw new Error("boom");
        return scoreAttempt(questions, answers);
      }
    });

    const first = await loop.tick();
    expect(first.failed.map((f) => f.id)).toContain(attemptId);

    const parked = await loop.tick(); // same instant: the attempt is in back-off and must not be hammered
    expect(parked.failed.map((f) => f.id)).not.toContain(attemptId);
    expect(parked.finalized).not.toContain(attemptId);

    failScoring = false;
    nowMs += 5_001; // first back-off step is 5 s
    const retried = await loop.tick();
    expect(retried.finalized).toContain(attemptId);
    expect((await getAttempt(attemptId)).status).toBe("EXPIRED");
  });
});
