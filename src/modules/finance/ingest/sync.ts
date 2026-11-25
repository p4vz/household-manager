import "server-only";
import { and, desc, eq, gte, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { bus } from "@/core/bus";
import { db } from "@/core/db/client";
import { householdTimeZone as tz, zonedParts } from "@/core/time/zoned";
import { financeAccounts, financeBalanceSnapshots, financeSyncRuns, financeTransactions } from "../schema";
import { categorizeTransactions } from "../categorize/run";
import type { Viewer } from "../access";
import { getAccessUrl, newAccountOwner } from "./credentials";
import { guessAccountKind, looksLikeTransfer, normalizeMerchant } from "./merchant";
import { extractLast4, stripAccountNumbers } from "./redact";
import { MIN_MANUAL_SYNC_INTERVAL_MS, MIN_SYNC_INTERVAL_MS, STALE_RUN_MS } from "./schedule";
import { fetchAccounts, type SimplefinAccountSet } from "./simplefin";

const INITIAL_LOOKBACK_DAYS = 89;
const OVERLAP_DAYS = 5;
const DAY = 24 * 60 * 60 * 1000;

export type SyncResult =
  | { status: "skipped"; reason: string }
  | { status: "ok"; inserted: number; accounts: number; messages: string[] }
  | { status: "error"; error: string };

const MIN_INTERVAL: Record<"cron" | "setup" | "manual", number> = {
  cron: MIN_SYNC_INTERVAL_MS,
  manual: MIN_MANUAL_SYNC_INTERVAL_MS,
  // A fresh connection always syncs (unless a run is already in flight).
  setup: 0,
};

/**
 * Pull accounts + transactions from SimpleFIN and upsert them. One HTTP
 * request per run. Scheduled runs are at least MIN_SYNC_INTERVAL_MS apart,
 * "Sync now" at least MIN_MANUAL_SYNC_INTERVAL_MS after the last run.
 */
export async function syncSimplefin(opts: {
  trigger: "cron" | "setup" | "manual";
  now?: Date;
  fetcher?: typeof fetchAccounts;
}): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  const accessUrl = await getAccessUrl();
  if (!accessUrl) return { status: "skipped", reason: "SimpleFIN is not connected" };

  const [last] = await db()
    .select()
    .from(financeSyncRuns)
    .where(inArray(financeSyncRuns.status, ["ok", "running"]))
    .orderBy(desc(financeSyncRuns.startedAt))
    .limit(1);
  if (last) {
    const age = now.getTime() - last.startedAt.getTime();
    if (last.status === "running" && age < STALE_RUN_MS) return { status: "skipped", reason: "A sync is already running" };
    if (age < MIN_INTERVAL[opts.trigger]) {
      const wait = Math.ceil((MIN_INTERVAL[opts.trigger] - age) / 60_000);
      return {
        status: "skipped",
        reason: opts.trigger === "manual" ? `Synced a few minutes ago. Try again in ${wait} min.` : "Synced recently",
      };
    }
  }

  const [lastOk] = await db()
    .select()
    .from(financeSyncRuns)
    .where(eq(financeSyncRuns.status, "ok"))
    .orderBy(desc(financeSyncRuns.startedAt))
    .limit(1);
  const start = lastOk
    ? new Date(lastOk.startedAt.getTime() - OVERLAP_DAYS * DAY)
    : new Date(now.getTime() - INITIAL_LOOKBACK_DAYS * DAY);

  const [run] = await db()
    .insert(financeSyncRuns)
    .values({ trigger: opts.trigger, status: "running", startedAt: now })
    .returning();

  try {
    const data = await (opts.fetcher ?? fetchAccounts)(accessUrl, start, now);
    const inserted = await applyAccountSet(data, await newAccountOwner());
    // From history only (no AI here): amount, account, memo, recurrence and
    // past categories. The scheduled run asks Claude about what is left.
    await categorizeTransactions({ ai: false, now }).catch((err) =>
      console.error(`[finance] history categorization failed: ${err instanceof Error ? err.message : err}`),
    );
    await db()
      .update(financeSyncRuns)
      .set({ status: "ok", finishedAt: new Date(), inserted, messages: data.errors })
      .where(eq(financeSyncRuns.id, run.id));
    await bus.publish("finance", "finance.transactionsSynced", { source: "simplefin", inserted });
    return { status: "ok", inserted, accounts: data.accounts.length, messages: data.errors };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await db()
      .update(financeSyncRuns)
      .set({ status: "error", finishedAt: new Date(), messages: [error] })
      .where(eq(financeSyncRuns.id, run.id));
    return { status: "error", error };
  }
}

function isoDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * A card added by hand (from a photo, before the bank sync knew it) becomes
 * the synced account when exactly one unsynced account has the same last
 * four digits, so it keeps its picture, owner and rewards setup.
 */
async function adoptManualAccount(simplefinId: string, last4: string) {
  const [known] = await db().select({ id: financeAccounts.id }).from(financeAccounts).where(eq(financeAccounts.simplefinId, simplefinId));
  if (known) return;
  const matches = await db()
    .select({ id: financeAccounts.id })
    .from(financeAccounts)
    .where(and(isNull(financeAccounts.simplefinId), eq(financeAccounts.last4, last4)));
  if (matches.length !== 1) return;
  await db().update(financeAccounts).set({ simplefinId }).where(eq(financeAccounts.id, matches[0].id));
}

export async function applyAccountSet(data: SimplefinAccountSet, owner: Viewer | "joint" = "joint"): Promise<number> {
  let inserted = 0;
  for (const acct of data.accounts) {
    const last4 = extractLast4(acct.name);
    if (last4) await adoptManualAccount(acct.id, last4);
    const [account] = await db()
      .insert(financeAccounts)
      .values({
        simplefinId: acct.id,
        bankName: stripAccountNumbers(acct.name),
        last4,
        owner,
        institution: acct.org.name ?? acct.org.domain ?? null,
        kind: guessAccountKind(acct.name),
        currency: acct.currency,
        balance: acct.balance,
        balanceDate: new Date(acct["balance-date"] * 1000),
      })
      .onConflictDoUpdate({
        target: financeAccounts.simplefinId,
        // User-owned fields (display name, owner, kind, active) are left alone.
        set: {
          bankName: stripAccountNumbers(acct.name),
          ...(last4 ? { last4 } : {}),
          institution: acct.org.name ?? acct.org.domain ?? null,
          currency: acct.currency,
          balance: acct.balance,
          balanceDate: new Date(acct["balance-date"] * 1000),
        },
      })
      .returning();

    // One balance per account per day, for net worth history.
    await db()
      .insert(financeBalanceSnapshots)
      .values({ accountId: account.id, date: zonedParts(new Date(acct["balance-date"] * 1000), tz()).date, balance: acct.balance })
      .onConflictDoUpdate({ target: [financeBalanceSnapshots.accountId, financeBalanceSnapshots.date], set: { balance: acct.balance } });

    if (acct.transactions.length === 0) continue;

    const rows = acct.transactions.map((t) => {
      const description = [t.payee, t.description].find((s) => s && s.trim()) ?? "Unknown";
      const when = t.posted > 0 ? t.posted : (t.transacted_at ?? t.posted);
      return {
        accountId: account.id,
        source: "simplefin" as const,
        externalId: t.id,
        postedDate: isoDay(when),
        amount: t.amount,
        description: t.description || description,
        merchant: normalizeMerchant(description),
        memo: t.memo?.trim() ? stripAccountNumbers(t.memo.trim(), "") || null : null,
        pending: Boolean(t.pending),
        isTransfer: looksLikeTransfer(`${t.description} ${t.payee ?? ""}`),
      };
    });

    const earliest = rows.reduce((min, r) => (r.postedDate < min ? r.postedDate : min), rows[0].postedDate);
    if (!account.simplefinStartDate || earliest < account.simplefinStartDate) {
      await db().update(financeAccounts).set({ simplefinStartDate: earliest }).where(eq(financeAccounts.id, account.id));
    }
    // SimpleFIN is the source of truth from its start date on: drop CSV rows
    // that overlap it so history imported earlier never doubles up.
    const cutoff = !account.simplefinStartDate || earliest < account.simplefinStartDate ? earliest : account.simplefinStartDate;
    await db()
      .delete(financeTransactions)
      .where(
        and(
          eq(financeTransactions.accountId, account.id),
          eq(financeTransactions.source, "csv"),
          gte(financeTransactions.postedDate, cutoff),
        ),
      );

    for (let i = 0; i < rows.length; i += 500) {
      // Categories are worked out after the whole set is in (categorizeTransactions).
      const chunk = rows.slice(i, i + 500);
      const result = await db()
        .insert(financeTransactions)
        .values(chunk)
        .onConflictDoUpdate({
          target: [financeTransactions.accountId, financeTransactions.source, financeTransactions.externalId],
          // Pending -> posted can change date/amount; never touch user edits.
          set: {
            postedDate: sql`excluded.posted_date`,
            amount: sql`excluded.amount`,
            pending: sql`excluded.pending`,
            memo: sql`excluded.memo`,
          },
        })
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      inserted += result.filter((r) => r.inserted).length;
    }

    // Banks often re-issue a pending transaction under a new id once it
    // posts. Pending rows in this window that SimpleFIN no longer reports
    // are stale and would otherwise double-count.
    await db()
      .delete(financeTransactions)
      .where(
        and(
          eq(financeTransactions.accountId, account.id),
          eq(financeTransactions.source, "simplefin"),
          eq(financeTransactions.pending, true),
          gte(financeTransactions.postedDate, earliest),
          notInArray(
            financeTransactions.externalId,
            rows.map((r) => r.externalId),
          ),
        ),
      );
  }
  return inserted;
}
