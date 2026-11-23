import { findExpiredAttemptIds, finalizeExpiredAttempt } from "./attempts";
import type { Scorer } from "./scoring";

/**
 * Automatic finalization of expired attempts (PostgreSQL polling, no queue).
 *
 * Correctness does NOT depend on this loop being a singleton or on its timing:
 *   - each attempt is finalized in its own transaction under `FOR UPDATE SKIP LOCKED`
 *     (see services/attempts.ts), so N workers can run in parallel without double work;
 *   - finalization is idempotent, so a crash after commit or a repeated pass is harmless;
 *   - a failure rolls back only that attempt and is retried on a later pass.
 */

export type FinalizerLogger = {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
};

const silentLogger: FinalizerLogger = { info() {}, warn() {}, error() {} };

export type FinalizerRunOptions = {
  batchSize?: number;
  /** Attempt ids to leave alone for this pass (failure back-off). */
  excludeIds?: readonly string[];
  scorer?: Scorer;
  logger?: FinalizerLogger;
};

export type FinalizerRunResult = {
  /** Candidates returned by the expiry query. */
  found: number;
  /** Attempts this pass actually finalized. */
  finalized: string[];
  /** Candidates another worker/student held the lock on, or that were already finalized. */
  skipped: string[];
  failed: Array<{ id: string; error: string }>;
};

export async function runFinalizerOnce(options: FinalizerRunOptions = {}): Promise<FinalizerRunResult> {
  const batchSize = options.batchSize ?? 50;
  const logger = options.logger ?? silentLogger;
  const ids = await findExpiredAttemptIds(batchSize, options.excludeIds ?? []);
  const result: FinalizerRunResult = { found: ids.length, finalized: [], skipped: [], failed: [] };

  // Sequential on purpose: one DB connection at a time keeps the worker's pool footprint tiny.
  for (const id of ids) {
    try {
      const outcome = await finalizeExpiredAttempt(id, { scorer: options.scorer });
      if (outcome.kind === "FINALIZED") {
        result.finalized.push(id);
        logger.info({ attemptId: id, score: outcome.attempt.score, totalMarks: outcome.attempt.totalMarks }, "expired attempt finalized");
      } else {
        result.skipped.push(id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed.push({ id, error: message });
      logger.error({ attemptId: id, err: message }, "failed to finalize expired attempt");
    }
  }
  return result;
}

/** Exponential back-off for an attempt that keeps failing: 5s, 10s, 20s ... capped at 5 minutes. */
export function retryDelayMs(consecutiveFailures: number, baseMs = 5_000, capMs = 300_000): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(capMs, baseMs * 2 ** exponent);
}

export type FinalizerLoopOptions = {
  intervalMs: number;
  batchSize: number;
  scorer?: Scorer;
  logger?: FinalizerLogger;
  /** Injectable clock (ms) for tests. */
  nowMs?: () => number;
};

export type FinalizerLoop = {
  start: () => void;
  /** Stops scheduling and waits for the pass in flight (if any). */
  stop: () => Promise<void>;
  /** Runs one pass immediately (used by the loop, and by tests/ops). */
  tick: () => Promise<FinalizerRunResult>;
};

export function createFinalizerLoop(options: FinalizerLoopOptions): FinalizerLoop {
  const logger = options.logger ?? silentLogger;
  const nowMs = options.nowMs ?? Date.now;
  const backoff = new Map<string, { failures: number; retryAt: number }>();
  let timer: NodeJS.Timeout | undefined;
  let stopped = true;
  let inFlight: Promise<unknown> | undefined;

  async function tick(): Promise<FinalizerRunResult> {
    const now = nowMs();
    const parked = [...backoff.entries()].filter(([, state]) => state.retryAt > now).map(([id]) => id);
    const result = await runFinalizerOnce({
      batchSize: options.batchSize,
      excludeIds: parked,
      scorer: options.scorer,
      logger
    });
    for (const id of result.finalized) backoff.delete(id);
    for (const id of result.skipped) backoff.delete(id);
    for (const { id } of result.failed) {
      const failures = (backoff.get(id)?.failures ?? 0) + 1;
      backoff.set(id, { failures, retryAt: nowMs() + retryDelayMs(failures) });
    }
    return result;
  }

  function schedule(delayMs: number) {
    if (stopped) return;
    timer = setTimeout(async () => {
      inFlight = tick()
        .then((result) => {
          // Backlog: if a full batch was drained, go again straight away instead of waiting.
          const drained = result.finalized.length > 0 && result.found >= options.batchSize;
          schedule(drained ? 0 : options.intervalMs);
        })
        .catch((err) => {
          logger.error({ err: err instanceof Error ? err.message : String(err) }, "finalizer pass failed");
          schedule(options.intervalMs);
        });
      await inFlight;
    }, delayMs);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(0);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
    tick
  };
}
