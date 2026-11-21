import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/** App-wide settings (AI provider choice, etc.), one row per key. */
export const coreSettings = pgTable("core_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// OAuth 2.1 authorization server for the assistant (MCP) endpoint.
// See src/core/oauth and docs/SECURITY.md. Secrets (codes, tokens) are stored
// only as SHA-256 hashes.
// ---------------------------------------------------------------------------

/** Assistants that registered themselves (RFC 7591). Registering grants nothing. */
export const coreOauthClients = pgTable("core_oauth_clients", {
  clientId: text("client_id").primaryKey(),
  name: text("name").notNull(),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One-time authorization codes, valid for 5 minutes after a member approves. */
export const coreOauthCodes = pgTable(
  "core_oauth_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => coreOauthClients.clientId, { onDelete: "cascade" }),
    email: text("email").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    scope: text("scope").notNull(),
    resource: text("resource").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    /** What the member ticked on the consent screen (see core/oauth/permissions). */
    permissions: jsonb("permissions").$type<string[]>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [index("core_oauth_codes_expires_idx").on(t.expiresAt)],
);

/** An approved connection: one short-lived access token plus a refresh token. */
export const coreOauthGrants = pgTable(
  "core_oauth_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: text("client_id")
      .notNull()
      .references(() => coreOauthClients.clientId, { onDelete: "cascade" }),
    /** The allowlisted member who approved it. Re-checked on every request. */
    email: text("email").notNull(),
    scope: text("scope").notNull(),
    resource: text("resource").notNull(),
    /** Sections this assistant may see. Null (grants from before this existed) means the defaults. */
    permissions: jsonb("permissions").$type<string[]>(),
    accessHash: text("access_hash").notNull(),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }).notNull(),
    refreshHash: text("refresh_hash").notNull(),
    refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("core_oauth_grants_access_uq").on(t.accessHash),
    uniqueIndex("core_oauth_grants_refresh_uq").on(t.refreshHash),
  ],
);
