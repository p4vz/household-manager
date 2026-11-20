import { OWNER_LABELS, listRecentTransactions } from "@/modules/finance/api";

export default async function TransactionsPage() {
  const rows = await listRecentTransactions(200);
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Recent transactions</h1>
      <table className="w-full text-sm">
        <thead className="text-left opacity-70">
          <tr><th className="py-1">Date</th><th>Merchant</th><th>Category</th><th>Account</th><th>Owner</th><th className="text-right">Amount</th></tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className={`border-t ${t.isTransfer ? "opacity-50" : ""}`}>
              <td className="py-1.5">{t.date}</td>
              <td>{t.merchant}{t.pending ? <span className="ml-1 text-xs opacity-60">pending</span> : null}</td>
              <td>{t.category ?? <span className="opacity-50">Uncategorized</span>}{t.subcategory ? ` · ${t.subcategory}` : ""}</td>
              <td>{t.account ?? t.bankName}</td>
              <td>{OWNER_LABELS[t.owner]}</td>
              <td className={`text-right tabular-nums ${t.amount < 0 ? "" : "text-green-600"}`}>
                {t.amount.toLocaleString("en-US", { style: "currency", currency: "USD" })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
