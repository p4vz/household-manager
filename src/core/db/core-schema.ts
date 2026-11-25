import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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

// ---------------------------------------------------------------------------
// Kitchen kiosk devices. A wall screen is paired once with a short one-time
// code made in Settings by a signed-in member; it then carries a device
// cookie that opens /kiosk and nothing else. See src/core/kiosk and
// docs/SECURITY.md ("Kitchen kiosk"). Codes and tokens are stored only as
// SHA-256 hashes.
// ---------------------------------------------------------------------------

export const coreKioskPairingCodes = pgTable(
  "core_kiosk_pairing_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    /** Owner label (User 1 / User 2) of the member who made the code. */
    createdBy: text("created_by").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("core_kiosk_pairing_codes_expires_idx").on(t.expiresAt)],
);

export const coreKioskDevices = pgTable(
  "core_kiosk_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Adult mode on this screen ends at this time (null: locked). Set only by a correct adult PIN. */
    adultUntil: timestamp("adult_until", { withTimezone: true }),
    /** Wrong adult PINs since the last lockout or success. */
    pinFailures: integer("pin_failures").notNull().default(0),
    /** No PIN tries on this screen until then. */
    pinLockedUntil: timestamp("pin_locked_until", { withTimezone: true }),
  },
  (t) => [uniqueIndex("core_kiosk_devices_token_uq").on(t.tokenHash)],
);

/**
 * The household's adult PIN for the kitchen screen (one row, id "household").
 * Set and changed only by a signed-in member in Settings; stored as a salted
 * scrypt hash (core/kiosk/adult.ts).
 */
export const coreKioskAdultPin = pgTable("core_kiosk_adult_pin", {
  id: text("id").primaryKey(),
  pinHash: text("pin_hash").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
