import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { withConnectionParams } from "./dbUrl";

// ONE PrismaClient (= one connection pool) per process. Every module imports this singleton; never construct another.
// Pool size comes from DB_CONNECTION_LIMIT / DB_POOL_TIMEOUT_SECONDS (see lib/dbUrl.ts) so API and worker can be sized separately.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function poolOverrides() {
  const limit = Number(process.env.DB_CONNECTION_LIMIT);
  const timeout = Number(process.env.DB_POOL_TIMEOUT_SECONDS);
  const connectionLimit = Number.isInteger(limit) && limit > 0 ? limit : undefined;
  const poolTimeoutSeconds = Number.isInteger(timeout) && timeout > 0 ? timeout : undefined;
  const url = process.env.DATABASE_URL;
  if (!url || (!connectionLimit && !poolTimeoutSeconds)) return undefined;
  return { db: { url: withConnectionParams(url, { connectionLimit, poolTimeoutSeconds }) } };
}

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  datasources: poolOverrides(),
  log: process.env.NODE_ENV === "development" ? ["warn","error"] : ["error"]
});
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
