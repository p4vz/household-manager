/**
 * Pure rules for the assistant OAuth server: when it is switched on, who
 * may be redirected to, PKCE, and the discovery documents. No DB, no
 * network, so every rule here is unit tested.
 *
 * The server exists only because remote MCP clients (Claude, ChatGPT,
 * Gemini) cannot send a static header: they discover an authorization
 * server, register themselves (RFC 7591) and run an authorization-code
 * flow with PKCE. Access is granted only on the consent page, by an
 * allowlisted household member signed in with Google.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** One read-only scope. Nothing an assistant can do changes household data. */
export const MCP_SCOPE = "household:read";
export const SCOPES = [MCP_SCOPE] as const;

export const CODE_TTL_MS = 5 * 60 * 1000;
export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A grant ends this long after approval, however often it is refreshed. */
export const GRANT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_CLIENTS = 50;

/**
 * Hosts an assistant may ask to be redirected to after approval. Exact
 * match on the host, https only, any path. Anything else needs
 * MCP_EXTRA_REDIRECT_HOSTS.
 */
export const DEFAULT_REDIRECT_HOSTS = [
  "claude.ai", // Claude custom connectors (web, desktop, mobile)
  "claude.com",
  "chatgpt.com", // ChatGPT connectors (developer mode)
] as const;

/**
 * Gemini's account-linking callbacks, per Google's MCP OAuth guide: three
 * hosts (production, sandbox, test), and only paths under /r/ or /a/.
 * Exact host, https, default port, and the path must start with the prefix.
 */
export const GOOGLE_REDIRECT_PREFIXES = [
  "https://oauth-redirect.googleusercontent.com/r/",
  "https://oauth-redirect-sandbox.googleusercontent.com/r/",
  "https://oauth-redirect-test.googleusercontent.com/r/",
  "https://oauth-redirect.googleusercontent.com/a/",
  "https://oauth-redirect-sandbox.googleusercontent.com/a/",
  "https://oauth-redirect-test.googleusercontent.com/a/",
] as const;

function matchesGooglePrefix(u: URL): boolean {
  if (u.protocol !== "https:" || u.port !== "") return false;
  return GOOGLE_REDIRECT_PREFIXES.some((p) => {
    const prefix = new URL(p);
    // Compare parsed parts, so "%2e%2e" tricks and host look-alikes cannot pass.
    return u.hostname === prefix.hostname && u.pathname.startsWith(prefix.pathname) && u.pathname.length > prefix.pathname.length;
  });
}

/**
 * The assistant a client belongs to, named by where it is redirected after
 * approval rather than by the client_name it registered with, which any
 * caller can set. Unknown hosts (MCP_EXTRA_REDIRECT_HOSTS, loopback) keep
 * their registered name.
 */
export function assistantName(redirectUri: string | undefined, registeredName: string): string {
  let u: URL;
  try {
    u = new URL(redirectUri ?? "");
  } catch {
    return registeredName;
  }
  if (u.protocol !== "https:") return registeredName;
  if (u.hostname === "claude.ai" || u.hostname === "claude.com") return "Claude";
  if (u.hostname === "chatgpt.com") return "ChatGPT";
  if (matchesGooglePrefix(u)) return "Gemini";
  return registeredName;
}

type Env = Record<string, string | undefined>;

export type OauthConfig = { issuer: string; resource: string };

/**
 * The server is off unless MCP_ENABLED=true and AUTH_URL names the public
 * origin. The issuer is never taken from a Host header, so a caller cannot
 * make the server advertise or accept a different origin.
 */
export function oauthConfig(env: Env = process.env): OauthConfig | null {
  if (env.MCP_ENABLED !== "true") return null;
  let url: URL;
  try {
    url = new URL(env.AUTH_URL ?? "");
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:" && env.NODE_ENV !== "production")) return null;
  const issuer = url.origin;
  return { issuer, resource: `${issuer}/api/mcp` };
}

export function redirectHosts(env: Env = process.env): Set<string> {
  const extra = (env.MCP_EXTRA_REDIRECT_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...DEFAULT_REDIRECT_HOSTS, ...extra]);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A redirect URI an assistant may register and be sent back to: https on
 * an allowed host, one of Gemini's prefixes, or http on loopback (desktop
 * clients, RFC 8252). No credentials, no fragment, at most 2 KB.
 */
export function isAllowedRedirectUri(uri: string, hosts: ReadonlySet<string> = redirectHosts()): boolean {
  if (uri.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash) return false;
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname);
  if (matchesGooglePrefix(u)) return true;
  return u.protocol === "https:" && (u.port === "" || u.port === "443") && hosts.has(u.hostname.toLowerCase());
}

/** RFC 8707: the resource must be this MCP endpoint (trailing slash tolerated). */
export function resourceMatches(given: string | null | undefined, config: OauthConfig): boolean {
  if (!given) return true;
  return given.replace(/\/+$/, "") === config.resource;
}

/** Only the scopes this server knows; empty means the default read scope. */
export function grantedScopes(requested: string | null | undefined): string[] | null {
  const asked = (requested ?? "").split(/\s+/).filter(Boolean);
  if (asked.length === 0) return [MCP_SCOPE];
  const known = asked.filter((s) => (SCOPES as readonly string[]).includes(s));
  // Clients that also ask for openid/profile/email still get the read scope.
  return known.length > 0 || asked.every((s) => ["openid", "profile", "email", "offline_access"].includes(s))
    ? [MCP_SCOPE]
    : null;
}

/** PKCE S256 only (OAuth 2.1 forbids "plain"). Constant-time compare. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

export function isValidChallenge(challenge: string | null | undefined): challenge is string {
  return typeof challenge === "string" && /^[A-Za-z0-9_-]{43}$/.test(challenge);
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** RFC 8414 document, also served as openid-configuration for Gemini. */
export function authorizationServerMetadata(config: OauthConfig) {
  const base = config.issuer;
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    revocation_endpoint: `${base}/api/oauth/revoke`,
    scopes_supported: [...SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
  };
}

/** RFC 9728 document: the MCP endpoint's 401 points here. */
export function protectedResourceMetadata(config: OauthConfig) {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Aprelev Household",
  };
}

export function wwwAuthenticate(config: OauthConfig, error?: "invalid_token" | "insufficient_scope") {
  const parts = [`resource_metadata="${config.issuer}/.well-known/oauth-protected-resource"`, `scope="${MCP_SCOPE}"`];
  if (error) parts.unshift(`error="${error}"`);
  return `Bearer ${parts.join(", ")}`;
}
