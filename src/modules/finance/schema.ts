import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Who an account belongs to. `user1`/`user2` follow ALLOWED_EMAILS order. */
export const OWNERS = ["user1", "user2", "joint"] as const;
export type Owner = (typeof OWNERS)[number];

export const ACCOUNT_KINDS = ["credit", "checking", "savings", "loan", "investment", "other"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

const money = (name: string) => numeric(name, { precision: 14, scale: 2, mode: "number" });

/**
 * Accounts and cards. No account or card numbers are stored: SimpleFIN
 * gives an opaque id, and the bank's display name is kept only as
 * `bankName` (it is never sent to an LLM; `displayName` is).
 */
export const financeAccounts = pgTable(
  "finance_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    simplefinId: text("simplefin_id"),
    institution: text("institution"),
    bankName: text("bank_name").notNull(),
    displayName: text("display_name"),
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
  trigger: text("trigger", { enum: ["cron", "setup"] }).notNull(),
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

/** Monthly limit per spending category. `source` = accepted suggestion or manual override. */
export const financeBudgets = pgTable("finance_budgets", {
  category: text("category").primaryKey(),
  monthlyLimit: money("monthly_limit").notNull(),
  source: text("source", { enum: ["auto", "manual"] }).notNull(),
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
});

export const financeAdvisorReports = pgTable("finance_advisor_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  trigger: text("trigger", { enum: ["manual", "monthly"] }).notNull(),
  provider: text("provider").notNull(),
  report: jsonb("report").notNull(),
});
