"use client";

import { useState, useTransition } from "react";
import { ErrorNote, tap } from "./kit";

export type SuggestionView = {
  id: string;
  kind: "return_started" | "label" | "refund";
  store: string;
  itemName: string | null;
  returnDeadline: string | null;
  deadlineLabel: string | null;
  notes: string | null;
  match: { id: string; itemName: string } | null;
  emailUrl: string;
};

const KIND: Record<SuggestionView["kind"], string> = {
  return_started: "Return started",
  label: "Return label",
  refund: "Refund",
};

/**
 * Returns found in the member's own email, waiting for them. Nothing reaches
 * the shared list (or the kitchen screen) until they tap Add or Mark returned.
 */
export function SuggestionList({
  suggestions,
  review,
  markReturned,
  dismiss,
}: {
  suggestions: SuggestionView[];
  review: (s: SuggestionView) => void;
  markReturned: (input: { id: string }) => Promise<{ error: string | null }>;
  dismiss: (input: { id: string }) => Promise<void>;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2 rounded-xl border-2 border-dashed border-sky-500 p-2">
      <div className="px-1 text-sm font-semibold">📧 Found in your email (only you see these)</div>
      {suggestions.map((s) => (
        <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-sky-50 p-2 dark:bg-sky-950">
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">
              {s.kind === "refund" && s.match ? `Refund for ${s.match.itemName}` : s.itemName ?? "Item not named"}
            </div>
            <div className="text-sm opacity-80">
              {KIND[s.kind]} · {s.store}
              {s.deadlineLabel ? ` · ${s.deadlineLabel}` : ""}
            </div>
            {s.notes ? <div className="truncate text-sm opacity-70">{s.notes}</div> : null}
            <a href={s.emailUrl} target="_blank" rel="noreferrer noopener" className="text-sm underline">
              Open email
            </a>
          </div>
          {s.kind === "refund" && s.match ? (
            <button
              type="button"
              disabled={pending}
              className={`${tap} bg-emerald-600 text-white disabled:opacity-50`}
              onClick={() =>
                start(async () => {
                  setError((await markReturned({ id: s.id })).error);
                })
              }
            >
              ✓ Mark returned
            </button>
          ) : (
            <button type="button" disabled={pending} className={`${tap} bg-sky-600 text-white disabled:opacity-50`} onClick={() => review(s)}>
              Add…
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            disabled={pending}
            className={`${tap} px-2 opacity-60`}
            onClick={() => start(() => dismiss({ id: s.id }))}
          >
            ✕
          </button>
        </div>
      ))}
      <ErrorNote error={error} />
    </div>
  );
}
