import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/utils";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { OWNER_LABELS, listRecentTransactions, viewerFromLabel, visibleAccountImages, visibleAccountLast4 } from "@/modules/finance/api";
import { CardThumb, CardThumbsProvider } from "@/modules/finance/ui/card-thumbs";
import { categorizeWithAiAction, setMerchantCategoryAction } from "../actions";

/** Shown next to automatic categories; hover for why. */
const SOURCE_LABEL: Partial<Record<string, string>> = { history: "from history", ai: "Claude" };

export default async function TransactionsPage() {
  const viewer = viewerFromLabel((await requireUserOrRedirect()).owner);
  const [rows, images, last4] = await Promise.all([
    listRecentTransactions(viewer, 300),
    visibleAccountImages(viewer),
    visibleAccountLast4(viewer),
  ]);
  const uncategorized = rows.filter((r) => !r.category && !r.isTransfer).length;
  const categories = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort() as string[];
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-4">
        <h1 className="text-2xl font-semibold">Recent transactions</h1>
        {uncategorized ? (
          <form action={categorizeWithAiAction} className="ml-auto">
            <Button size="sm" variant="outline">Categorize {uncategorized}+ (history, then Claude)</Button>
          </form>
        ) : null}
      </div>
      <datalist id="categories">
        {categories.map((c) => <option key={c} value={c} />)}
      </datalist>
      <CardThumbsProvider images={images}>
      {/* Phone: one card per transaction instead of a table wider than the screen. */}
      <ul className="divide-y rounded-xl border text-sm md:hidden">
        {rows.map((t) => (
          <li key={t.id} className={`space-y-2 p-3 ${t.isTransfer ? "opacity-50" : ""}`}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate font-medium">
                {t.merchant}
                {t.pending ? <span className="ml-1 text-xs font-normal text-muted-foreground">pending</span> : null}
              </span>
              <span className={`shrink-0 tabular-nums ${t.amount < 0 ? "" : "text-success"}`}>{formatMoney(t.amount, { cents: true })}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span>{t.date}</span>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1">
                <CardThumb accountId={t.accountId} /> {t.account ?? t.bankName}
                {last4[t.accountId] ? <span className="font-mono">··{last4[t.accountId]}</span> : null}
              </span>
              <span aria-hidden>·</span>
              <span>{OWNER_LABELS[t.owner]}</span>
            </div>
            <form action={setMerchantCategoryAction} className="grid grid-cols-[1fr_1fr_auto] items-center gap-1.5">
              <input type="hidden" name="merchant" value={t.merchant} />
              <input name="category" list="categories" defaultValue={t.category ?? ""} placeholder="Uncategorized" required aria-label="Category"
                className="h-8 min-w-0 rounded border bg-transparent px-1.5" />
              <input name="subcategory" defaultValue={t.subcategory ?? ""} placeholder="Subcategory" aria-label="Subcategory"
                className="h-8 min-w-0 rounded border bg-transparent px-1.5" />
              <button className="px-1 text-xs underline">Save</button>
            </form>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto md:block">
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
                  {t.category && t.categorySource && SOURCE_LABEL[t.categorySource] ? (
                    <span className="self-center text-xs text-muted-foreground" title={t.categoryReason ?? undefined}>
                      {SOURCE_LABEL[t.categorySource]}
                    </span>
                  ) : null}
                </form>
              </td>
              <td className="whitespace-nowrap">
                <CardThumb accountId={t.accountId} /> {t.account ?? t.bankName}
                {last4[t.accountId] ? <span className="ml-1 font-mono text-xs text-muted-foreground">··{last4[t.accountId]}</span> : null}
              </td>
              <td>{OWNER_LABELS[t.owner]}</td>
              <td className={`text-right tabular-nums ${t.amount < 0 ? "" : "text-success"}`}>{formatMoney(t.amount, { cents: true })}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      </CardThumbsProvider>
    </section>
  );
}
