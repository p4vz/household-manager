"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type ChangeRow = {
  id: string;
  entity: string;
  op: "create" | "update" | "delete";
  label: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  status: string;
  error: string | null;
};

export type ChangesetCardData = {
  id: string;
  summary: string;
  status: string;
  autoApplied: boolean;
  createdAt: string;
  changes: ChangeRow[];
};

type Actions = {
  apply: (input: { id: string }) => Promise<void>;
  discard: (input: { id: string }) => Promise<void>;
  undoOne: (input: { id: string }) => Promise<void>;
  undoAll: (input: { id: string }) => Promise<void>;
};

const ENTITY: Record<string, string> = {
  transaction: "Transaction",
  merchant_rule: "Category rule",
  upkeep_task: "Upkeep task",
  upkeep_asset: "Home equipment",
  house_project: "House project",
  shopping_item: "Shopping item",
  purchase_return: "Return",
  chore: "Chore",
  kid: "Kid",
  chore_goal: "Chore goal",
  shopping_list: "Shopping list",
  shopping_template: "List template",
  calendar_event: "Calendar event",
  binder_entry: "Home binder",
  trip_charge: "Trip charge",
};

const FIELD: Record<string, string> = {
  isTransfer: "Transfer",
  installedOn: "Installed",
  amountNote: "Amount note",
  lastDoneOn: "Last done",
  dueMileage: "Due at (miles)",
  recurrenceMiles: "Repeats every (miles)",
  lastDoneMileage: "Mileage when last done",
  mileageOn: "Mileage as of",
  dueDate: "Due",
  estimatedCost: "Estimated cost",
  recurrenceDays: "Repeats every (days)",
  list: "List",
  itemName: "Item",
  returnDeadline: "Return by",
  done: "Done",
  merchant: "Merchant",
  link: "Trip link",
  completedOn: "Done on",
  actualCost: "Cost",
  recurrence: "How often",
  target: "Target",
  rewardEmoji: "Reward emoji",
  rewardGiven: "Reward given",
  deferredUntil: "Put off until",
  allDay: "All day",
  startDate: "Starts",
  endDate: "Ends",
  startTime: "From",
  endTime: "To",
  startsOn: "Starts",
  expiresOn: "Ends / due",
  url: "Link",
};

const STATUS: Record<string, { text: string; variant: "default" | "secondary" | "warning" | "destructive" | "outline" }> = {
  proposed: { text: "Waiting for you", variant: "warning" },
  applied: { text: "Applied", variant: "secondary" },
  conflict: { text: "Skipped: changed meanwhile", variant: "warning" },
  failed: { text: "Failed", variant: "destructive" },
  discarded: { text: "Discarded", variant: "outline" },
  undone: { text: "Undone", variant: "outline" },
  undo_conflict: { text: "Not undone", variant: "warning" },
  partial: { text: "Partly applied", variant: "warning" },
};

type StoreItems = { store: string; items: { name: string; quantity?: string | null }[] }[];

function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "(empty)";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) {
    // A template's or list's stores and items.
    if (v.every((x) => x && typeof x === "object" && "store" in x && Array.isArray((x as StoreItems[number]).items))) {
      return (v as StoreItems).map((s) => `${s.store}: ${s.items.map((i) => (i.quantity ? `${i.name} (${i.quantity})` : i.name)).join(", ") || "nothing"}`).join("; ") || "(empty)";
    }
    return v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ") || "(empty)";
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function fieldLabel(k: string) {
  return FIELD[k] ?? k.charAt(0).toUpperCase() + k.slice(1);
}

/** Internal links (ids) that mean nothing on screen. */
const HIDDEN = new Set(["transactionId", "assetId", "projectId", "checked"]);

function Diff({ c }: { c: ChangeRow }) {
  if (c.op === "create") {
    return (
      <ul className="text-xs opacity-80">
        {Object.entries(c.after ?? {})
          .filter(([k, v]) => v !== null && v !== "" && v !== false && !HIDDEN.has(k))
          .map(([k, v]) => (
            <li key={k}>
              {fieldLabel(k)}: <span className="text-green-700">{show(v)}</span>
            </li>
          ))}
      </ul>
    );
  }
  if (c.op === "delete") {
    const archive = c.entity === "chore" || c.entity === "chore_goal" || c.entity === "kid";
    const text = c.entity === "kid" ? "Remove from the board (chores and history stay)" : archive ? "Archive (history stays)" : "Delete (restorable with Undo)";
    return <p className="text-xs text-red-700">{text}</p>;
  }
  return (
    <ul className="text-xs">
      {Object.keys(c.after ?? {}).map((k) => (
        <li key={k}>
          {fieldLabel(k)}: <span className="text-red-700 line-through">{show(c.before?.[k])}</span>{" "}
          <span aria-hidden>→</span> <span className="text-green-700">{show(c.after?.[k])}</span>
        </li>
      ))}
    </ul>
  );
}

export function ChangesetCard({ set, actions }: { set: ChangesetCardData; actions: Actions }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<void>) =>
    start(async () => {
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong");
      }
    });

  const status = STATUS[set.status] ?? { text: set.status, variant: "outline" as const };
  const canUndo = set.changes.some((c) => c.status === "applied");
  const counts = set.changes.length === 1 ? "1 change" : `${set.changes.length} changes`;

  return (
    <div className="mt-2 rounded-lg border bg-background p-3 text-sm" aria-busy={pending}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{counts}</span>
        <Badge variant={status.variant}>{status.text}</Badge>
        {set.autoApplied && <span className="text-xs opacity-60">applied automatically (small fix)</span>}
        <div className="ml-auto flex gap-2">
          {set.status === "proposed" && (
            <>
              <Button size="sm" disabled={pending} onClick={() => run(() => actions.apply({ id: set.id }))}>
                Apply
              </Button>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => actions.discard({ id: set.id }))}>
                Discard
              </Button>
            </>
          )}
          {canUndo && (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => actions.undoAll({ id: set.id }))}>
              Undo all
            </Button>
          )}
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
      <ul className="mt-2 divide-y">
        {set.changes.map((c) => {
          const s = STATUS[c.status] ?? { text: c.status, variant: "outline" as const };
          return (
            <li key={c.id} className="flex items-start gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p>
                  <span className="opacity-60">{ENTITY[c.entity] ?? c.entity}</span> {c.label}
                </p>
                <Diff c={c} />
                {c.error && <p className="text-xs opacity-60">{c.error}</p>}
              </div>
              {c.status !== "proposed" && <Badge variant={s.variant}>{s.text}</Badge>}
              {c.status === "applied" && (
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => actions.undoOne({ id: c.id }))}>
                  Undo
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
