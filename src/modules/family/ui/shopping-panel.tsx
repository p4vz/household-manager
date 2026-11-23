"use client";

import { startTransition, useOptimistic, useState } from "react";
import { PrintSlipButton } from "./print-slip";
import { field, tap } from "./kit";
import { shoppingSlip } from "./slips";

export type ShoppingItemView = { id: string; name: string; store: string; quantity: string | null; isStaple: boolean; checked: boolean };

type Actions = {
  setChecked: (input: { id: string; checked: boolean }) => Promise<void>;
  add: (input: { name: string; store: string; quantity?: string }) => Promise<void>;
  restock: (input: { store?: string }) => Promise<void>;
};

/**
 * Shopping by store. Staples (the default grocery list) and one-time items
 * share one list per store; tapping checks an item off. "Restock staples"
 * puts every staple back and clears bought one-time items.
 */
export function ShoppingPanel({
  items,
  stores,
  actions,
  dateLabel,
  manage,
}: {
  items: ShoppingItemView[];
  stores: string[];
  actions: Actions;
  dateLabel: string;
  /** Phone view: extra controls per item (staple toggle, delete). */
  manage?: (item: ShoppingItemView) => React.ReactNode;
}) {
  const [list, setOptimistic] = useOptimistic(items, (state, change: { id: string; checked: boolean }) =>
    state.map((i) => (i.id === change.id ? { ...i, checked: change.checked } : i)),
  );
  const storesInUse = [...new Set(list.map((i) => i.store))];
  const [filter, setFilter] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [store, setStore] = useState(filter ?? stores[0] ?? "");
  const [confirmRestock, setConfirmRestock] = useState(false);

  const shown = storesInUse.filter((s) => !filter || s === filter);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setFilter(null)} className={`${tap} ${filter === null ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900" : "border"}`}>
          All
        </button>
        {storesInUse.map((s) => (
          <button key={s} type="button" onClick={() => { setFilter(s); setStore(s); }} className={`${tap} ${filter === s ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900" : "border"}`}>
            {s} <span className="opacity-60">{list.filter((i) => i.store === s && !i.checked).length}</span>
          </button>
        ))}
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (!n || !store) return;
          setName("");
          startTransition(() => actions.add({ name: n, store }));
        }}
      >
        <input className={`${field} min-w-0 flex-1`} placeholder="Add item…" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        <select className={field} value={store} onChange={(e) => setStore(e.target.value)} aria-label="Store">
          {stores.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <button type="submit" className={`${tap} bg-sky-600 text-white`}>Add</button>
      </form>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain">
        {shown.length === 0 ? <p className="p-4 text-center opacity-60">The list is empty.</p> : null}
        {shown.map((s) => {
          const storeItems = list.filter((i) => i.store === s);
          const open = storeItems.filter((i) => !i.checked);
          return (
            <section key={s} className="rounded-xl border border-slate-200 p-2 dark:border-slate-700">
              <div className="mb-1 flex items-center justify-between gap-2">
                <h4 className="text-lg font-bold">{s}</h4>
                <PrintSlipButton
                  label="Print"
                  className={`${tap} border text-sm`}
                  lines={() => shoppingSlip(s, open.map((i) => ({ name: i.name, quantity: i.quantity })), dateLabel)}
                />
              </div>
              <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                {storeItems.map((i) => (
                  <li key={i.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        startTransition(async () => {
                          setOptimistic({ id: i.id, checked: !i.checked });
                          await actions.setChecked({ id: i.id, checked: !i.checked });
                        })
                      }
                      className={`flex min-h-12 flex-1 items-center gap-2 rounded-lg px-2 text-left ${i.checked ? "opacity-50" : "bg-slate-50 dark:bg-slate-800"}`}
                    >
                      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded border-2 ${i.checked ? "border-emerald-500 bg-emerald-500 text-white" : "border-slate-400"}`}>
                        {i.checked ? "✓" : ""}
                      </span>
                      <span className={`flex-1 text-base ${i.checked ? "line-through" : ""}`}>
                        {i.name}
                        {i.quantity ? <span className="opacity-60"> ({i.quantity})</span> : null}
                      </span>
                      {i.isStaple ? <span className="text-xs uppercase opacity-50">staple</span> : null}
                    </button>
                    {manage?.(i)}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      <div className="flex gap-2">
        {confirmRestock ? (
          <>
            <button
              type="button"
              className={`${tap} flex-1 bg-amber-500 text-white`}
              onClick={() => {
                setConfirmRestock(false);
                startTransition(() => actions.restock({ store: filter ?? undefined }));
              }}
            >
              Yes, restock {filter ?? "all stores"}
            </button>
            <button type="button" className={`${tap} border`} onClick={() => setConfirmRestock(false)}>Cancel</button>
          </>
        ) : (
          <button type="button" className={`${tap} border`} onClick={() => setConfirmRestock(true)}>
            ↻ Restock default staples
          </button>
        )}
      </div>
    </div>
  );
}
