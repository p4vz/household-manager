import { boolean, date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Family hub: kids' chores, shopping lists and purchase returns, shown on the
 * kitchen kiosk and the phone view. House upkeep stays in the maintenance
 * module and calendar events in the calendar module; the hub reaches them
 * through their api.ts only.
 *
 * Names here are first names or nicknames typed by a parent. Never store full
 * legal names (docs/SECURITY.md).
 */
export const familyKids = pgTable("family_kids", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** First name or nickname shown on the board. */
  name: text("name").notNull(),
  /** Column colour (hex). */
  color: text("color").notNull().default("#3b82f6"),
  emoji: text("emoji").notNull().default("⭐"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const familyChores = pgTable(
  "family_chores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kidId: uuid("kid_id")
      .notNull()
      .references(() => familyKids.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** Emoji shown large on the card for early and non-readers. */
    icon: text("icon").notNull().default("✅"),
    /** daily | weekly | once */
    recurrence: text("recurrence").$type<"daily" | "weekly" | "once">().notNull(),
    stars: integer("stars").notNull().default(1),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when a parent removes the chore; history stays for stats. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("family_chores_kid_idx").on(t.kidId)],
);

export const familyChoreCompletions = pgTable(
  "family_chore_completions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kidId: uuid("kid_id")
      .notNull()
      .references(() => familyKids.id, { onDelete: "cascade" }),
    choreId: uuid("chore_id")
      .notNull()
      .references(() => familyChores.id, { onDelete: "cascade" }),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Chore day (daily, once) or Monday of the chore week (weekly); see time.ts. */
    dateBucket: date("date_bucket").notNull(),
    /** Stars earned, copied from the chore so history survives edits. */
    stars: integer("stars").notNull().default(1),
  },
  (t) => [
    uniqueIndex("family_chore_completions_uq").on(t.choreId, t.dateBucket),
    index("family_chore_completions_kid_idx").on(t.kidId, t.dateBucket),
  ],
);

/**
 * A goal for one kid on one daily or weekly chore, set by a parent: "read 10
 * days in a row" (streak) or "read 30 times" (count), with the reward the
 * parent wrote. Progress is computed from completions since `startedOn`
 * (goals.ts). `achievedOn` is set once when it is reached and stays set;
 * `rewardGivenAt` when a parent marks the reward handed over.
 */
export const familyChoreGoals = pgTable(
  "family_chore_goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kidId: uuid("kid_id")
      .notNull()
      .references(() => familyKids.id, { onDelete: "cascade" }),
    choreId: uuid("chore_id")
      .notNull()
      .references(() => familyChores.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"streak" | "count">().notNull(),
    target: integer("target").notNull(),
    reward: text("reward").notNull(),
    rewardEmoji: text("reward_emoji").notNull().default("🎁"),
    startedOn: date("started_on").notNull(),
    achievedOn: date("achieved_on"),
    rewardGivenAt: timestamp("reward_given_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("family_chore_goals_kid_idx").on(t.kidId)],
);

/**
 * Star prizes (household-wide, parents edit them): "Small prize" at 25
 * stars, "Medium" at 100, "Large" at 500 to start. Stars work like a piggy
 * bank (stars.ts): every chore adds to a kid's saved stars, and a parent
 * giving a prize spends that many. Lifetime stars never go down.
 */
export const familyStarPrizes = pgTable("family_star_prizes", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  emoji: text("emoji").notNull().default("🎁"),
  stars: integer("stars").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A prize a parent handed over, and the stars it spent. Name and cost copied so history survives edits. */
export const familyStarSpends = pgTable(
  "family_star_spends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kidId: uuid("kid_id")
      .notNull()
      .references(() => familyKids.id, { onDelete: "cascade" }),
    prizeName: text("prize_name").notNull(),
    emoji: text("emoji").notNull().default("🎁"),
    stars: integer("stars").notNull(),
    givenBy: text("given_by").notNull(),
    givenAt: timestamp("given_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("family_star_spends_kid_idx").on(t.kidId)],
);

/**
 * Reading log (Pavel, 2026-11-25): one row per reading session. A day
 * counts when the kid read at least 20 minutes in English or 15 in Russian
 * (reading.ts); milestones on counted days add stars to the star bank.
 */
export const familyReadingLog = pgTable(
  "family_reading_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kidId: uuid("kid_id")
      .notNull()
      .references(() => familyKids.id, { onDelete: "cascade" }),
    /** Household date the reading happened. */
    day: date("day").notNull(),
    book: text("book").notNull(),
    /** "en" or "ru". */
    language: text("language").notNull(),
    minutes: integer("minutes").notNull(),
    pages: integer("pages"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("family_reading_log_kid_day_idx").on(t.kidId, t.day)],
);

/**
 * Each kid's book shelf: books they are reading, picked from a list when
 * logging instead of typing the title again. Added by typing, from a photo of
 * the cover (Claude reads title and author; the photo is not kept), or the
 * first time a new title is logged. `finished` hides a book from the list.
 */
export const familyBooks = pgTable(
  "family_books",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kidId: uuid("kid_id")
      .notNull()
      .references(() => familyKids.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    author: text("author"),
    /** "en" or "ru". */
    language: text("language").notNull(),
    finished: boolean("finished").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("family_books_kid_idx").on(t.kidId)],
);

/**
 * Shopping: lists (shown one below the other) hold store sections, which hold
 * item tiles. A list can be deferred until a date (hidden until then) and
 * saved as a template; a template starts new lists.
 */
export const familyShoppingLists = pgTable("family_shopping_lists", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  /** Hidden from the active view until this household date, then it comes back by itself. */
  deferredUntil: date("deferred_until"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const familyShoppingSections = pgTable(
  "family_shopping_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listId: uuid("list_id")
      .notNull()
      .references(() => familyShoppingLists.id, { onDelete: "cascade" }),
    store: text("store").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [uniqueIndex("family_shopping_sections_uq").on(t.listId, t.store)],
);

export const familyShoppingItems = pgTable(
  "family_shopping_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sectionId: uuid("section_id")
      .notNull()
      .references(() => familyShoppingSections.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    quantity: text("quantity"),
    sortOrder: integer("sort_order").notNull().default(0),
    checked: boolean("checked").notNull().default(false),
    /** Ticking an item ticks the same item on every active list with this exact timestamp, so un-ticking can undo them together. */
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("family_shopping_items_section_idx").on(t.sectionId)],
);

export const familyShoppingTemplates = pgTable(
  "family_shopping_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("family_shopping_templates_name_uq").on(t.name)],
);

export const familyShoppingTemplateItems = pgTable(
  "family_shopping_template_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => familyShoppingTemplates.id, { onDelete: "cascade" }),
    store: text("store").notNull(),
    /** Position of the store within the template. */
    storeOrder: integer("store_order").notNull().default(0),
    name: text("name").notNull(),
    quantity: text("quantity"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("family_shopping_template_items_tpl_idx").on(t.templateId)],
);

/** One row (id 1). Bumped by every shopping change so screens can poll cheaply for "anything new?". */
export const familyShoppingRevision = pgTable("family_shopping_revision", {
  id: integer("id").primaryKey(),
  revision: integer("revision").notNull().default(0),
});

export const familyPurchaseReturns = pgTable("family_purchase_returns", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemName: text("item_name").notNull(),
  store: text("store").notNull(),
  returnDeadline: date("return_deadline"),
  /** pending | packed_in_car | returned */
  status: text("status").$type<"pending" | "packed_in_car" | "returned">().notNull().default("pending"),
  /** Free text, e.g. "QR code in email". Do not paste card or account numbers. */
  notes: text("notes"),
  orderRef: text("order_ref"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  returnedAt: timestamp("returned_at", { withTimezone: true }),
});

/**
 * Gmail mailboxes a member connected so the app can find return emails
 * (labels, drop-off deadlines, refunds). Read-only access (gmail.readonly).
 * The address and refresh token are sealed (AES-256-GCM, src/core/secrets/
 * secret-box.ts). A mailbox belongs to the member who connected it: only
 * they see it and what was found in it, until they add a found return to the
 * shared list.
 */
export const familyMailboxes = pgTable(
  "family_mailboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** user1 | user2 (ALLOWED_EMAILS order). */
    member: text("member").$type<"user1" | "user2">().notNull(),
    /** Sealed email address. */
    addressSealed: text("address_sealed").notNull(),
    /** SHA-256 of the lowercased address, so reconnecting updates the same row. */
    addressHash: text("address_hash").notNull(),
    /** Sealed Google refresh token. */
    refreshTokenSealed: text("refresh_token_sealed").notNull(),
    includeSpam: boolean("include_spam").notNull().default(true),
    lastScanAt: timestamp("last_scan_at", { withTimezone: true }),
    lastScanOk: boolean("last_scan_ok"),
    lastScanMessage: text("last_scan_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("family_mailboxes_member_address_idx").on(t.member, t.addressHash)],
);

/** One-time state for the Gmail connect redirect (PKCE verifier, 10 minutes). */
export const familyMailConnectStates = pgTable("family_mail_connect_states", {
  state: text("state").primaryKey(),
  member: text("member").$type<"user1" | "user2">().notNull(),
  verifier: text("verifier").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/**
 * What a scan found in one email. Only extracted fields and the Gmail
 * message id are kept, never the email itself. Every scanned message gets a
 * row (status "ignored" when it was not about a return) so it is read once.
 */
export const familyReturnSuggestions = pgTable(
  "family_return_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => familyMailboxes.id, { onDelete: "cascade" }),
    member: text("member").$type<"user1" | "user2">().notNull(),
    /** Gmail's message id (opaque; used for "Open email" and to read each email once). */
    messageId: text("message_id").notNull(),
    /** new | accepted | dismissed | ignored | duplicate */
    status: text("status").$type<"new" | "accepted" | "dismissed" | "ignored" | "duplicate">().notNull(),
    /** return_started | label | refund */
    kind: text("kind").$type<"return_started" | "label" | "refund">(),
    itemName: text("item_name"),
    store: text("store"),
    returnDeadline: date("return_deadline"),
    notes: text("notes"),
    /** The open return this email is about (a refund for something on the list). */
    matchReturnId: uuid("match_return_id").references(() => familyPurchaseReturns.id, { onDelete: "set null" }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("family_return_suggestions_msg_idx").on(t.mailboxId, t.messageId),
    index("family_return_suggestions_member_idx").on(t.member, t.status),
  ],
);
