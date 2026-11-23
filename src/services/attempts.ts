import { randomUUID } from "node:crypto";
import { Prisma, type Attempt } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { scoreAttempt, type Scorer } from "./scoring";

/**
 * Examination attempt lifecycle: submission, automatic finalization and answer saving.
 *
 * Concurrency model (no schema change, PostgreSQL row locks only):
 *   - The `Attempt` row is the lock anchor for everything that changes an attempt's outcome.
 *   - Finalization (student submit or worker) takes `SELECT ... FOR UPDATE` on the attempt row,
 *     decides expiry once against the DATABASE clock, scores, and writes the final state in the
 *     same transaction. A finalized attempt is never touched again (idempotent).
 *   - Answer saves are ONE statement that takes `FOR SHARE` on the attempt row, re-checks that
 *     the attempt is still IN_PROGRESS and within its deadline, then upserts. FOR SHARE
 *     conflicts with FOR UPDATE, so:
 *       * a save that is already running finishes (and commits) before finalization reads answers;
 *       * a save that arrives during/after finalization blocks, re-evaluates the row, and
 *         inserts nothing.
 *     Concurrent saves do not block each other (FOR SHARE is shared).
 *   - The worker uses `FOR UPDATE SKIP LOCKED`, so any number of workers/instances can run
 *     side by side and each attempt is finalized by exactly one of them.
 */

type Tx = Prisma.TransactionClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Row-lock waits must be able to outlast a concurrent finalization. */
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

/**
 * Prisma stores DateTime as `timestamp(3) without time zone` in UTC. Compare against the
 * database clock expressed in UTC so the result does not depend on the session TimeZone.
 * The database clock (not the app server's) is the shared source of truth across instances.
 */
const DB_NOW = Prisma.sql`(clock_timestamp() AT TIME ZONE 'UTC')`;

const LOCK_COLUMNS = Prisma.sql`a."id", a."quizId", a."userId", a."status"::text AS "status", a."deadlineAt", a."submittedAt", a."finalizedAt", q."endsAt" AS "quizEndsAt", ${DB_NOW} AS "now"`;

type LockedAttempt = {
  id: string;
  quizId: string;
  userId: string;
  status: string;
  deadlineAt: Date;
  submittedAt: Date | null;
  finalizedAt: Date | null;
  quizEndsAt: Date;
  now: Date;
};

export type FinalizeDeps = { scorer?: Scorer };

async function writeFinalState(
  tx: Tx,
  locked: LockedAttempt,
  status: "SUBMITTED" | "EXPIRED",
  submittedAt: Date,
  finalizedAt: Date,
  scorer: Scorer
): Promise<Attempt> {
  const questions = await tx.question.findMany({
    where: { quizId: locked.quizId },
    select: { id: true, marks: true, negativeMarks: true, options: { select: { id: true, isCorrect: true } } }
  });
  const answers = await tx.attemptAnswer.findMany({
    where: { attemptId: locked.id },
    select: { questionId: true, selectedOptionId: true }
  });
  const { score, totalMarks } = scorer(questions, answers);
  return tx.attempt.update({
    where: { id: locked.id },
    data: { score, totalMarks, status, submittedAt, finalizedAt }
  });
}

/** The moment an attempt stopped accepting answers: the earlier of its deadline and the quiz close. */
function effectiveDeadline(locked: LockedAttempt): Date {
  return new Date(Math.min(locked.deadlineAt.getTime(), locked.quizEndsAt.getTime(), locked.now.getTime()));
}

function isExpired(locked: LockedAttempt): boolean {
  const now = locked.now.getTime();
  return now >= locked.deadlineAt.getTime() || now >= locked.quizEndsAt.getTime();
}

export type SubmitOutcome =
  | { kind: "NOT_FOUND" }
  | { kind: "ALREADY_FINALIZED" }
  | { kind: "CLOSED_UNFINALIZED" }
  | { kind: "SUBMITTED"; attempt: Attempt }
  | { kind: "EXPIRED"; attempt: Attempt };

/**
 * Student-initiated final submission. Idempotent and safe against concurrent saves, concurrent
 * submits and the background worker.
 */
export async function submitAttempt(attemptId: string, userId: string, deps: FinalizeDeps = {}): Promise<SubmitOutcome> {
  const scorer = deps.scorer ?? scoreAttempt;
  return prisma.$transaction(async (tx): Promise<SubmitOutcome> => {
    const rows = await tx.$queryRaw<LockedAttempt[]>`
      SELECT ${LOCK_COLUMNS}
      FROM "Attempt" a JOIN "Quiz" q ON q."id" = a."quizId"
      WHERE a."id" = ${attemptId}::uuid AND a."userId" = ${userId}::uuid
      FOR UPDATE OF a`;
    const locked = rows[0];
    if (!locked) return { kind: "NOT_FOUND" };
    if (locked.finalizedAt) return { kind: "ALREADY_FINALIZED" };
    if (locked.status !== "IN_PROGRESS") return { kind: "CLOSED_UNFINALIZED" };

    if (!isExpired(locked)) {
      const attempt = await writeFinalState(tx, locked, "SUBMITTED", locked.now, locked.now, scorer);
      return { kind: "SUBMITTED", attempt };
    }
    const attempt = await writeFinalState(tx, locked, "EXPIRED", effectiveDeadline(locked), locked.now, scorer);
    return { kind: "EXPIRED", attempt };
  }, TX_OPTIONS);
}

export type ExpireOutcome = { kind: "FINALIZED"; attempt: Attempt } | { kind: "SKIPPED" };

/**
 * Worker-initiated finalization of ONE expired attempt.
 *
 * `SKIP LOCKED` means: if another worker, or the student's own submit, currently holds the
 * row we silently skip it. The expiry predicate is re-evaluated under the lock, so an attempt
 * that was finalized in the meantime is skipped too. Calling this twice is harmless.
 */
export async function finalizeExpiredAttempt(attemptId: string, deps: FinalizeDeps = {}): Promise<ExpireOutcome> {
  const scorer = deps.scorer ?? scoreAttempt;
  return prisma.$transaction(async (tx): Promise<ExpireOutcome> => {
    const rows = await tx.$queryRaw<LockedAttempt[]>`
      SELECT ${LOCK_COLUMNS}
      FROM "Attempt" a JOIN "Quiz" q ON q."id" = a."quizId"
      WHERE a."id" = ${attemptId}::uuid
        AND a."status" = 'IN_PROGRESS'
        AND (a."deadlineAt" <= ${DB_NOW} OR q."endsAt" <= ${DB_NOW})
      FOR UPDATE OF a SKIP LOCKED`;
    const locked = rows[0];
    if (!locked) return { kind: "SKIPPED" };
    const attempt = await writeFinalState(tx, locked, "EXPIRED", effectiveDeadline(locked), locked.now, scorer);
    return { kind: "FINALIZED", attempt };
  }, TX_OPTIONS);
}

/**
 * Candidate expired attempts, oldest deadline first (uses the (status, deadlineAt) index).
 * This read takes no locks; the per-attempt transaction above is what makes it safe.
 * `excludeIds` lets the worker park attempts that are in a failure back-off so a poison
 * attempt can never starve healthy ones.
 */
export async function findExpiredAttemptIds(limit: number, excludeIds: readonly string[] = []): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT a."id"
    FROM "Attempt" a JOIN "Quiz" q ON q."id" = a."quizId"
    WHERE a."status" = 'IN_PROGRESS'
      AND (a."deadlineAt" <= ${DB_NOW} OR q."endsAt" <= ${DB_NOW})
      AND a."id" <> ALL(${[...excludeIds]}::uuid[])
    ORDER BY a."deadlineAt" ASC
    LIMIT ${limit}::int`;
  return rows.map((row) => row.id);
}

export type SaveAnswerResult =
  /** Written. */
  | { kind: "SAVED"; now: Date }
  /** The identical request (same sequence, same option) had already been applied: an idempotent retry. */
  | { kind: "DUPLICATE"; now: Date }
  /** Rejected: a newer answer (higher sequence) is already stored. `current` is the stored state. */
  | { kind: "STALE"; now: Date; current: { selectedOptionId: string | null; clientSeq: number | null } }
  /** Attempt missing for this user, no longer IN_PROGRESS, or past its deadline / quiz close. Nothing written. */
  | { kind: "CLOSED" };

/**
 * Atomically save (or clear) an answer, protected against out-of-order delivery.
 *
 * ONE statement: lock the attempt row (FOR SHARE) and re-check it is open on the database clock, then upsert.
 * Sequence rule (`clientSeq`, a per-question increasing number chosen by the client):
 *   - seq omitted (legacy client)            -> always applied; any stored sequence is kept
 *   - stored sequence is NULL (legacy row)   -> applied
 *   - incoming seq  >  stored seq            -> applied
 *   - incoming seq <=  stored seq            -> NOT applied (stale), or DUPLICATE if it is the very same request
 * The comparison runs inside the row-locked upsert, so even requests that are in flight at the same time end in
 * the state of the highest sequence, regardless of the order in which they reach PostgreSQL.
 */
export async function saveAttemptAnswer(params: {
  attemptId: string;
  userId: string;
  questionId: string;
  selectedOptionId: string | null;
  clientSeq?: number | null;
}): Promise<SaveAnswerResult> {
  const { attemptId, userId, questionId, selectedOptionId } = params;
  const clientSeq = params.clientSeq ?? null;
  // Sent as text and cast: a millisecond-epoch sequence does not fit a 32-bit parameter.
  const seqParam = clientSeq === null ? null : String(clientSeq);
  const rows = await prisma.$queryRaw<Array<{ open: number; applied: number; now: Date }>>`
    WITH guard AS (
      SELECT a."id"
      FROM "Attempt" a JOIN "Quiz" q ON q."id" = a."quizId"
      WHERE a."id" = ${attemptId}::uuid
        AND a."userId" = ${userId}::uuid
        AND a."status" = 'IN_PROGRESS'
        AND a."deadlineAt" > ${DB_NOW}
        AND q."endsAt" > ${DB_NOW}
      FOR SHARE OF a
    ), upsert AS (
      INSERT INTO "AttemptAnswer" ("id", "attemptId", "questionId", "selectedOptionId", "clientSeq", "savedAt")
      SELECT ${randomUUID()}::uuid, g."id", ${questionId}::uuid, ${selectedOptionId}::uuid, ${seqParam}::bigint, ${DB_NOW}
      FROM guard g
      ON CONFLICT ("attemptId", "questionId") DO UPDATE SET
        "selectedOptionId" = EXCLUDED."selectedOptionId",
        "clientSeq" = COALESCE(EXCLUDED."clientSeq", "AttemptAnswer"."clientSeq"),
        "savedAt" = EXCLUDED."savedAt"
      WHERE EXCLUDED."clientSeq" IS NULL
         OR "AttemptAnswer"."clientSeq" IS NULL
         OR EXCLUDED."clientSeq" > "AttemptAnswer"."clientSeq"
      RETURNING "id"
    )
    SELECT (SELECT count(*) FROM guard)::int AS "open", (SELECT count(*) FROM upsert)::int AS "applied", ${DB_NOW} AS "now"`;
  const { open, applied, now } = rows[0];
  if (open === 0) return { kind: "CLOSED" };
  if (applied === 1) return { kind: "SAVED", now };

  // Open, but the sequence guard declined the write: report what is stored.
  const stored = await prisma.attemptAnswer.findUnique({
    where: { attemptId_questionId: { attemptId, questionId } },
    select: { selectedOptionId: true, clientSeq: true }
  });
  const storedSeq = stored?.clientSeq == null ? null : Number(stored.clientSeq);
  if (stored && clientSeq !== null && storedSeq === clientSeq && stored.selectedOptionId === selectedOptionId) {
    return { kind: "DUPLICATE", now };
  }
  return { kind: "STALE", now, current: { selectedOptionId: stored?.selectedOptionId ?? null, clientSeq: storedSeq } };
}

/** The database clock (UTC) — the clock every deadline decision is made on. */
export async function getDbNow(): Promise<Date> {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT ${DB_NOW} AS "now"`;
  return rows[0].now;
}

export type AttemptStatusView = {
  status: string;
  finalized: boolean;
  /** True once the attempt no longer accepts answers (its deadline or the quiz close has passed). */
  expired: boolean;
  deadlineAt: Date;
  serverTime: Date;
};

/** Lightweight status for an attempt owned by `userId`; null if it does not exist. Never includes scores. */
export async function getAttemptStatus(attemptId: string, userId: string): Promise<AttemptStatusView | null> {
  const rows = await prisma.$queryRaw<
    Array<{ status: string; finalized: boolean; deadlineAt: Date; quizEndsAt: Date; now: Date }>
  >`
    SELECT a."status"::text AS "status", (a."finalizedAt" IS NOT NULL) AS "finalized",
           a."deadlineAt", q."endsAt" AS "quizEndsAt", ${DB_NOW} AS "now"
    FROM "Attempt" a JOIN "Quiz" q ON q."id" = a."quizId"
    WHERE a."id" = ${attemptId}::uuid AND a."userId" = ${userId}::uuid`;
  const row = rows[0];
  if (!row) return null;
  const now = row.now.getTime();
  return {
    status: row.status,
    finalized: row.finalized,
    expired: now >= row.deadlineAt.getTime() || now >= row.quizEndsAt.getTime(),
    deadlineAt: row.deadlineAt,
    serverTime: row.now
  };
}
