import "server-only";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { canSeeOwner, HiddenAccountError, visibleTo, type Viewer } from "../access";
import { accountFamily, guessAccountKind, kindsCompatible } from "../ingest/account-kind";
import { refreshGuessedKinds } from "../ingest/kinds";
import { cleanTypedName } from "../ingest/redact";
import { ACCOUNT_KIND_LABELS, financeAccounts, financeTransactions as t, type AccountKind, type Owner } from "../schema";
import { recordReviewAction, type TxnSnapshot } from "./log";

/**
 * Step 1 of the Finance review: are the imports and the bank feed telling one
 * consistent story? Everything here is plain code (no AI): matching amounts
 * and dates is arithmetic, and a person confirms each fix. Only accounts the
 * member can see (joint + their own) are looked at or changed.
 */

const DAY = 86_400_000;
/** CSV and bank-feed copies of one purchase post within this many days of each other. */
export const DUPLICATE_WINDOW_DAYS = 3;
const STALE_BALANCE_DAYS = 3;
const QUIET_ACCOUNT_DAYS = 90;
const HANDOFF_GAP_DAYS = 10;

const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const cents = (n: number) => Math.round(n * 100);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

type AccountRow = typeof financeAccounts.$inferSelect;

async function visibleAccounts(viewer: Viewer): Promise<AccountRow[]> {
  return db().select().from(financeAccounts).where(visibleTo(viewer)).orderBy(asc(financeAccounts.owner), asc(financeAccounts.bankName));
}

async function visibleAccount(viewer: Viewer, id: string): Promise<AccountRow> {
  const [row] = await db().select().from(financeAccounts).where(eq(financeAccounts.id, id));
  if (!row || !canSeeOwner(viewer, row.owner)) throw new HiddenAccountError();
  return row;
}

const nameOf = (a: Pick<AccountRow, "displayName" | "bankName">) => a.displayName ?? a.bankName;

// ---------------------------------------------------------------- names ----

const STOP = new Set(["the", "card", "account", "acct", "credit", "visa", "mastercard", "imported", "closed", "hidden", "and", "of", "bank"]);
const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/\((imported|closed|hidden)\)/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w)),
  );

/** 0..1: how alike two account names are (shared meaningful words). */
export function nameSimilarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size);
}

/**
 * A tidier nickname: no "(Imported)" tag, no stray dashes, dots or spacing,
 * and ALL-CAPS bank names in title case. Digit runs are already gone.
 */
export function tidyAccountName(name: string): string {
  let out = name
    .replace(/\s*\((imported|closed|hidden)\)\s*/gi, " ")
    .replace(/\.{2,}|…/g, " ")
    .replace(/\s*[-–—|/:]+\s*$/g, "")
    .replace(/^\s*[-–—|/:]+\s*/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (out.length > 3 && out === out.toUpperCase() && /[A-Z]/.test(out)) {
    out = out.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
  }
  return cleanTypedName(out) ?? name;
}

// ------------------------------------------------------------ the report ----

export type ImportedMatch = {
  accountId: string;
  name: string;
  owner: Owner;
  count: number;
  first: string;
  last: string;
  /** Best linked (bank-feed) account by name, if any looks right. */
  suggestedIntoId: string | null;
  /**
   * Linked accounts it could go into. Never one of another family: a bank
   * account's history is never offered a credit card, or the reverse.
   */
  candidates: { id: string; name: string; owner: Owner; kind: AccountKind; score: number; simplefinStartDate: string | null }[];
};

export type DuplicatePair = {
  accountId: string;
  account: string;
  csvId: string;
  bankId: string;
  csvDate: string;
  bankDate: string;
  amount: number;
  csvMerchant: string;
  bankMerchant: string;
};

export type NameFix = {
  accountId: string;
  current: string;
  suggested: string;
  kind: AccountKind;
  suggestedKind: AccountKind;
  owner: Owner;
};

export type CoverageNote = {
  accountId: string;
  account: string;
  level: "info" | "warn";
  text: string;
  /** Offer "Mark inactive" next to the note. */
  offerDeactivate?: boolean;
};

export type ReconcileReport = {
  accounts: number;
  imported: ImportedMatch[];
  duplicates: DuplicatePair[];
  names: NameFix[];
  coverage: CoverageNote[];
};

type Stats = { accountId: string; source: "simplefin" | "csv"; count: number; first: string; last: string };

async function statsBySource(ids: string[]): Promise<Stats[]> {
  if (!ids.length) return [];
  return db()
    .select({
      accountId: t.accountId,
      source: t.source,
      count: sql<number>`count(*)::int`,
      first: sql<string>`min(${t.postedDate})::text`,
      last: sql<string>`max(${t.postedDate})::text`,
    })
    .from(t)
    .where(inArray(t.accountId, ids))
    .groupBy(t.accountId, t.source);
}

/** Months (YYYY-MM) between first and last with no transactions at all. */
async function emptyMonths(accountId: string, first: string, last: string): Promise<string[]> {
  const rows = await db()
    .select({ month: sql<string>`to_char(${t.postedDate}, 'YYYY-MM')` })
    .from(t)
    .where(eq(t.accountId, accountId))
    .groupBy(sql`to_char(${t.postedDate}, 'YYYY-MM')`);
  const have = new Set(rows.map((r) => r.month));
  const out: string[] = [];
  const d = new Date(`${first.slice(0, 7)}-01T00:00:00Z`);
  const end = last.slice(0, 7);
  while (d.toISOString().slice(0, 7) < end) {
    d.setUTCMonth(d.getUTCMonth() + 1);
    const m = d.toISOString().slice(0, 7);
    if (m < end && !have.has(m)) out.push(m);
  }
  return out;
}

export async function findDuplicates(viewer: Viewer, accountIds?: string[]): Promise<DuplicatePair[]> {
  const accounts = (await visibleAccounts(viewer)).filter((a) => !accountIds || accountIds.includes(a.id));
  const stats = await statsBySource(accounts.map((a) => a.id));
  const pairs: DuplicatePair[] = [];
  for (const a of accounts) {
    const bank = stats.find((s) => s.accountId === a.id && s.source === "simplefin");
    const csv = stats.find((s) => s.accountId === a.id && s.source === "csv");
    if (!bank || !csv || csv.last < shift(bank.first, -DUPLICATE_WINDOW_DAYS)) continue;
    const since = shift(bank.first, -DUPLICATE_WINDOW_DAYS);
    const rows = await db()
      .select({ id: t.id, source: t.source, date: t.postedDate, amount: t.amount, merchant: t.merchant })
      .from(t)
      .where(and(eq(t.accountId, a.id), gte(t.postedDate, since)))
      .orderBy(asc(t.postedDate));
    pairs.push(...matchCopies(rows).map((m) => ({ ...m, accountId: a.id, account: nameOf(a) })));
  }
  return pairs;
}

const shift = (date: string, n: number) => isoDay(new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY));

type Row = { id: string; source: "simplefin" | "csv"; date: string; amount: number; merchant: string };

/**
 * Pairs each CSV row with the closest-dated unused bank-feed row of the same
 * amount, within the window. Each bank row is used once, so two real $5
 * coffees on the same day stay two.
 */
export function matchCopies(rows: Row[]) {
  const bank = rows.filter((r) => r.source === "simplefin");
  const used = new Set<string>();
  const out: Omit<DuplicatePair, "accountId" | "account">[] = [];
  for (const c of rows.filter((r) => r.source === "csv")) {
    let best: Row | null = null;
    for (const b of bank) {
      if (used.has(b.id) || cents(b.amount) !== cents(c.amount)) continue;
      const gap = Math.abs(days(c.date, b.date));
      if (gap > DUPLICATE_WINDOW_DAYS) continue;
      if (!best || gap < Math.abs(days(c.date, best.date))) best = b;
    }
    if (!best) continue;
    used.add(best.id);
    out.push({ csvId: c.id, bankId: best.id, csvDate: c.date, bankDate: best.date, amount: c.amount, csvMerchant: c.merchant, bankMerchant: best.merchant });
  }
  return out;
}

export async function reconcileReport(viewer: Viewer, now = new Date()): Promise<ReconcileReport> {
  // Types still guessed are worked out from activity first, so a checking
  // import is never offered a credit card to merge into.
  await refreshGuessedKinds((await visibleAccounts(viewer)).map((a) => a.id));
  const accounts = await visibleAccounts(viewer);
  const stats = await statsBySource(accounts.map((a) => a.id));
  const statOf = (id: string, source: Stats["source"]) => stats.find((s) => s.accountId === id && s.source === source);
  const today = isoDay(now);
  const linked = accounts.filter((a) => a.simplefinId);

  const imported: ImportedMatch[] = [];
  for (const a of accounts) {
    if (a.simplefinId || !a.active) continue;
    const csv = statOf(a.id, "csv");
    if (!csv || statOf(a.id, "simplefin")) continue;
    // An untyped import is judged by what its name says it is.
    const kind = a.kind === "other" ? guessAccountKind(`${nameOf(a)} ${a.bankName}`) : a.kind;
    const candidates = linked
      .filter((l) => kindsCompatible(kind, l.kind))
      .map((l) => ({
        id: l.id,
        name: nameOf(l),
        owner: l.owner,
        kind: l.kind,
        score: Math.max(nameSimilarity(nameOf(a), nameOf(l)), nameSimilarity(a.bankName, l.bankName), l.officialName ? nameSimilarity(nameOf(a), l.officialName) : 0),
        simplefinStartDate: l.simplefinStartDate,
      }))
      .sort((x, y) => Number(y.kind === kind) - Number(x.kind === kind) || y.score - x.score || x.name.localeCompare(y.name));
    // Suggest only an account of the same family (checking with checking or
    // savings, card with card); an untyped one is listed, never suggested.
    const family = accountFamily(kind);
    const best = candidates.find((c) => family && accountFamily(c.kind) === family && c.score >= 0.5);
    imported.push({
      accountId: a.id,
      name: nameOf(a),
      owner: a.owner,
      count: csv.count,
      first: csv.first,
      last: csv.last,
      suggestedIntoId: best?.id ?? null,
      candidates,
    });
  }

  const names: NameFix[] = [];
  for (const a of accounts) {
    const current = nameOf(a);
    const suggested = tidyAccountName(current);
    const guessed = guessAccountKind(`${current} ${a.officialName ?? ""}`);
    const suggestedKind = a.kind === "other" ? guessed : a.kind;
    if (suggested !== current || suggestedKind !== a.kind) {
      names.push({ accountId: a.id, current, suggested, kind: a.kind, suggestedKind, owner: a.owner });
    }
  }
  const byName = new Map<string, AccountRow[]>();
  for (const a of accounts.filter((x) => x.active)) {
    const k = tidyAccountName(nameOf(a)).toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), a]);
  }

  const coverage: CoverageNote[] = [];
  for (const [, same] of byName) {
    if (same.length < 2) continue;
    if (same.filter((a) => a.simplefinId).length < 2) continue;
    coverage.push({
      accountId: same[0].id,
      account: nameOf(same[0]),
      level: "info",
      text: `${same.length} linked accounts are called "${nameOf(same[0])}". Give each a nickname on the Accounts page so they're easy to tell apart.`,
    });
  }
  for (const a of accounts) {
    const bank = statOf(a.id, "simplefin");
    const csv = statOf(a.id, "csv");
    const name = nameOf(a);
    if (a.simplefinId && a.active) {
      if (!a.balanceDate || now.getTime() - a.balanceDate.getTime() > STALE_BALANCE_DAYS * DAY) {
        coverage.push({
          accountId: a.id,
          account: name,
          level: "warn",
          text: a.balanceDate
            ? `Balance last updated ${isoDay(a.balanceDate)}. The bank connection may need attention in SimpleFIN.`
            : "No balance from the bank yet. Run Sync now in Settings, or check the connection in SimpleFIN.",
        });
      }
      const start = a.simplefinStartDate ?? bank?.first ?? null;
      if (start && csv && days(csv.last, start) > HANDOFF_GAP_DAYS) {
        coverage.push({
          accountId: a.id,
          account: name,
          level: "warn",
          text: `No transactions between ${csv.last} (end of the imported history) and ${start} (start of bank sync). Export that range from Simplifi and import it.`,
        });
      }
      if (start && !csv && !imported.some((m) => m.suggestedIntoId === a.id)) {
        coverage.push({
          accountId: a.id,
          account: name,
          level: "info",
          text: `History starts ${start}, when bank sync began. Older transactions can come from a Simplifi export.`,
        });
      }
    }
    if (!a.simplefinId && a.active) {
      const last = csv?.last ?? bank?.last ?? null;
      if (last && days(last, today) > QUIET_ACCOUNT_DAYS && !imported.some((m) => m.accountId === a.id && m.suggestedIntoId)) {
        coverage.push({
          accountId: a.id,
          account: name,
          level: "info",
          text: `Imported history only, last transaction ${last}. If it's closed, mark it inactive; if it's still open, add it to the SimpleFIN connection.`,
          offerDeactivate: true,
        });
      }
    }
    const first = [bank?.first, csv?.first].filter(Boolean).sort()[0];
    const last = [bank?.last, csv?.last].filter(Boolean).sort().at(-1);
    const total = (bank?.count ?? 0) + (csv?.count ?? 0);
    if (first && last && total >= 30 && a.kind !== "loan" && a.kind !== "investment" && a.kind !== "savings") {
      const empty = await emptyMonths(a.id, first, last);
      if (empty.length) {
        coverage.push({
          accountId: a.id,
          account: name,
          level: "warn",
          text: `No transactions in ${empty.length > 6 ? `${empty.slice(0, 6).join(", ")} and ${empty.length - 6} more months` : empty.join(", ")}. A missing export, or the card sat unused?`,
        });
      }
    }
  }

  return { accounts: accounts.length, imported, duplicates: await findDuplicates(viewer), names, coverage };
}

// ---------------------------------------------------------------- fixes ----

function snapshot(row: typeof t.$inferSelect): TxnSnapshot {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

/**
 * Moves an imported (CSV-only) account's history into the linked account it
 * duplicates. CSV rows that the bank feed already has (same amount within
 * the window) or that were already imported into the linked account are
 * removed rather than moved. The emptied account is marked inactive.
 * Everything is logged so the merge can be undone.
 */
export async function mergeImportedAccount(viewer: Viewer, fromId: string, intoId: string) {
  if (fromId === intoId) throw new Error("Pick a different account to merge into");
  const from = await visibleAccount(viewer, fromId);
  const into = await visibleAccount(viewer, intoId);
  if (from.simplefinId) throw new Error("Only imported (CSV) accounts can be merged into another");
  if (!kindsCompatible(from.kind, into.kind)) {
    throw new Error(`A ${ACCOUNT_KIND_LABELS[from.kind].toLowerCase()} account can't be merged into a ${ACCOUNT_KIND_LABELS[into.kind].toLowerCase()}. Fix the type on the Accounts page if it's wrong.`);
  }

  const fromRows = await db().select().from(t).where(eq(t.accountId, fromId));
  const intoRows = await db()
    .select({ id: t.id, source: t.source, externalId: t.externalId, date: t.postedDate, amount: t.amount, merchant: t.merchant })
    .from(t)
    .where(eq(t.accountId, intoId));
  const existingCsv = new Set(intoRows.filter((r) => r.source === "csv").map((r) => r.externalId));
  const dupIds = new Set(
    matchCopies([
      ...intoRows.filter((r) => r.source === "simplefin"),
      ...fromRows.map((r) => ({ id: r.id, source: r.source, date: r.postedDate, amount: r.amount, merchant: r.merchant })),
    ]).map((m) => m.csvId),
  );
  const removed = fromRows.filter((r) => dupIds.has(r.id) || (r.source === "csv" && existingCsv.has(r.externalId)));
  const removedIds = new Set(removed.map((r) => r.id));
  const moved = fromRows.filter((r) => !removedIds.has(r.id)).map((r) => r.id);

  await db().transaction(async (tx) => {
    for (let i = 0; i < removed.length; i += 500) {
      await tx.delete(t).where(inArray(t.id, removed.slice(i, i + 500).map((r) => r.id)));
    }
    for (let i = 0; i < moved.length; i += 500) {
      await tx.update(t).set({ accountId: intoId }).where(inArray(t.id, moved.slice(i, i + 500)));
    }
    await tx.update(financeAccounts).set({ active: false }).where(eq(financeAccounts.id, fromId));
  });
  const summary = `Merged "${nameOf(from)}" into "${nameOf(into)}": ${moved.length} moved, ${removed.length} duplicates removed`;
  await recordReviewAction(viewer, "merge_account", summary, { fromId, intoId, moved, removed: removed.map(snapshot), wasActive: from.active });
  return { moved: moved.length, removed: removed.length, summary };
}

/** Removes CSV copies of transactions the bank feed also has (ids from findDuplicates). */
export async function removeDuplicateCopies(viewer: Viewer, csvIds: string[]) {
  if (!csvIds.length) return { removed: 0, summary: "Nothing to remove" };
  // Only rows findDuplicates still pairs, on accounts this member can see.
  const still = new Set((await findDuplicates(viewer)).map((p) => p.csvId));
  const ids = csvIds.filter((id) => still.has(id));
  if (!ids.length) return { removed: 0, summary: "Those duplicates were already removed" };
  const rows = await db().select().from(t).where(and(inArray(t.id, ids), eq(t.source, "csv")));
  await db().delete(t).where(inArray(t.id, rows.map((r) => r.id)));
  const summary = `Removed ${rows.length} duplicate imported ${rows.length === 1 ? "transaction" : "transactions"}`;
  await recordReviewAction(viewer, "remove_duplicates", summary, { removed: rows.map(snapshot) });
  return { removed: rows.length, summary };
}

export async function renameAccountForReview(viewer: Viewer, id: string, displayName: string, kind: AccountKind) {
  const a = await visibleAccount(viewer, id);
  const name = cleanTypedName(displayName);
  if (!name) throw new Error("Type a name");
  const before = { displayName: a.displayName, kind: a.kind };
  const after = { displayName: name, kind };
  if (before.displayName === after.displayName && before.kind === after.kind) return { summary: "No change" };
  await db().update(financeAccounts).set({ ...after, kindSource: "manual" }).where(eq(financeAccounts.id, id));
  const summary = `Renamed "${nameOf(a)}" to "${name}"${kind !== a.kind ? ` (${kind.replace(/_/g, " ")})` : ""}`;
  await recordReviewAction(viewer, "rename_account", summary, { accountId: id, before, after });
  return { summary };
}

export async function deactivateAccountForReview(viewer: Viewer, id: string) {
  const a = await visibleAccount(viewer, id);
  if (!a.active) return { summary: "Already inactive" };
  await db().update(financeAccounts).set({ active: false }).where(eq(financeAccounts.id, id));
  const summary = `Marked "${nameOf(a)}" inactive`;
  await recordReviewAction(viewer, "deactivate_account", summary, { accountId: id });
  return { summary };
}
