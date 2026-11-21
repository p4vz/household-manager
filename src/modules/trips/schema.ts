import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  date,
  doublePrecision,
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

/**
 * Trip planner data model, ported from the standalone family trip assistant.
 *
 * The household is the whole app here (two allowlisted sign-ins), so the old
 * Household / invite-code layer is gone: every row below belongs to the one
 * household. People who travel are `trips_travelers`; adults can be linked to
 * a sign-in by owner label, kids never sign in.
 *
 * Gluten is medical, not a preference: someone in this family has coeliac
 * disease. Dining ratings, allergy cards and anything generated about food
 * must reflect that.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
const money = (name: string) => numeric(name, { precision: 12, scale: 2, mode: "number" });
const ts = (name: string) => timestamp(name, { withTimezone: true });

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export const TRAVELER_KINDS = ["adult", "child"] as const;

export const tripsTravelers = pgTable("trips_travelers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: text("kind", { enum: TRAVELER_KINDS }).notNull().default("adult"),
  birthdate: date("birthdate"),
  /** Links an adult to a sign-in (`user1` / `user2`). Null for kids. */
  owner: text("owner", { enum: ["user1", "user2"] }),
  color: text("color").notNull().default("sky"),
  // Dietary / medical profile. Drives allergy cards and dining warnings.
  celiac: boolean("celiac").notNull().default(false),
  glutenFree: boolean("gluten_free").notNull().default(false),
  /** Ask about shared fryers, pasta water, flour dust. */
  crossContactStrict: boolean("cross_contact_strict").notNull().default(true),
  otherAllergens: jsonb("other_allergens").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  dietNotes: text("diet_notes"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Trips, destinations, itinerary
// ---------------------------------------------------------------------------

export const tripsTrips = pgTable(
  "trips_trips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Display summary of the places, e.g. "Zurich, Innsbruck, Val di Funes". */
    destination: text("destination").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    /** Planned total. When null, the sum of itinerary costs is used. */
    budget: money("budget"),
    status: text("status", { enum: ["planned", "cancelled"] }).notNull().default("planned"),
    slug: text("slug").notNull(),
    notes: text("notes"),
    archived: boolean("archived").notNull().default(false),
    /**
     * Trip-wide switch: may connected assistants read this trip's booking
     * confirmation codes? Off by default. Codes still only reach an
     * assistant whose connection also has the "travel.booking_codes"
     * permission (src/core/oauth/permissions.ts).
     */
    shareBookingCodes: boolean("share_booking_codes").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("trips_trips_slug_uq").on(t.slug)],
);

/** A place the trip visits. Anchors trivia, dining, weather and emergency info. */
export const tripsDestinations = pgTable(
  "trips_destinations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => tripsTrips.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    country: text("country"),
    countryCode: text("country_code"),
    /** BCP-47 tags, most useful first. Decides which allergy cards to write. */
    languages: jsonb("languages").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    timezone: text("timezone"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    arriveOn: date("arrive_on"),
    departOn: date("depart_on"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("trips_destinations_trip_idx").on(t.tripId, t.sortOrder)],
);

export const ITINERARY_KINDS = ["flight", "train", "drive", "ferry", "lodging", "activity", "meal", "meeting", "note"] as const;
export type ItineraryKind = (typeof ITINERARY_KINDS)[number];

export const BOOKING_STATUSES = ["idea", "needs_booking", "booked", "confirmed", "cancelled"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const tripsItineraryItems = pgTable(
  "trips_itinerary_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => tripsTrips.id, { onDelete: "cascade" }),
    destinationId: uuid("destination_id").references(() => tripsDestinations.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ITINERARY_KINDS }).notNull(),
    title: text("title").notNull(),
    /**
     * Stored as UTC. `timezone` is the departure zone and `endTimezone` the
     * arrival zone, so a Philadelphia -> Zurich flight reads
     * "18:35 New York -> 08:15 Zurich", not one instant in the wrong zone.
     */
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at"),
    timezone: text("timezone"),
    endTimezone: text("end_timezone"),
    allDay: boolean("all_day").notNull().default(false),
    location: text("location"),
    address: text("address"),
    confirmation: text("confirmation"),
    url: text("url"),
    notes: text("notes"),

    bookingStatus: text("booking_status", { enum: BOOKING_STATUSES }).notNull().default("idea"),
    /** Who it is booked with: "American Airlines", "OeBB", "Marriott". Also the merchant for card rules. */
    provider: text("provider"),
    bookingUrl: text("booking_url"),
    /** Some operators only open sales a fixed window ahead (OeBB, for one). */
    bookingOpensOn: date("booking_opens_on"),
    verifyBy: date("verify_by"),
    verifiedAt: ts("verified_at"),
    verifiedNote: text("verified_note"),
    seatNote: text("seat_note"),
    gfVetted: boolean("gf_vetted").notNull().default(false),

    // Money, for the card-rewards link.
    /** Expected or actual cost in USD. */
    cost: money("cost"),
    /** Finance account id of the card it was paid with (finance owns the account). */
    paidWithAccountId: uuid("paid_with_account_id"),
    /** When the charge posts or is expected to (booking date, not travel date). */
    chargeDate: date("charge_date"),

    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("trips_itinerary_trip_idx").on(t.tripId, t.startsAt),
    index("trips_itinerary_status_idx").on(t.tripId, t.bookingStatus),
  ],
);

// ---------------------------------------------------------------------------
// Packing: reusable templates that clone into per-trip lists
// ---------------------------------------------------------------------------

export const PACKING_CATEGORIES = [
  "clothing",
  "toiletries",
  "electronics",
  "documents",
  "medical",
  "gf_food",
  "kids",
  "gear",
  "other",
] as const;
export type PackingCategory = (typeof PACKING_CATEGORIES)[number];

export const tripsPackingTemplates = pgTable(
  "trips_packing_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    tags: jsonb("tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("trips_packing_templates_name_uq").on(t.name)],
);

export const tripsPackingTemplateItems = pgTable("trips_packing_template_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  templateId: uuid("template_id")
    .notNull()
    .references(() => tripsPackingTemplates.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category", { enum: PACKING_CATEGORIES }).notNull().default("other"),
  quantity: integer("quantity").notNull().default(1),
  /** True for items each traveller needs their own of; false for one per family. */
  perPerson: boolean("per_person").notNull().default(true),
  notes: text("notes"),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const tripsPackingLists = pgTable("trips_packing_lists", {
  id: uuid("id").primaryKey().defaultRandom(),
  tripId: uuid("trip_id")
    .notNull()
    .references(() => tripsTrips.id, { onDelete: "cascade" }),
  templateId: uuid("template_id").references(() => tripsPackingTemplates.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const tripsPackingItems = pgTable("trips_packing_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  listId: uuid("list_id")
    .notNull()
    .references(() => tripsPackingLists.id, { onDelete: "cascade" }),
  /** Null means shared / family. */
  travelerId: uuid("traveler_id").references(() => tripsTravelers.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  category: text("category", { enum: PACKING_CATEGORIES }).notNull().default("other"),
  quantity: integer("quantity").notNull().default(1),
  packed: boolean("packed").notNull().default(false),
  notes: text("notes"),
  sortOrder: integer("sort_order").notNull().default(0),
});

// ---------------------------------------------------------------------------
// Gluten-free dining
// ---------------------------------------------------------------------------

export const DINING_SOURCES = ["manual", "find_me_gluten_free", "openstreetmap", "recommendation"] as const;
export const GF_STATUSES = ["unknown", "dedicated_gf", "gf_menu", "accommodating", "avoid"] as const;
export type GfStatus = (typeof GF_STATUSES)[number];

export const tripsDiningPlaces = pgTable(
  "trips_dining_places",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    destinationId: uuid("destination_id").references(() => tripsDestinations.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    cuisine: text("cuisine"),
    address: text("address"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    phone: text("phone"),
    website: text("website"),
    source: text("source", { enum: DINING_SOURCES }).notNull().default("manual"),
    /** Stable id in the source, so repeat imports update instead of duplicating. */
    sourceRef: text("source_ref"),
    fmgfUrl: text("fmgf_url"),
    gfStatus: text("gf_status", { enum: GF_STATUSES }).notNull().default("unknown"),
    dedicatedFryer: boolean("dedicated_fryer"),
    celiacFriendly: boolean("celiac_friendly"),
    visited: boolean("visited").notNull().default(false),
    favorite: boolean("favorite").notNull().default(false),
    ourRating: integer("our_rating"),
    notes: text("notes"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("trips_dining_source_uq").on(t.source, t.sourceRef)],
);

/** A printable "I have coeliac disease" card in the local language. */
export const tripsAllergyCards = pgTable(
  "trips_allergy_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    destinationId: uuid("destination_id")
      .notNull()
      .references(() => tripsDestinations.id, { onDelete: "cascade" }),
    travelerId: uuid("traveler_id")
      .notNull()
      .references(() => tripsTravelers.id, { onDelete: "cascade" }),
    language: text("language").notNull(),
    languageName: text("language_name").notNull(),
    body: text("body").notNull(),
    /** What the card says, in English, so you know what you are handing over. */
    englishBody: text("english_body").notNull(),
    /** Set when a human has confirmed the translation reads correctly. */
    verified: boolean("verified").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("trips_allergy_cards_uq").on(t.destinationId, t.language, t.travelerId)],
);

// ---------------------------------------------------------------------------
// Trivia & kids mode
// ---------------------------------------------------------------------------

export const TRIVIA_CATEGORIES = ["general", "history", "food", "nature", "architecture", "culture", "language"] as const;

export const tripsTriviaFacts = pgTable("trips_trivia_facts", {
  id: uuid("id").primaryKey().defaultRandom(),
  destinationId: uuid("destination_id")
    .notNull()
    .references(() => tripsDestinations.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  category: text("category", { enum: TRIVIA_CATEGORIES }).notNull().default("general"),
  kidFriendly: boolean("kid_friendly").notNull().default(false),
  sourceName: text("source_name"),
  sourceUrl: text("source_url"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const tripsQuizzes = pgTable("trips_quizzes", {
  id: uuid("id").primaryKey().defaultRandom(),
  destinationId: uuid("destination_id")
    .notNull()
    .references(() => tripsDestinations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  minAge: integer("min_age").notNull().default(6),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const tripsQuizQuestions = pgTable("trips_quiz_questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  quizId: uuid("quiz_id")
    .notNull()
    .references(() => tripsQuizzes.id, { onDelete: "cascade" }),
  prompt: text("prompt").notNull(),
  choices: jsonb("choices").$type<string[]>().notNull(),
  answerIndex: integer("answer_index").notNull(),
  explanation: text("explanation"),
  points: integer("points").notNull().default(10),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const tripsQuizAttempts = pgTable("trips_quiz_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  quizId: uuid("quiz_id")
    .notNull()
    .references(() => tripsQuizzes.id, { onDelete: "cascade" }),
  travelerId: uuid("traveler_id")
    .notNull()
    .references(() => tripsTravelers.id, { onDelete: "cascade" }),
  score: integer("score").notNull(),
  totalPoints: integer("total_points").notNull(),
  completedAt: ts("completed_at").notNull().defaultNow(),
});

export const tripsHunts = pgTable("trips_hunts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tripId: uuid("trip_id")
    .notNull()
    .references(() => tripsTrips.id, { onDelete: "cascade" }),
  destinationId: uuid("destination_id").references(() => tripsDestinations.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const tripsHuntTasks = pgTable("trips_hunt_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  huntId: uuid("hunt_id")
    .notNull()
    .references(() => tripsHunts.id, { onDelete: "cascade" }),
  prompt: text("prompt").notNull(),
  hint: text("hint"),
  points: integer("points").notNull().default(10),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const tripsHuntCompletions = pgTable(
  "trips_hunt_completions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tripsHuntTasks.id, { onDelete: "cascade" }),
    travelerId: uuid("traveler_id")
      .notNull()
      .references(() => tripsTravelers.id, { onDelete: "cascade" }),
    completedAt: ts("completed_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("trips_hunt_completions_uq").on(t.taskId, t.travelerId)],
);

// ---------------------------------------------------------------------------
// Documents vault & emergency info
// ---------------------------------------------------------------------------

export const DOCUMENT_KINDS = [
  "passport",
  "visa",
  "id_card",
  "insurance",
  "vaccination",
  "booking",
  "ticket",
  "medical",
  "other",
] as const;

/**
 * Passports, insurance, tickets. File bytes are AES-256-GCM encrypted with
 * DOC_VAULT_KEY before they reach the database. Only the last four
 * characters of a document number and the expiry are kept in the clear, so
 * lists and expiry warnings work without decrypting anything.
 */
export const tripsDocuments = pgTable(
  "trips_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null for household-level documents such as passports. */
    tripId: uuid("trip_id").references(() => tripsTrips.id, { onDelete: "cascade" }),
    itineraryItemId: uuid("itinerary_item_id").references(() => tripsItineraryItems.id, { onDelete: "set null" }),
    travelerId: uuid("traveler_id").references(() => tripsTravelers.id, { onDelete: "set null" }),
    uploadedBy: text("uploaded_by"),
    kind: text("kind", { enum: DOCUMENT_KINDS }).notNull().default("other"),
    title: text("title").notNull(),
    filename: text("filename"),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    cipherText: bytea("cipher_text"),
    iv: bytea("iv"),
    authTag: bytea("auth_tag"),
    documentNumberLast4: text("document_number_last4"),
    expiresOn: date("expires_on"),
    issuingCountry: text("issuing_country"),
    notes: text("notes"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("trips_documents_trip_idx").on(t.tripId)],
);

export type EmergencyEntry = { name: string; detail: string | null };

export const tripsEmergencyInfo = pgTable("trips_emergency_info", {
  destinationId: uuid("destination_id")
    .primaryKey()
    .references(() => tripsDestinations.id, { onDelete: "cascade" }),
  emergencyNumber: text("emergency_number"),
  hospitals: jsonb("hospitals").$type<EmergencyEntry[]>().notNull().default(sql`'[]'::jsonb`),
  pharmacies: jsonb("pharmacies").$type<EmergencyEntry[]>().notNull().default(sql`'[]'::jsonb`),
  embassies: jsonb("embassies").$type<EmergencyEntry[]>().notNull().default(sql`'[]'::jsonb`),
  gfGroceries: jsonb("gf_groceries").$type<EmergencyEntry[]>().notNull().default(sql`'[]'::jsonb`),
  notes: text("notes"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
