import "server-only";
import { randomBytes } from "node:crypto";
import { and, count, desc, eq, gt, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { isAllowedEmail, ownerLabelFor, parseAllowlist, type OwnerLabel } from "@/core/auth/allowlist";
import { db } from "@/core/db/client";
import { coreOauthClients, coreOauthCodes, coreOauthGrants } from "@/core/db/core-schema";
import {
  ACCESS_TTL_MS,
  CODE_TTL_MS,
  MAX_CLIENTS,
  REFRESH_TTL_MS,
  hashSecret,
  isAllowedRedirectUri,
  resourceMatches,
  verifyPkce,
  type OauthConfig,
} from "./policy";

/**
 * Storage side of the assistant OAuth server. Codes and tokens are random
 * 256-bit values, returned once and stored only as SHA-256 hashes, so a
 * database dump holds nothing usable.
 */

export class OauthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const allowlist = () => parseAllowlist(process.env.ALLOWED_EMAILS);
const secret = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;

// ---------- clients (RFC 7591) ----------

export type ClientMetadata = { redirect_uris?: unknown; client_name?: unknown };

export async function registerClient(body: ClientMetadata, now = new Date()) {
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (uris.length === 0 || uris.length > 5 || !uris.every((u) => typeof u === "string")) {
    throw new OauthError("invalid_redirect_uri", "Between 1 and 5 redirect_uris are required");
  }
  const bad = (uris as string[]).find((u) => !isAllowedRedirectUri(u));
  if (bad) throw new OauthError("invalid_redirect_uri", `Redirect URI not allowed by this server: ${bad.slice(0, 200)}`);

  await pruneClients(now);
  const [{ n }] = await db().select({ n: count() }).from(coreOauthClients);
  if (n >= MAX_CLIENTS) throw new OauthError("temporarily_unavailable", "Too many registered clients", 503);

  const name =
    typeof body.client_name === "string" && body.client_name.trim()
      ? body.client_name.replace(/[^\p{L}\p{N} ._()-]/gu, "").trim().slice(0, 80) || "Unnamed assistant"
      : "Unnamed assistant";
  const clientId = secret("hm_client_");
  await db().insert(coreOauthClients).values({ clientId, name, redirectUris: uris as string[] });
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    client_name: name,
    redirect_uris: uris as string[],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/** Clients that never got an approval within a day, and expired codes, are removed. */
async function pruneClients(now: Date) {
  await db().delete(coreOauthCodes).where(lt(coreOauthCodes.expiresAt, now));
  await db()
    .delete(coreOauthClients)
    .where(
      and(
        lt(coreOauthClients.createdAt, new Date(now.getTime() - 86_400_000)),
        notExists(db().select({ x: sql`1` }).from(coreOauthGrants).where(eq(coreOauthGrants.clientId, coreOauthClients.clientId))),
      ),
    );
}

export async function getClient(clientId: string) {
  const [c] = await db().select().from(coreOauthClients).where(eq(coreOauthClients.clientId, clientId));
  return c ?? null;
}

// ---------- authorization ----------

export type AuthorizeRequest = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
};

/** Called only from the consent action, after requireUser(). */
export async function createAuthorizationCode(req: AuthorizeRequest, email: string, now = new Date()) {
  if (!isAllowedEmail(email, allowlist())) throw new OauthError("access_denied", "Not a household member", 403);
  const client = await getClient(req.clientId);
  if (!client || !client.redirectUris.includes(req.redirectUri)) {
    throw new OauthError("invalid_request", "That redirect URI is not registered for this application");
  }
  const code = secret("hm_code_");
  await db()
    .insert(coreOauthCodes)
    .values({
      codeHash: hashSecret(code),
      clientId: req.clientId,
      email: email.toLowerCase(),
      redirectUri: req.redirectUri,
      scope: req.scope,
      resource: req.resource,
      codeChallenge: req.codeChallenge,
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    });
  return code;
}

// ---------- tokens ----------

type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

export async function exchangeCode(
  form: { code: string; verifier: string; clientId: string; redirectUri: string | null; resource: string | null },
  config: OauthConfig,
  now = new Date(),
): Promise<TokenResponse> {
  const codeHash = hashSecret(form.code);
  // Mark used in the same statement that reads it, so two racing requests
  // cannot both redeem one code.
  const [record] = await db()
    .update(coreOauthCodes)
    .set({ usedAt: now })
    .where(and(eq(coreOauthCodes.codeHash, codeHash), isNull(coreOauthCodes.usedAt)))
    .returning();
  if (!record) {
    const [replayed] = await db().select().from(coreOauthCodes).where(eq(coreOauthCodes.codeHash, codeHash));
    if (replayed) {
      // A code used twice may have leaked: revoke what it produced.
      await db()
        .update(coreOauthGrants)
        .set({ revokedAt: now })
        .where(and(eq(coreOauthGrants.clientId, replayed.clientId), eq(coreOauthGrants.email, replayed.email), isNull(coreOauthGrants.revokedAt)));
    }
    throw new OauthError("invalid_grant", "Unknown or already used authorization code");
  }
  if (record.expiresAt <= now) throw new OauthError("invalid_grant", "Authorization code expired");
  if (record.clientId !== form.clientId) throw new OauthError("invalid_grant", "Code was issued to another client");
  // RFC 6749 4.1.3: the redirect_uri sent with the authorization request must be repeated here.
  if (form.redirectUri === null || form.redirectUri !== record.redirectUri) {
    throw new OauthError("invalid_grant", "redirect_uri does not match");
  }
  if (!verifyPkce(form.verifier, record.codeChallenge)) throw new OauthError("invalid_grant", "PKCE verification failed");
  if (!resourceMatches(form.resource, config) || record.resource !== config.resource) {
    throw new OauthError("invalid_target", "Resource is not this server");
  }
  if (!isAllowedEmail(record.email, allowlist())) throw new OauthError("invalid_grant", "Member is no longer allowed");

  const access = secret("hm_at_");
  const refresh = secret("hm_rt_");
  await db()
    .insert(coreOauthGrants)
    .values({
      clientId: record.clientId,
      email: record.email,
      scope: record.scope,
      resource: record.resource,
      accessHash: hashSecret(access),
      accessExpiresAt: new Date(now.getTime() + ACCESS_TTL_MS),
      refreshHash: hashSecret(refresh),
      refreshExpiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
    });
  return tokenResponse(access, refresh, record.scope);
}

/**
 * New access token for a refresh token. The refresh token itself is kept
 * (with a sliding 30-day expiry) because Gemini requires the same refresh
 * token back; the access token it unlocks lives one hour.
 */
export async function refreshAccess(
  form: { refreshToken: string; clientId: string | null },
  now = new Date(),
): Promise<TokenResponse> {
  const [grant] = await db()
    .select()
    .from(coreOauthGrants)
    .where(eq(coreOauthGrants.refreshHash, hashSecret(form.refreshToken)));
  if (!grant || grant.revokedAt || grant.refreshExpiresAt <= now) throw new OauthError("invalid_grant", "Refresh token is not valid");
  if (form.clientId && form.clientId !== grant.clientId) throw new OauthError("invalid_grant", "Refresh token belongs to another client");
  if (!isAllowedEmail(grant.email, allowlist())) {
    await db().update(coreOauthGrants).set({ revokedAt: now }).where(eq(coreOauthGrants.id, grant.id));
    throw new OauthError("invalid_grant", "Member is no longer allowed");
  }
  const access = secret("hm_at_");
  await db()
    .update(coreOauthGrants)
    .set({
      accessHash: hashSecret(access),
      accessExpiresAt: new Date(now.getTime() + ACCESS_TTL_MS),
      refreshExpiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
    })
    .where(eq(coreOauthGrants.id, grant.id));
  return tokenResponse(access, form.refreshToken, grant.scope);
}

function tokenResponse(access: string, refresh: string, scope: string): TokenResponse {
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope };
}

/** RFC 7009: always succeeds, whether or not the token was known. */
export async function revokeToken(token: string, now = new Date()) {
  const h = hashSecret(token);
  await db()
    .update(coreOauthGrants)
    .set({ revokedAt: now })
    .where(and(or(eq(coreOauthGrants.accessHash, h), eq(coreOauthGrants.refreshHash, h)), isNull(coreOauthGrants.revokedAt)));
}

export type McpCaller = { grantId: string; clientId: string; email: string; owner: OwnerLabel; scopes: string[]; expiresAt: number };

/**
 * Resolves a bearer token for the MCP endpoint. The member's address is
 * checked against ALLOWED_EMAILS on every call, so removing an address cuts
 * off its assistants immediately.
 */
export async function verifyAccessToken(token: string | null, config: OauthConfig, now = new Date()): Promise<McpCaller | null> {
  if (!token || !token.startsWith("hm_at_") || token.length > 200) return null;
  const [grant] = await db()
    .select()
    .from(coreOauthGrants)
    .where(and(eq(coreOauthGrants.accessHash, hashSecret(token)), isNull(coreOauthGrants.revokedAt), gt(coreOauthGrants.accessExpiresAt, now)));
  if (!grant || grant.resource !== config.resource) return null;
  const list = allowlist();
  const owner = isAllowedEmail(grant.email, list) ? ownerLabelFor(grant.email, list) : null;
  if (!owner) return null;
  if (!grant.lastUsedAt || now.getTime() - grant.lastUsedAt.getTime() > 5 * 60_000) {
    await db().update(coreOauthGrants).set({ lastUsedAt: now }).where(eq(coreOauthGrants.id, grant.id));
  }
  return {
    grantId: grant.id,
    clientId: grant.clientId,
    email: grant.email,
    owner,
    scopes: grant.scope.split(" "),
    expiresAt: Math.floor(grant.accessExpiresAt.getTime() / 1000),
  };
}

// ---------- settings page ----------

/** Connected assistants, newest first, for the Settings page. */
export async function listConnections() {
  const rows = await db()
    .select({
      id: coreOauthGrants.id,
      client: coreOauthClients.name,
      redirectUris: coreOauthClients.redirectUris,
      email: coreOauthGrants.email,
      createdAt: coreOauthGrants.createdAt,
      lastUsedAt: coreOauthGrants.lastUsedAt,
      refreshExpiresAt: coreOauthGrants.refreshExpiresAt,
    })
    .from(coreOauthGrants)
    .innerJoin(coreOauthClients, eq(coreOauthClients.clientId, coreOauthGrants.clientId))
    .where(isNull(coreOauthGrants.revokedAt))
    .orderBy(desc(coreOauthGrants.createdAt));
  const list = allowlist();
  return rows.map(({ email, redirectUris, ...r }) => ({
    ...r,
    host: hostOf(redirectUris[0]),
    owner: ownerLabelFor(email, list) ?? "Removed member",
  }));
}

export async function revokeConnection(id: string, now = new Date()) {
  await db().update(coreOauthGrants).set({ revokedAt: now }).where(eq(coreOauthGrants.id, id));
}

export async function revokeAllConnections(now = new Date()) {
  await db().update(coreOauthGrants).set({ revokedAt: now }).where(isNull(coreOauthGrants.revokedAt));
}

export function hostOf(uri: string | undefined): string {
  try {
    return new URL(uri ?? "").host;
  } catch {
    return "unknown";
  }
}
