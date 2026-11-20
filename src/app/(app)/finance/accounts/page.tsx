import { ACCOUNT_KINDS, OWNERS, OWNER_LABELS, listAccounts } from "@/modules/finance/api";
import { updateAccountAction } from "../actions";

export default async function AccountsPage() {
  const accounts = await listAccounts();
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Accounts and cards</h1>
      {accounts.length === 0 ? <p className="opacity-70">No accounts yet. Connect SimpleFIN or import a CSV.</p> : null}
      <div className="space-y-2">
        {accounts.map((a) => (
          <form key={a.id} action={updateAccountAction} className="flex flex-wrap items-end gap-3 rounded-xl border p-4 text-sm">
            <input type="hidden" name="id" value={a.id} />
            <div className="min-w-48 flex-1">
              <div className="opacity-60">
                {a.institution ? `${a.institution} · ` : ""}
                {a.bankName} {a.linked ? "· bank sync" : "· CSV only"}
              </div>
              <input name="displayName" defaultValue={a.displayName ?? ""} placeholder="Display name, e.g. Alex's Sapphire"
                className="mt-1 w-full rounded border bg-transparent px-2 py-1" />
            </div>
            <label>
              Owner
              <select name="owner" defaultValue={a.owner} className="ml-2 rounded border bg-transparent px-2 py-1">
                {OWNERS.map((o) => <option key={o} value={o}>{OWNER_LABELS[o]}</option>)}
              </select>
            </label>
            <label>
              Type
              <select name="kind" defaultValue={a.kind} className="ml-2 rounded border bg-transparent px-2 py-1">
                {ACCOUNT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" name="active" defaultChecked={a.active} /> Active
            </label>
            <span className="w-28 text-right tabular-nums">
              {a.balance != null ? a.balance.toLocaleString("en-US", { style: "currency", currency: a.currency }) : ""}
            </span>
            <button className="rounded border px-3 py-1">Save</button>
          </form>
        ))}
      </div>
    </section>
  );
}
