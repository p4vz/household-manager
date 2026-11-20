import "server-only";
import { asc, gte } from "drizzle-orm";
import type { ModuleName } from "@/core/bus/events";
import { db } from "@/core/db/client";
import { financeExpectedExpenses } from "./schema";

/** Finance module public API (grows with the finance milestones). */
export type ExpectedExpense = {
  title: string;
  date: string;
  amount: number;
  category?: string | null;
};

/** Record a known upcoming cost owned by another module. Idempotent. */
export async function upsertExpectedExpense(
  source: { module: ModuleName; ref: string },
  expense: ExpectedExpense,
) {
  await db()
    .insert(financeExpectedExpenses)
    .values({
      ...expense,
      category: expense.category ?? null,
      sourceModule: source.module,
      sourceRef: source.ref,
    })
    .onConflictDoUpdate({
      target: [financeExpectedExpenses.sourceModule, financeExpectedExpenses.sourceRef],
      set: { title: expense.title, date: expense.date, amount: expense.amount },
    });
}

export async function listExpectedExpenses(fromDate: string) {
  return db()
    .select({
      title: financeExpectedExpenses.title,
      date: financeExpectedExpenses.date,
      amount: financeExpectedExpenses.amount,
      category: financeExpectedExpenses.category,
      sourceModule: financeExpectedExpenses.sourceModule,
    })
    .from(financeExpectedExpenses)
    .where(gte(financeExpectedExpenses.date, fromDate))
    .orderBy(asc(financeExpectedExpenses.date));
}
