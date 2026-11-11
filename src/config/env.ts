import { z } from "zod";
import "dotenv/config";

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
  ADMIN_SEED_PASSWORD: z.string().optional()
});
export const env = schema.parse(process.env);
