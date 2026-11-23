import { z } from "zod";
import "dotenv/config";

// Blank values (for example `VAR=` from docker-compose interpolation) count as "not set".
const blankToUndefined = (value: unknown) => (value === "" || value === null ? undefined : value);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());
const withDefault = <T extends z.ZodType>(schema: T, fallback: z.input<T>) =>
  z.preprocess(blankToUndefined, schema.default(fallback as never));
const flag = z.enum(["true", "false"]).transform((v) => v === "true");

const schema = z.object({
  NODE_ENV: z.enum(["development","test","production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_ORIGIN: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  CSRF_SECRET: z.string().min(32),
  IMPORT_MAX_BYTES: z.coerce.number().positive().default(5 * 1024 * 1024),
  IMPORT_MAX_ROWS: z.coerce.number().int().positive().default(500),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  ADMIN_SEED_PASSWORD: z.string().optional(),

  // ---- Multi-instance / cloud settings. All optional: without them the app behaves exactly as a single instance. ----
  /** Redis (ElastiCache) for state shared between instances: rate limiting and import previews. Unset = in-process fallback. */
  REDIS_URL: optional(z.string().regex(/^rediss?:\/\//, "REDIS_URL must start with redis:// or rediss://")),
  REDIS_KEY_PREFIX: withDefault(z.string().min(1).max(64), "quizora:"),
  /** If true, /health/ready also fails when Redis is unreachable. Default false: exams do not depend on Redis. */
  REDIS_REQUIRED: withDefault(flag, "false"),
  /** Number of reverse proxies in front of the app (0 = none, 1 = ALB, 2 = CloudFront + ALB). See docs/DEPLOYMENT.md. */
  TRUST_PROXY_HOPS: withDefault(z.coerce.number().int().min(0).max(5), 0),
  /** true | false | auto (follow X-Forwarded-Proto). Default: true in production, false otherwise. */
  COOKIE_SECURE: optional(z.enum(["true", "false", "auto"])),
  /** The /auth rate limit (per client IP). Defaults preserve the original policy: 50 requests per 15 minutes. */
  AUTH_RATE_LIMIT_MAX: withDefault(z.coerce.number().int().positive(), 50),
  AUTH_RATE_LIMIT_WINDOW_MS: withDefault(z.coerce.number().int().min(1000), 15 * 60_000),
  /** Per-process Prisma pool size / wait. Overrides `connection_limit` / `pool_timeout` in DATABASE_URL when set. */
  DB_CONNECTION_LIMIT: optional(z.coerce.number().int().min(1).max(100)),
  DB_POOL_TIMEOUT_SECONDS: optional(z.coerce.number().int().min(1).max(120))
});
export const env = schema.parse(process.env);
