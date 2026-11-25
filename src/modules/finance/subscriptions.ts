import "server-only";
import { and, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/core/db/client";
import { canSeeOwner, visibleOwners, type Viewer } from "./access";
import { detectRecurring, monthlyCost, nextChargeDate, type RecurringCharge } from "./subscriptions-detect";
import {
  financeAccounts,
  financeSubscriptions,
  financeTransactions,
  type Owner,
  type SubscriptionCadence,
  type SubscriptionStatus,
} from "./schema";

export { detectRecurring, monthlyCost, nextChargeDate, type RecurringCharge };

/**
 * Running subscriptions for one member: recurring charges detected on the
 * accounts they can see, merged with what the household confirmed, edited,
 * cancelled or added by hand. Never sent to an AI.
 */
export type SubscriptionRow = {
  /** Stored row id, or null for a detected charge nobody has confirmed yet. */
  id: string | null;
  merchantKey: string | null;
  owner: Owner;
  name: string;
  amount: number | null;
  cadence: SubscriptionCadence;
  status: SubscriptionStatus;
  source: "detected" | "confirmed" | "manual";
  lastCharge: string | null;
  nextCharge: string | null;
  chargeCount: number;
  monthly: number;
  yearly: number;
  priceChange: { from: number; to: number; on: string } | null;
  /** Confirmed earlier but no charge lately: maybe cancelled. */
  noRecentCharge: boolean;
  /** Marked cancelled, yet charged again since. */
  stillCharging: boolean;
  notes: string | null;
};

const LOOKBACK_DAYS = 400;

function daysAgo(today: string, n: number) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function listSubscriptions(viewer: Viewer, today: string) {
  const owners = visibleOwners(viewer);
  const txns = await db()
    .select({
      owner: financeAccounts.owner,
      postedDate: financeTransactions.postedDate,
      amount: financeTransactions.amount,
      merchant: financeTransactions.merchant,
    })
    .from(financeTransactions)
    .innerJoin(financeAccounts, eq(financeAccounts.id, financeTransactions.accountId))
    .where(
      and(
        inArray(financeAccounts.owner, owners),
        gte(financeTransactions.postedDate, daysAgo(today, LOOKBACK_DAYS)),
        eq(financeTransactions.pending, false),
        eq(financeTransactions.isTransfer, false),
      ),
    );
  const detected = detectRecurring(txns, today);
  const stored = await db().select().from(financeSubscriptions).where(inArray(financeSubscriptions.owner, owners));
  return mergeSubscriptions(detected, stored, today);
}

type Stored = typeof financeSubscriptions.$inferSelect;

export function mergeSubscriptions(detected: RecurringCharge[], stored: Stored[], today: string) {
  const byKey = new Map(stored.filter((s) => s.merchantKey).map((s) => [`${s.owner}|${s.merchantKey}`, s]));
  const rows: SubscriptionRow[] = [];
  let hiddenCount = 0;
  const used = new Set<string>();

  for (const d of detected) {
    const s = byKey.get(`${d.owner}|${d.merchantKey}`);
    if (s) used.add(s.id);
    if (s?.status === "ignored") {
      hiddenCount++;
      continue;
    }
    if (!s && !d.active) continue;
    const cadence = s?.cadence ?? d.cadence;
    const amount = s?.amount ?? d.lastAmount;
    rows.push({
      id: s?.id ?? null,
      merchantKey: d.merchantKey,
      owner: d.owner,
      name: s?.name ?? d.name,
      amount,
      cadence,
      status: s?.status ?? "active",
      source: s ? "confirmed" : "detected",
      lastCharge: d.lastDate,
      nextCharge:
        s?.status === "cancelled" ? null : s?.nextCharge && s.nextCharge >= today ? s.nextCharge : d.active ? nextChargeDate(d.lastDate, cadence, today) : null,
      chargeCount: d.count,
      monthly: monthlyCost(amount, cadence),
      yearly: monthlyCost(amount, cadence) * 12,
      priceChange: d.priceChange,
      noRecentCharge: !d.active && s?.status !== "cancelled",
      stillCharging: s?.status === "cancelled" && d.lastDate > s.updatedAt.toISOString().slice(0, 10),
      notes: s?.notes ?? null,
    });
  }

  for (const s of stored) {
    if (used.has(s.id)) continue;
    if (s.status === "ignored") {
      hiddenCount++;
      continue;
    }
    rows.push({
      id: s.id,
      merchantKey: s.merchantKey,
      owner: s.owner,
      name: s.name,
      amount: s.amount,
      cadence: s.cadence,
      status: s.status,
      source: s.merchantKey ? "confirmed" : "manual",
      lastCharge: null,
      nextCharge: s.nextCharge,
      chargeCount: 0,
      monthly: monthlyCost(s.amount, s.cadence),
      yearly: monthlyCost(s.amount, s.cadence) * 12,
      priceChange: null,
      // A confirmed charge that no longer shows up at all.
      noRecentCharge: Boolean(s.merchantKey) && s.status === "active",
      stillCharging: false,
      notes: s.notes,
    });
  }

  rows.sort((a, b) => b.monthly - a.monthly || a.name.localeCompare(b.name));
  const active = rows.filter((r) => r.status === "active");
  const totals = (owner: Owner) => {
    const m = active.filter((r) => r.owner === owner).reduce((t, r) => t + r.monthly, 0);
    return { monthly: m, yearly: m * 12, count: active.filter((r) => r.owner === owner).length };
  };
  return {
    rows,
    hiddenCount,
    totals: { joint: totals("joint"), user1: totals("user1"), user2: totals("user2") },
  };
}

// ---------- edits ----------

function assertOwner(viewer: Viewer, owner: Owner) {
  if (!canSeeOwner(viewer, owner)) throw new Error("That subscription is not available to you");
}

async function storedRow(viewer: Viewer, id: string) {
  const [row] = await db().select().from(financeSubscriptions).where(eq(financeSubscriptions.id, id));
  if (!row) throw new Error("Subscription not found");
  assertOwner(viewer, row.owner);
  return row;
}

export type SubscriptionInput = {
  name: string;
  owner: Owner;
  amount: number | null;
  cadence: SubscriptionCadence;
  nextCharge: string | null;
  notes: string | null;
};

/** Saves a detected charge's row (confirm, rename, ignore, cancel): one per owner and merchant. */
export async function saveDetected(
  viewer: Viewer,
  key: { owner: Owner; merchantKey: string },
  patch: Partial<SubscriptionInput> & { status?: SubscriptionStatus; name: string },
) {
  assertOwner(viewer, key.owner);
  if (patch.owner) assertOwner(viewer, patch.owner);
  const values = { ...patch, owner: key.owner, merchantKey: key.merchantKey, createdBy: viewer, updatedAt: new Date() };
  const set = Object.fromEntries(Object.entries({ ...patch, updatedAt: new Date() }).filter(([k, v]) => v !== undefined && k !== "owner"));
  const [row] = await db()
    .insert(financeSubscriptions)
    .values(values)
    .onConflictDoUpdate({ target: [financeSubscriptions.owner, financeSubscriptions.merchantKey], set })
    .returning({ id: financeSubscriptions.id });
  return row.id;
}

export async function addManualSubscription(viewer: Viewer, input: SubscriptionInput) {
  assertOwner(viewer, input.owner);
  const [row] = await db()
    .insert(financeSubscriptions)
    .values({ ...input, merchantKey: null, status: "active", createdBy: viewer })
    .returning({ id: financeSubscriptions.id });
  return row.id;
}

export async function updateSubscription(viewer: Viewer, id: string, patch: Partial<SubscriptionInput> & { status?: SubscriptionStatus }) {
  const row = await storedRow(viewer, id);
  // A detected row keeps its owner (it follows the account); a manual one can move between joint and the viewer.
  if (patch.owner && (row.merchantKey || !canSeeOwner(viewer, patch.owner))) delete patch.owner;
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  await db().update(financeSubscriptions).set({ ...set, updatedAt: new Date() }).where(eq(financeSubscriptions.id, id));
}

/** Removes a stored row: a detected charge shows up again as "detected". */
export async function deleteSubscription(viewer: Viewer, id: string) {
  await storedRow(viewer, id);
  await db().delete(financeSubscriptions).where(eq(financeSubscriptions.id, id));
}
