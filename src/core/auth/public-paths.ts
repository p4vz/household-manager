/**
 * The only paths reachable without an allowlisted session. Everything else
 * is refused by the proxy (src/proxy.ts) and re-checked by the page, action
 * or route handler itself.
 */
export const PUBLIC_PATH_PREFIXES = ["/signin", "/api/auth/"] as const;

/**
 * Kitchen kiosk. `/kiosk/pair` is public: it only takes a one-time code made
 * by a signed-in member (rate limited in its action). `/kiosk` itself passes
 * the proxy with a member session or a kiosk device cookie; the page and its
 * actions verify the device token against the database.
 */
export const KIOSK_PATH = "/kiosk";
export const KIOSK_PAIR_PATH = "/kiosk/pair";

export function isKioskPath(pathname: string): boolean {
  return pathname === KIOSK_PATH;
}

/** Paths protected by CRON_SECRET instead of a session (checked in the handler). */
export const CRON_PATH_PREFIX = "/api/cron/";

/**
 * Assistant (MCP) endpoints. Reachable without a session only when
 * MCP_ENABLED=true (otherwise each answers 404), and each checks its own
 * credential: an OAuth bearer token for /api/mcp, PKCE or a refresh token
 * for /api/oauth/token. Discovery documents are public metadata.
 */
export const ASSISTANT_PATHS = [
  "/api/mcp",
  "/api/oauth/register",
  "/api/oauth/token",
  "/api/oauth/revoke",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/.well-known/openid-configuration",
] as const;

export function isAssistantPath(pathname: string): boolean {
  return ASSISTANT_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Consent screen: needs a session, and sign-in must return here. */
export const CONSENT_PATH = "/oauth/authorize";

export function isPublicPath(pathname: string): boolean {
  if (pathname === KIOSK_PAIR_PATH) return true;
  return PUBLIC_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

export function isCronPath(pathname: string): boolean {
  return pathname.startsWith(CRON_PATH_PREFIX);
}
