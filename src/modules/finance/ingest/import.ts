import "server-only";
import { sql } from "drizzle-orm";
import { bus } from "@/core/bus";
import { db } from "@/core/db/client";
import { financeAccounts, financeTransactions } from "../schema";
import { canSeeOwner, type Viewer } from "../access";
import { learnRules } from "./categorize";
import {
  assignExternalIds,
  parseSimplifiCsv,
  summarizeByAccount,
  summarizeSkipped,
  type CsvColumns,
  type CsvRow,
  type SkipSummary,
} from "./csv";
import { guessAccountKind } from "./account-kind";
import { refreshGuessedKinds } from "./kinds";
import { extractLast4, stripAccountNumbers } from "./redact";

/** "new" creates a CSV-only account named after the CSV account. */
export type AccountMapping = Record<string, string | "new" | "skip">;

export type ImportPreview = {
  accounts: (ReturnType<typeof summarizeByAccount>[number] & { suggestedAccountId: string | null })[];
  skippedLines: number;
  /** Why lines were skipped, grouped by reason, so a bad export is easy to diagnose. */
  skipReasons: SkipSummary[];
  /** CSV header each field is read from. */
  columns: CsvColumns;
  readableRows: number;
  existingAccounts: { id: string; name: string; simplefinStartDate: string | null }[];
};

/** Accounts this member may import into: joint ones and their own. */
async function existingAccounts(viewer: Viewer) {
  const rows = (await db().select().from(financeAccounts)).filter((a) => canSeeOwner(viewer, a.owner));
  return rows.map((a) => ({
    id: a.id,
    name: a.displayName ?? a.bankName,
    bankName: a.bankName,
    simplefinStartDate: a.simplefinStartDate,
  }));
}

export async function previewCsvImport(viewer: Viewer, text: string): Promise<ImportPreview> {
  const { rows, skipped, columns } = parseSimplifiCsv(text);
  const accounts = await existingAccounts(viewer);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return {
    accounts: summarizeByAccount(rows).map((s) => ({
      ...s,
      suggestedAccountId:
        accounts.find(
          (a) =>
            norm(a.name) === norm(s.name) ||
            norm(a.bankName) === norm(s.name) ||
            norm(a.bankName) === norm(stripAccountNumbers(s.name)),
        )?.id ?? null,
    })),
    skippedLines: skipped.length,
    skipReasons: summarizeSkipped(skipped),
    columns,
    readableRows: rows.length,
    existingAccounts: accounts.map(({ id, name, simplefinStartDate }) => ({ id, name, simplefinStartDate })),
  };
}

export type ImportResult = {
  inserted: number;
  alreadyPresent: number;
  coveredBySimplefin: number;
  skippedLines: number;
  skipReasons: SkipSummary[];
};

/**
 * Import history. Rows dated on/after an account's SimpleFIN start date are
 * dropped (SimpleFIN owns that period), and re-imported rows are ignored.
 */
export async function commitCsvImport(viewer: Viewer, text: string, mapping: AccountMapping): Promise<ImportResult> {
  const { rows, skipped } = parseSimplifiCsv(text);
  const accounts = await existingAccounts(viewer);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const result: ImportResult = {
    inserted: 0,
    alreadyPresent: 0,
    coveredBySimplefin: 0,
    skippedLines: skipped.length,
    skipReasons: summarizeSkipped(skipped),
  };

  const grouped = new Map<string, CsvRow[]>();
  for (const r of rows) grouped.set(r.account, [...(grouped.get(r.account) ?? []), r]);

  for (const [csvName, accountRows] of grouped) {
    const target = mapping[csvName] ?? "skip";
    if (target === "skip") continue;

    let accountId: string;
    let cutoff: string | null = null;
    if (target === "new") {
      const [created] = await db()
        .insert(financeAccounts)
        // New CSV-only accounts start private to the person importing them.
        .values({ bankName: stripAccountNumbers(csvName), last4: extractLast4(csvName), kind: guessAccountKind(csvName), owner: viewer })
        .returning();
      accountId = created.id;
    } else {
      const acct = byId.get(target);
      if (!acct) throw new Error(`Unknown account for "${csvName}"`);
      accountId = acct.id;
      cutoff = acct.simplefinStartDate;
    }

    const withIds = assignExternalIds(accountRows);
    const eligible = withIds.filter((r) => !cutoff || r.date < cutoff);
    result.coveredBySimplefin += withIds.length - eligible.length;

    for (let i = 0; i < eligible.length; i += 500) {
      const chunk = eligible.slice(i, i + 500).map((r) => ({
        accountId,
        source: "csv" as const,
        externalId: r.externalId,
        postedDate: r.date,
        amount: r.amount,
        description: r.description,
        merchant: r.merchant,
        category: r.category,
        subcategory: r.subcategory,
        categorySource: r.category ? ("import" as const) : null,
        notes: r.notes,
        pending: r.pending,
        isTransfer: r.isTransfer,
      }));
      const inserted = await db()
        .insert(financeTransactions)
        .values(chunk)
        .onConflictDoNothing()
        .returning({ id: financeTransactions.id });
      result.inserted += inserted.length;
      result.alreadyPresent += chunk.length - inserted.length;
    }
    await learnRules(eligible);
  }

  await refreshGuessedKinds();
  // Keep planner statistics fresh after a big history load.
  await db().execute(sql`analyze finance_transactions`);
  await bus.publish("finance", "finance.transactionsSynced", { source: "csv", inserted: result.inserted });
  return result;
}
