/**
 * The only paths reachable without an allowlisted session. Everything else
 * is refused by the proxy (src/proxy.ts) and re-checked by the page, action
 * or route handler itself.
 */
export const PUBLIC_PATHS = ["/signin"] as const;
export const PUBLIC_PATH_PREFIXES = ["/api/auth/"] as const;

/** Paths protected by CRON_SECRET instead of a session (checked in the handler). */
export const CRON_PATH_PREFIX = "/api/cron/";

export function isPublicPath(pathname: string): boolean {
  // Exact match for pages, so a future `/signin-debug` route is not public by accident.
  return (
    (PUBLIC_PATHS as readonly string[]).includes(pathname) ||
    PUBLIC_PATH_PREFIXES.some((p) => pathname.startsWith(p))
  );
}

export function isCronPath(pathname: string): boolean {
  return pathname.startsWith(CRON_PATH_PREFIX);
}
