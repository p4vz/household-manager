import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  primaryKey,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Who an account belongs to. `user1`/`user2` follow ALLOWED_EMAILS order
 * (on screen: Pavel / Raisa). A personal account and its transactions are
 * visible in Finance only to its owner; see ./access.ts.
 */
export const OWNERS = ["user1", "user2", "joint"] as const;
export type Owner = (typeof OWNERS)[number];

export const ACCOUNT_KINDS = [
  "credit",
  "business_credit",
  "checking",
  "business_checking",
  "savings",
  "loan",
  "investment",
  "other",
] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/** Kinds that earn card rewards (personal and business credit cards). */
export const CARD_KINDS: AccountKind[] = ["credit", "business_credit"];

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  credit: "Credit card",
  business_credit: "Business credit card",
  checking: "Checking",
  business_checking: "Business checking",
  savings: "Savings",
  loan: "Loan",
  investment: "Investment",
  other: "Other",
};

const money = (name: string) => numeric(name, { precision: 14, scale: 2, mode: "number" });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/**
 * Accounts and cards. No account or card numbers are stored: SimpleFIN
 * gives an opaque id, and digit runs are stripped from the bank's name
 * before it is saved as `bankName` (never sent to an LLM; `displayName`,
 * the household's nickname, is). `officialName` is the product name, e.g.
 * "Chase Freedom Unlimited", set on the Accounts page.
 */
export const financeAccounts = pgTable(
  "finance_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    simplefinId: text("simplefin_id"),
    institution: text("institution"),
    bankName: text("bank_name").notNull(),
    displayName: text("display_name"),
    officialName: text("official_name"),
    /**
     * Last four digits of the card or account, kept so people can tell
     * similar accounts apart (Pavel, 2026-11-25). Shown only in the app to
     * members who can see the account; never sent to an AI provider, an
     * assistant or the logs (the outbound sanitizers strip digit runs too).
     */
    last4: text("last4"),
    owner: text("owner", { enum: OWNERS }).notNull().default("joint"),
    kind: text("kind", { enum: ACCOUNT_KINDS }).notNull().default("other"),
    active: boolean("active").notNull().default(true),
    currency: text("currency").notNull().default("USD"),
    balance: money("balance"),
    balanceDate: timestamp("balance_date", { withTimezone: true }),
    /** First date covered by SimpleFIN. CSV rows on/after it are skipped. */
    simplefinStartDate: date("simplefin_start_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("finance_accounts_simplefin_uq").on(t.simplefinId)],
);

export const financeTransactions = pgTable(
  "finance_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => financeAccounts.id, { onDelete: "cascade" }),
    source: text("source", { enum: ["simplefin", "csv"] }).notNull(),
    /** SimpleFIN transaction id, or a content hash for CSV rows. */
    externalId: text("external_id").notNull(),
    postedDate: date("posted_date").notNull(),
    /** Negative = money out, positive = money in. */
    amount: money("amount").notNull(),
    description: text("description").notNull(),
    merchant: text("merchant").notNull(),
    category: text("category"),
    subcategory: text("subcategory"),
    pending: boolean("pending").notNull().default(false),
    /** Transfers between household accounts are excluded from spending. */
    isTransfer: boolean("is_transfer").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("finance_txn_external_uq").on(t.accountId, t.source, t.externalId),
    index("finance_txn_date_idx").on(t.postedDate),
  ],
);

/** Learned merchant -> category mapping (from CSV history and user edits). */
export const financeCategoryRules = pgTable("finance_category_rules", {
  merchant: text("merchant").primaryKey(),
  category: text("category").notNull(),
  subcategory: text("subcategory"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const financeSyncRuns = pgTable("finance_sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  trigger: text("trigger", { enum: ["cron", "setup", "manual"] }).notNull(),
  status: text("status", { enum: ["running", "ok", "error", "skipped"] }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  inserted: integer("inserted").notNull().default(0),
  /** Messages from SimpleFIN (bank connection problems etc.). */
  messages: jsonb("messages").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
});

/** Costs other modules tell finance about (trip budgets, maintenance). */
export const financeExpectedExpenses = pgTable(
  "finance_expected_expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    date: date("date").notNull(),
    amount: money("amount").notNull(),
    category: text("category"),
    sourceModule: text("source_module").notNull(),
    sourceRef: text("source_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("finance_expected_source_uq").on(t.sourceModule, t.sourceRef)],
);

/**
 * Monthly limit per spending category, per member: each member's budget
 * covers the accounts they can see (joint + their own), so limits are kept
 * apart. `source` = accepted suggestion or manual override.
 */
export const financeBudgets = pgTable(
  "finance_budgets",
  {
    viewer: text("viewer", { enum: ["user1", "user2"] }).notNull(),
    category: text("category").notNull(),
    monthlyLimit: money("monthly_limit").notNull(),
    source: text("source", { enum: ["auto", "manual"] }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.viewer, t.category] })],
);

/**
 * Picture of a card, uploaded on the Accounts page. Encrypted with
 * DOC_VAULT_KEY (AES-256-GCM) before it reaches the database, shown only to
 * signed-in household members, and never sent to an AI provider or an
 * assistant. The browser re-encodes it (dropping photo metadata) first.
 */
export const financeAccountImages = pgTable("finance_account_images", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => financeAccounts.id, { onDelete: "cascade" }),
  mimeType: text("mime_type", { enum: ["image/jpeg", "image/png", "image/webp"] }).notNull(),
  cipherText: bytea("cipher_text").notNull(),
  iv: bytea("iv").notNull(),
  authTag: bytea("auth_tag").notNull(),
  bytes: integer("bytes").notNull(),
  uploadedBy: text("uploaded_by", { enum: ["user1", "user2"] }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Reward profile per card. Value of one unit (point / percent of cashback)
 * is `centsPerUnit`: e.g. 1.25 for points worth 1.25c, 1 for cashback where
 * a rate of 2 means 2%.
 */
export const financeCardProfiles = pgTable("finance_card_profiles", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => financeAccounts.id, { onDelete: "cascade" }),
  rewardType: text("reward_type", { enum: ["points", "cashback"] }).notNull().default("points"),
  baseRate: numeric("base_rate", { precision: 6, scale: 3, mode: "number" }).notNull().default(1),
  centsPerUnit: numeric("cents_per_unit", { precision: 6, scale: 3, mode: "number" }).notNull().default(1),
  annualFee: money("annual_fee").notNull().default(0),
  /** Month (1-12) the annual fee posts, for calendar reminders. */
  annualFeeMonth: integer("annual_fee_month"),
  /** Catalog product this card is (see financeCardCatalog). */
  catalogProductId: text("catalog_product_id").references(() => financeCardCatalog.id, { onDelete: "set null" }),
  /** Catalog version last applied to (or knowingly kept off) this card's rules. */
  catalogAppliedVersion: integer("catalog_applied_version"),
  /**
   * Sign-up bonus, if the card is still inside its welcome-offer window.
   * `signupBonus` is in reward units (points, or dollars for cash back),
   * earned once `signupMinSpend` is spent on the card between
   * `signupStart` and `signupDeadline` (inclusive).
   */
  signupBonus: numeric("signup_bonus", { precision: 12, scale: 2, mode: "number" }),
  signupMinSpend: money("signup_min_spend"),
  signupStart: date("signup_start"),
  signupDeadline: date("signup_deadline"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const financeCardRules = pgTable("finance_card_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => financeAccounts.id, { onDelete: "cascade" }),
  /** What the rule matches: a category, a subcategory, or a merchant name (case-insensitive). */
  matchType: text("match_type", { enum: ["category", "subcategory", "merchant"] }).notNull(),
  match: text("match").notNull(),
  rate: numeric("rate", { precision: 6, scale: 3, mode: "number" }).notNull(),
  /** Spend cap in dollars per period; above it the base rate applies. */
  capAmount: money("cap_amount"),
  capPeriod: text("cap_period", { enum: ["month", "quarter", "year"] }),
  /** For rotating categories: only valid in this window. */
  validFrom: date("valid_from"),
  validTo: date("valid_to"),
  label: text("label"),
  /** "catalog" rules are replaced when catalog terms are applied; "user" rules never are. */
  source: text("source", { enum: ["user", "catalog"] }).notNull().default("user"),
  /** Rules sharing one cap (a catalog multiplier spread over several categories). */
  capGroup: text("cap_group"),
});

/**
 * Stored copy of each card product's published terms: multipliers, rotating
 * quarters, current sign-up offer, credits and perks. Covers the cards the
 * household holds plus well-known cards it does not, so the audit and the
 * advisor can work without searching the web each time. Refreshed by the
 * card-catalog cron job; every change is logged in financeCardCatalogChanges.
 */
export const financeCardCatalog = pgTable("finance_card_catalog", {
  /** Slug, e.g. "chase-sapphire-preferred". */
  id: text("id").primaryKey(),
  issuer: text("issuer").notNull(),
  name: text("name").notNull(),
  /** `CardTerms` (rewards/catalog/terms.ts); null until first verified for a card added by name. */
  terms: jsonb("terms"),
  /** Bumped whenever `terms` changes. */
  version: integer("version").notNull().default(1),
  sourceDomains: jsonb("source_domains").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  sourceUrls: jsonb("source_urls").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  /** seed = shipped with the app, not yet checked; verified = confirmed against issuer sources. */
  status: text("status", { enum: ["seed", "verified", "pending"] }).notNull().default("seed"),
  /** When the terms were last confirmed against a source (changed or not). */
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  /** When the refresh job last tried, successful or not. */
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  lastError: text("last_error"),
  /** "user" = a person edited these terms; the refresh then only proposes changes. */
  editedBy: text("edited_by", { enum: ["seed", "refresh", "user"] }).notNull().default("seed"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * What the refresh found. `applied` changes are already in the catalog and
 * shown as "what changed"; `pending` ones wait for a person (the terms were
 * user-edited, or the change was too large to trust unseen).
 */
export const financeCardCatalogChanges = pgTable(
  "finance_card_catalog_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: text("product_id")
      .notNull()
      .references(() => financeCardCatalog.id, { onDelete: "cascade" }),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    /** Catalog version this change produced (applied) or would produce (pending). */
    version: integer("version").notNull(),
    changes: jsonb("changes").$type<{ field: string; before: unknown; after: unknown }[]>().notNull(),
    /** Full proposed terms, so a pending change can be accepted as is. */
    proposed: jsonb("proposed").notNull(),
    sourceUrls: jsonb("source_urls").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    status: text("status", { enum: ["applied", "pending", "rejected"] }).notNull(),
    /** Why it was held for review. */
    reason: text("reason"),
    seen: boolean("seen").notNull().default(false),
  },
  (t) => [index("finance_catalog_changes_product_idx").on(t.productId, t.detectedAt)],
);

/**
 * Advisor reports, one stream per member (each covers what that member can
 * see). Reports from before private accounts have no viewer and are not shown.
 */
export const financeAdvisorReports = pgTable("finance_advisor_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  viewer: text("viewer", { enum: ["user1", "user2"] }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  trigger: text("trigger", { enum: ["manual", "monthly"] }).notNull(),
  provider: text("provider").notNull(),
  report: jsonb("report").notNull(),
});
