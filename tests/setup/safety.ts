/**
 * Guards that keep the automated tests away from real databases and caches (Neon, RDS, ElastiCache ...).
 * Only LOCAL services are accepted. Error messages deliberately contain only the host and database name, never credentials.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function assertSafeTestDatabaseUrl(raw: string, label = "TEST_DATABASE_URL"): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
  const host = url.hostname.toLowerCase();
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`Refusing to run tests: ${label} host "${host}" is not local. Tests may only use a local database.`);
  }
  if (!/_test$/.test(database)) {
    throw new Error(`Refusing to run tests: ${label} database "${database}" must end with "_test".`);
  }
}

export function assertSafeTestRedisUrl(raw: string, label = "TEST_REDIS_URL"): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
  const host = url.hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`Refusing to run tests: ${label} host "${host}" is not local. Tests may only use a local Redis.`);
  }
}
