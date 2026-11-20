/**
 * The only paths reachable without an allowlisted session. Everything else
 * is refused by the proxy (src/proxy.ts) and re-checked by the page, action
 * or route handler itself.
 */
export const PUBLIC_PATH_PREFIXES = ["/signin", "/api/auth/"] as const;

/** Paths protected by CRON_SECRET instead of a session (checked in the handler). */
export const CRON_PATH_PREFIX = "/api/cron/";

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

export function isCronPath(pathname: string): boolean {
  return pathname.startsWith(CRON_PATH_PREFIX);
}
