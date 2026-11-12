/**
 * Applies per-process Prisma connection-pool settings to a database URL.
 *
 * Prisma sizes its pool from the `connection_limit` URL parameter (default: CPU cores * 2 + 1) and waits `pool_timeout` seconds
 * for a free connection. With several instances plus a worker the TOTAL must stay below the database's `max_connections`, and the
 * right size differs per role (API vs worker), so it is configurable by environment variable per process instead of by editing
 * the shared URL. A value passed here OVERRIDES one already present in the URL. With no options the URL is returned untouched.
 */
export function withConnectionParams(url: string, options: { connectionLimit?: number; poolTimeoutSeconds?: number }): string {
  if (!options.connectionLimit && !options.poolTimeoutSeconds) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url; // not our job to validate it; Prisma reports an unusable URL itself
  }
  if (options.connectionLimit) parsed.searchParams.set("connection_limit", String(options.connectionLimit));
  if (options.poolTimeoutSeconds) parsed.searchParams.set("pool_timeout", String(options.poolTimeoutSeconds));
  return parsed.toString();
}
