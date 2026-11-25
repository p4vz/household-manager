"use client";

import { startTransition, useOptimistic, useState } from "react";
import { ErrorNote, Modal, field, tap } from "./kit";
import { ReturnReader, type ExtractResult } from "./return-reader";
import { SuggestionList, type SuggestionView } from "./return-suggestions";

export type ReturnView = {
  id: string;
  itemName: string;
  store: string;
  returnDeadline: string | null;
  status: "pending" | "packed_in_car" | "returned";
  notes: string | null;
  orderRef: string | null;
  urgency: "overdue" | "soon" | "ok";
  deadlineLabel: string | null;
};

export type ReturnFields = { itemName: string; store: string; returnDeadline?: string; notes?: string; orderRef?: string };

type Actions = {
  setStatus: (input: { id: string; status: ReturnView["status"] }) => Promise<void>;
  add: (input: ReturnFields) => Promise<{ error: string | null }>;
};

/** Phone only (a signed-in member): returns found in their email, and filling the form from a screenshot or text. */
export type MemberReturnTools = {
  suggestions: SuggestionView[];
  accept: (input: ReturnFields & { id: string }) => Promise<{ error: string | null }>;
  markReturned: (input: { id: string }) => Promise<{ error: string | null }>;
  dismiss: (input: { id: string }) => Promise<void>;
  extract: (input: { text: string }) => Promise<ExtractResult>;
};

const STATUS: Record<ReturnView["status"], { label: string; cls: string }> = {
  pending: { label: "To pack", cls: "bg-slate-200 text-slate-900 dark:bg-slate-700 dark:text-slate-100" },
  packed_in_car: { label: "🚗 In car", cls: "bg-sky-600 text-white" },
  returned: { label: "✓ Returned", cls: "bg-emerald-600 text-white" },
};

const URGENCY: Record<ReturnView["urgency"], string> = {
  overdue: "border-red-600 bg-red-50 dark:bg-red-950",
  soon: "border-amber-500 bg-amber-50 dark:bg-amber-950",
  ok: "border-slate-200 dark:border-slate-700",
};

const next = (s: ReturnView["status"]): ReturnView["status"] => (s === "pending" ? "packed_in_car" : "returned");

/** Returns to make, soonest deadline first. Tapping the status moves it along: to pack → in car → returned. */
export function ReturnsPanel({
  returns,
  stores,
  actions,
  manage,
  member,
}: {
  returns: ReturnView[];
  stores: string[];
  actions: Actions;
  manage?: (r: ReturnView) => React.ReactNode;
  member?: MemberReturnTools;
}) {
  const [list, setOptimistic] = useOptimistic(returns, (state, change: { id: string; status: ReturnView["status"] }) =>
    state.map((r) => (r.id === change.id ? { ...r, status: change.status } : r)),
  );
  const [adding, setAdding] = useState(false);
  const [reviewing, setReviewing] = useState<SuggestionView | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain">
        {member && member.suggestions.length > 0 ? (
          <li>
            <SuggestionList suggestions={member.suggestions} review={setReviewing} markReturned={member.markReturned} dismiss={member.dismiss} />
          </li>
        ) : null}
        {list.length === 0 ? <li className="p-4 text-center opacity-60">Nothing to return.</li> : null}
        {list.map((r) => (
          <li key={r.id} className={`flex items-center gap-3 rounded-xl border-2 p-2 ${URGENCY[r.urgency]} ${r.status === "returned" ? "opacity-50" : ""}`}>
            <div className="min-w-0 flex-1">
              <div className="truncate text-lg font-semibold">{r.itemName}</div>
              <div className="text-sm opacity-80">
                {r.store}
                {r.deadlineLabel ? (
                  <span className={`ml-2 font-semibold ${r.urgency === "ok" ? "" : r.urgency === "soon" ? "text-amber-700 dark:text-amber-300" : "text-red-700 dark:text-red-300"}`}>
                    · {r.deadlineLabel}
                  </span>
                ) : null}
                {r.orderRef ? <span className="ml-2 opacity-70">· #{r.orderRef}</span> : null}
              </div>
              {r.notes ? <div className="truncate text-sm opacity-70">{r.notes}</div> : null}
            </div>
            <button
              type="button"
              disabled={r.status === "returned"}
              onClick={() =>
                startTransition(async () => {
                  const status = next(r.status);
                  setOptimistic({ id: r.id, status });
                  await actions.setStatus({ id: r.id, status });
                })
              }
              className={`${tap} shrink-0 ${STATUS[r.status].cls}`}
            >
              {STATUS[r.status].label}
            </button>
            {manage?.(r)}
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => setAdding(true)} className={`${tap} self-start border-2 border-dashed border-slate-400`}>
        + Return
      </button>
      {adding ? <AddReturn stores={stores} add={actions.add} extract={member?.extract} onClose={() => setAdding(false)} /> : null}
      {reviewing && member ? (
        <AddReturn
          key={reviewing.id}
          title="Add found return"
          stores={stores}
          initial={{
            itemName: reviewing.itemName ?? "",
            store: reviewing.store,
            returnDeadline: reviewing.returnDeadline ?? undefined,
            notes: reviewing.notes ?? undefined,
          }}
          add={(fields) => member.accept({ ...fields, id: reviewing.id })}
          onClose={() => setReviewing(null)}
        />
      ) : null}
    </div>
  );
}

function AddReturn({
  stores,
  add,
  onClose,
  extract,
  initial,
  title = "Add a return",
}: {
  stores: string[];
  add: Actions["add"];
  onClose: () => void;
  extract?: MemberReturnTools["extract"];
  initial?: Partial<ReturnFields>;
  title?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Filled from a screenshot or pasted text; remounting the form shows the new values for review.
  const [values, setValues] = useState<{ v: Partial<ReturnFields>; n: number }>({ v: initial ?? {}, n: 0 });
  return (
    <Modal title={title} onClose={onClose}>
      {extract ? (
        <ReturnReader
          extract={extract}
          onFields={(f) =>
            setValues((prev) => ({
              v: { ...prev.v, ...Object.fromEntries(Object.entries(f).filter(([, x]) => x)) },
              n: prev.n + 1,
            }))
          }
        />
      ) : null}
      <form
        key={values.n}
        className="grid gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const val = (k: string) => (String(f.get(k) ?? "").trim() || undefined);
          setBusy(true);
          try {
            const res = await add({
              itemName: val("itemName") ?? "",
              store: val("store") ?? "",
              returnDeadline: val("returnDeadline"),
              notes: val("notes"),
              orderRef: val("orderRef"),
            });
            if (res.error) setError(res.error);
            else onClose();
          } catch {
            setError("That didn't save. Try again.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <input name="itemName" defaultValue={values.v.itemName} required maxLength={80} placeholder="Item" className={field} autoFocus />
        <input name="store" defaultValue={values.v.store} required maxLength={40} placeholder="Store" list="return-stores" className={field} />
        <datalist id="return-stores">
          {stores.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <label className="grid gap-1 text-sm">
          Return by
          <input name="returnDeadline" defaultValue={values.v.returnDeadline} type="date" className={field} />
        </label>
        <input name="orderRef" defaultValue={values.v.orderRef} maxLength={60} placeholder="Order number (optional)" className={field} />
        <input name="notes" defaultValue={values.v.notes} maxLength={300} placeholder="Notes, e.g. QR code in email (optional)" className={field} />
        <p className="text-xs opacity-60">Never type card or account numbers here: this shows on the kitchen screen.</p>
        <ErrorNote error={error} />
        <button type="submit" disabled={busy} className={`${tap} bg-sky-600 text-white disabled:opacity-50`}>
          {initial ? "Add to the list" : "Add return"}
        </button>
      </form>
    </Modal>
  );
}
