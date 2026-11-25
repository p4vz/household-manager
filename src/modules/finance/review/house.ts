import "server-only";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/core/db/client";
import { visibleTo, type Viewer } from "../access";
import { financeAccounts, financeReviewQuestions as q, financeReviewState, financeTransactions as t, type HouseSuggestion } from "../schema";
import { notDone } from "./large";

/**
 * What finance offers the house audit (src/assistant/house-audit.ts): the
 * questionable transactions a member goes through one by one on the Home
 * maintenance page, lookups for matching house projects to payments, and
 * where the audit's guesses and last run are kept. Visible accounts only.
 */

export type HouseQuestionKind = "cash" | "car" | "uncategorized" | "house";

/** Home categories whose spending belongs in the house history. */
const HOME_SUBCATEGORIES = ["Home Improvement", "Repairs & Maintenance", "Furnishings", "Appliances", "Lawn & Garden", "Home Services", "Security"];
/** Merchants that are almost always about the house. */
export const HOME_VENDOR_PATTERN =
  "(home depot|lowe'?s|menards|ace hardware|true value|sherwin|benjamin moore|plumb|hvac|heating|cooling|roof|gutter|electric(al)? contract|landscap|lawn|tree (service|removal|care)|pest|exterminat|appliance|abc supply|floor|carpet|tile|window|siding|paving|masonry|handyman|septic|chimney|water heater|pool|fence)";
/**
 * Car upkeep: shops, parts stores, dealers' service, inspections and the DMV.
 * Fuel, parking, tolls and car washes are left out on purpose: too many and
 * never maintenance.
 */
export const CAR_VENDOR_PATTERN =
  "(jiffy lube|valvoline|midas|meineke|pep boys|firestone|goodyear|discount tire|tire (kingdom|rack|discounters)|mavis|monro|caliber collision|maaco|safelite|autozone|advance auto|napa auto|o'?reilly auto|auto (repair|service|body|parts)|collision|body shop|oil change|lube|penndot|dmv|motor vehicle|emissions|state inspection|car ?care)";
const CAR_SUBCATEGORIES = ["Service & Parts", "Registration & DMV"];
const CASH_PATTERN = "(atm|cash withdrawal|withdrawal|cash advance)";

const accountName = sql<string>`coalesce(${financeAccounts.displayName}, ${financeAccounts.bankName})`;

const isCash = or(eq(t.subcategory, "Cash & ATM"), sql`${t.description} ~* ${CASH_PATTERN}`, sql`${t.merchant} ~* ${CASH_PATTERN}`)!;
const isCar = or(and(eq(t.category, "Auto & Transport"), inArray(t.subcategory, CAR_SUBCATEGORIES)), sql`${t.merchant} ~* ${CAR_VENDOR_PATTERN}`)!;
const isHouse = or(
  and(eq(t.category, "Home"), inArray(t.subcategory, HOME_SUBCATEGORIES)),
  sql`${t.merchant} ~* ${HOME_VENDOR_PATTERN}`,
)!;

function kindOf(r: { category: string | null; subcategory: string | null; merchant: string; description: string }): HouseQuestionKind {
  const cash = new RegExp(CASH_PATTERN, "i");
  if (r.subcategory === "Cash & ATM" || cash.test(r.description) || cash.test(r.merchant)) return "cash";
  if ((r.category === "Auto & Transport" && CAR_SUBCATEGORIES.includes(r.subcategory ?? "")) || new RegExp(CAR_VENDOR_PATTERN, "i").test(r.merchant)) return "car";
  if (!r.category) return "uncategorized";
  return "house";
}

/**
 * Open questionable transactions, newest first: cash withdrawals, spending
 * with no category, likely house expenses and car upkeep. Leaves out anything already
 * answered or skipped, transfers, and transactions already in the house
 * history (`linkedIds`).
 */
export async function houseQuestions(viewer: Viewer, opts: { linkedIds?: string[]; limit?: number; offset?: number; minAmount?: number } = {}) {
  const where: SQL[] = [
    visibleTo(viewer),
    eq(t.isTransfer, false),
    eq(t.pending, false),
    lte(t.amount, -(opts.minAmount ?? 20)),
    notDone!,
    or(isCash, isNull(t.category), isHouse, isCar)!,
  ];
  if (opts.linkedIds?.length) where.push(notInArray(t.id, opts.linkedIds));
  const base = db()
    .select({
      id: t.id,
      date: t.postedDate,
      merchant: t.merchant,
      description: t.description,
      amount: t.amount,
      category: t.category,
      subcategory: t.subcategory,
      notes: t.notes,
      account: accountName,
      suggestion: q.suggestion,
    })
    .from(t)
    .innerJoin(financeAccounts, eq(t.accountId, financeAccounts.id))
    .leftJoin(q, eq(q.transactionId, t.id))
    .where(and(...where));
  const rows = await base
    .orderBy(desc(t.postedDate), asc(t.merchant))
    .limit(Math.min(opts.limit ?? 25, 200))
    .offset(opts.offset ?? 0);
  const [{ n }] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(t)
    .innerJoin(financeAccounts, eq(t.accountId, financeAccounts.id))
    .leftJoin(q, eq(q.transactionId, t.id))
    .where(and(...where));
  return { rows: rows.map((r) => ({ ...r, kind: kindOf(r) })), count: n };
}

export type HouseQuestion = Awaited<ReturnType<typeof houseQuestions>>["rows"][number];

/** Visible spending of about `amount` dollars within `days` of `date` (for matching a house project to its payment). */
export async function paymentsNear(viewer: Viewer, amount: number, date: string, days = 60, tolerance = 1) {
  const from = new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  return db()
    .select({ id: t.id, date: t.postedDate, merchant: t.merchant, amount: t.amount })
    .from(t)
    .innerJoin(financeAccounts, eq(t.accountId, financeAccounts.id))
    .where(and(visibleTo(viewer), gte(t.postedDate, from), lte(t.postedDate, to), gte(t.amount, -amount - tolerance), lte(t.amount, -amount + tolerance)))
    .orderBy(asc(t.postedDate));
}

/** Visible transactions whose merchant or description contains `text` (vendor matching). */
export async function paymentsMatching(viewer: Viewer, text: string, from: string, to: string) {
  const like = `%${text.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  return db()
    .select({ id: t.id, date: t.postedDate, merchant: t.merchant, amount: t.amount })
    .from(t)
    .innerJoin(financeAccounts, eq(t.accountId, financeAccounts.id))
    .where(and(visibleTo(viewer), gte(t.postedDate, from), lte(t.postedDate, to), lte(t.amount, 0), or(ilike(t.merchant, like), ilike(t.description, like))))
    .orderBy(asc(t.postedDate));
}

/** Keeps the audit's guesses for open transactions (never overwrites an answer or a skip). */
export async function saveHouseSuggestions(viewer: Viewer, items: { transactionId: string; suggestion: HouseSuggestion }[]) {
  for (const i of items) {
    await db()
      .insert(q)
      .values({ transactionId: i.transactionId, viewer, status: "suggested", suggestion: i.suggestion })
      .onConflictDoUpdate({ target: q.transactionId, set: { suggestion: i.suggestion }, setWhere: eq(q.status, "suggested") });
  }
}

export async function houseAuditState(viewer: Viewer) {
  const [row] = await db()
    .select({ at: financeReviewState.houseAuditAt, note: financeReviewState.houseAuditNote })
    .from(financeReviewState)
    .where(eq(financeReviewState.viewer, viewer));
  return { at: row?.at ?? null, note: row?.note ?? null };
}

export async function setHouseAuditState(viewer: Viewer, at: Date, note: string) {
  await db()
    .insert(financeReviewState)
    .values({ viewer, houseAuditAt: at, houseAuditNote: note.slice(0, 500) })
    .onConflictDoUpdate({ target: financeReviewState.viewer, set: { houseAuditAt: at, houseAuditNote: note.slice(0, 500), updatedAt: at } });
}
