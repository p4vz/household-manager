import "server-only";
import { sql } from "drizzle-orm";
import { bus } from "@/core/bus";
import { db } from "@/core/db/client";
import { financeAccounts, financeTransactions } from "../schema";
import { learnRules } from "./categorize";
import { assignExternalIds, parseSimplifiCsv, summarizeByAccount, type CsvRow } from "./csv";
import { guessAccountKind } from "./merchant";

/** "new" creates a CSV-only account named after the CSV account. */
export type AccountMapping = Record<string, string | "new" | "skip">;

export type ImportPreview = {
  accounts: (ReturnType<typeof summarizeByAccount>[number] & { suggestedAccountId: string | null })[];
  skippedLines: number;
  existingAccounts: { id: string; name: string; simplefinStartDate: string | null }[];
};

async function existingAccounts() {
  const rows = await db().select().from(financeAccounts);
  return rows.map((a) => ({
    id: a.id,
    name: a.displayName ?? a.bankName,
    bankName: a.bankName,
    simplefinStartDate: a.simplefinStartDate,
  }));
}

export async function previewCsvImport(text: string): Promise<ImportPreview> {
  const { rows, skipped } = parseSimplifiCsv(text);
  const accounts = await existingAccounts();
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return {
    accounts: summarizeByAccount(rows).map((s) => ({
      ...s,
      suggestedAccountId:
        accounts.find((a) => norm(a.name) === norm(s.name) || norm(a.bankName) === norm(s.name))?.id ?? null,
    })),
    skippedLines: skipped.length,
    existingAccounts: accounts.map(({ id, name, simplefinStartDate }) => ({ id, name, simplefinStartDate })),
  };
}

export type ImportResult = {
  inserted: number;
  alreadyPresent: number;
  coveredBySimplefin: number;
  skippedLines: number;
};

/**
 * Import history. Rows dated on/after an account's SimpleFIN start date are
 * dropped (SimpleFIN owns that period), and re-imported rows are ignored.
 */
export async function commitCsvImport(text: string, mapping: AccountMapping): Promise<ImportResult> {
  const { rows, skipped } = parseSimplifiCsv(text);
  const accounts = await existingAccounts();
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const result: ImportResult = { inserted: 0, alreadyPresent: 0, coveredBySimplefin: 0, skippedLines: skipped.length };

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
        .values({ bankName: csvName, kind: guessAccountKind(csvName) })
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

  // Keep planner statistics fresh after a big history load.
  await db().execute(sql`analyze finance_transactions`);
  await bus.publish("finance", "finance.transactionsSynced", { source: "csv", inserted: result.inserted });
  return result;
}
