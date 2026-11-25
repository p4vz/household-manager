import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/utils";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { OWNER_LABELS, listRecentTransactions, viewerFromLabel } from "@/modules/finance/api";
import { categorizeWithAiAction, setMerchantCategoryAction } from "../actions";

export default async function TransactionsPage() {
  const viewer = viewerFromLabel((await requireUserOrRedirect()).owner);
  const rows = await listRecentTransactions(viewer, 300);
  const uncategorized = rows.filter((r) => !r.category && !r.isTransfer).length;
  const categories = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort() as string[];
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-4">
        <h1 className="text-2xl font-semibold">Recent transactions</h1>
        {uncategorized ? (
          <form action={categorizeWithAiAction} className="ml-auto">
            <Button size="sm" variant="outline">Categorize {uncategorized}+ with AI</Button>
          </form>
        ) : null}
      </div>
      <datalist id="categories">
        {categories.map((c) => <option key={c} value={c} />)}
      </datalist>
      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground">
          <tr><th className="py-1">Date</th><th>Merchant</th><th>Category (applies to all from this merchant)</th><th>Account</th><th>Owner</th><th className="text-right">Amount</th></tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className={`border-t ${t.isTransfer ? "opacity-50" : ""}`}>
              <td className="py-1.5">{t.date}</td>
              <td>{t.merchant}{t.pending ? <span className="ml-1 text-xs text-muted-foreground">pending</span> : null}</td>
              <td>
                <form action={setMerchantCategoryAction} className="flex gap-1">
                  <input type="hidden" name="merchant" value={t.merchant} />
                  <input name="category" list="categories" defaultValue={t.category ?? ""} placeholder="Uncategorized" required
                    className="h-7 w-40 rounded border bg-transparent px-1" />
                  <input name="subcategory" defaultValue={t.subcategory ?? ""} placeholder="Subcategory"
                    className="h-7 w-32 rounded border bg-transparent px-1" />
                  <button className="text-xs underline">Save</button>
                </form>
              </td>
              <td>{t.account ?? t.bankName}</td>
              <td>{OWNER_LABELS[t.owner]}</td>
              <td className={`text-right tabular-nums ${t.amount < 0 ? "" : "text-success"}`}>{formatMoney(t.amount, { cents: true })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
