import type { Request } from "express";
import { env } from "../config/env";

export type CookieSecureMode = "true" | "false" | "auto";

/**
 * Whether auth cookies get the `Secure` flag.
 *   true  - always (default in production). Browsers then send the cookie over HTTPS only.
 *   false - never (default in development).
 *   auto  - only when the request really arrived over HTTPS, as reported by the trusted proxy's X-Forwarded-Proto
 *           (needs TRUST_PROXY_HOPS >= 1). Lets one build serve an HTTPS front end and an HTTP-only demo ALB.
 * The production default is unchanged from before: Secure.
 */
export function resolveCookieSecure(mode: CookieSecureMode | undefined, nodeEnv: string, requestIsSecure: boolean): boolean {
  const effective: CookieSecureMode = mode ?? (nodeEnv === "production" ? "true" : "false");
  if (effective === "auto") return requestIsSecure;
  return effective === "true";
}

export function cookieSecure(req: Request): boolean {
  return resolveCookieSecure(env.COOKIE_SECURE, env.NODE_ENV, req.secure);
}
