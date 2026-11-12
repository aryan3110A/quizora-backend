import type Redis from "ioredis";
import { env } from "../config/env";
import { HttpError } from "../lib/http";
import { getRedis } from "../lib/redis";

/**
 * Storage for the question-import "preview": the file is parsed and validated on upload (preview) and written to the quiz only
 * when the admin confirms. The parsed rows have to survive between those two requests, which with several backend instances can
 * be served by different instances — so they live in Redis (shared), or in process memory when Redis is not configured.
 *
 * This is deliberately TEMPORARY data (TTL 15 minutes). The imported questions themselves are persisted in PostgreSQL on confirm.
 */

export const IMPORT_PREVIEW_TTL_SECONDS = 15 * 60;

export type ParsedQuestion = {
  question: string; optionA: string; optionB: string; optionC: string; optionD: string;
  correctAnswer: "A" | "B" | "C" | "D"; explanation?: string; topic?: string;
  marks: number; negativeMarks: number; difficulty?: string; row: number;
};

export type ImportPreview = { adminId: string; quizId: string; questions: ParsedQuestion[] };

export interface ImportPreviewStore {
  put(token: string, preview: ImportPreview, ttlSeconds?: number): Promise<void>;
  /** Reads without consuming (used to validate ownership before the preview is consumed). */
  get(token: string): Promise<ImportPreview | null>;
  /** Atomically reads AND deletes: at most one caller ever receives a given preview. */
  take(token: string): Promise<ImportPreview | null>;
}

/** Single-instance / development store. Expired entries are swept so abandoned previews cannot accumulate. */
export class MemoryImportPreviewStore implements ImportPreviewStore {
  private readonly entries = new Map<string, { preview: ImportPreview; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  private sweep(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(token);
  }

  async put(token: string, preview: ImportPreview, ttlSeconds = IMPORT_PREVIEW_TTL_SECONDS): Promise<void> {
    this.sweep();
    this.entries.set(token, { preview, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  private lookup(token: string): ImportPreview | null {
    const entry = this.entries.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(token);
      return null;
    }
    return entry.preview;
  }

  async get(token: string): Promise<ImportPreview | null> {
    return this.lookup(token);
  }

  /** Lookup and delete happen in ONE synchronous step (no await in between), so two concurrent takes cannot both succeed. */
  async take(token: string): Promise<ImportPreview | null> {
    const preview = this.lookup(token);
    this.entries.delete(token);
    return preview;
  }
}

const unavailable = () =>
  new HttpError(503, "IMPORT_STORE_UNAVAILABLE", "Import preview storage is temporarily unavailable. Please try again in a moment.");

/**
 * Shared store. If Redis is configured but unreachable it does NOT silently fall back to memory: a preview kept in one
 * instance's memory would be invisible to the instance that receives the confirm request. It fails the request with 503 instead.
 */
export class RedisImportPreviewStore implements ImportPreviewStore {
  constructor(
    private readonly client: Redis,
    private readonly prefix = "quizora:"
  ) {}

  private key(token: string): string {
    return `${this.prefix}import:${token}`;
  }

  async put(token: string, preview: ImportPreview, ttlSeconds = IMPORT_PREVIEW_TTL_SECONDS): Promise<void> {
    try {
      await this.client.set(this.key(token), JSON.stringify(preview), "EX", ttlSeconds);
    } catch {
      throw unavailable();
    }
  }

  async get(token: string): Promise<ImportPreview | null> {
    try {
      return parse(await this.client.get(this.key(token)));
    } catch {
      throw unavailable();
    }
  }

  async take(token: string): Promise<ImportPreview | null> {
    try {
      return parse(await this.client.getdel(this.key(token)));
    } catch {
      throw unavailable();
    }
  }
}

function parse(raw: string | null): ImportPreview | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ImportPreview;
  } catch {
    return null; // a corrupt entry is treated as expired
  }
}

export function createImportPreviewStore(redis: Redis | null, prefix: string): ImportPreviewStore {
  return redis ? new RedisImportPreviewStore(redis, prefix) : new MemoryImportPreviewStore();
}

let defaultStore: ImportPreviewStore | undefined;

/** The process-wide store used by the routes: Redis when REDIS_URL is set, otherwise memory. */
export function getImportPreviewStore(): ImportPreviewStore {
  defaultStore ??= createImportPreviewStore(getRedis(), env.REDIS_KEY_PREFIX);
  return defaultStore;
}
