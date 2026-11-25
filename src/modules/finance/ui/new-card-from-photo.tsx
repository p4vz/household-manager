"use client";

import { startTransition, useActionState, useRef, useState } from "react";
import { shrink } from "./card-picture";

type State =
  | null
  | { ok: true; product: string; confidence: "high" | "medium" | "low"; hasTerms: boolean }
  | { ok: false; error: string };

const input = "w-full rounded border bg-transparent px-2 py-1";

/**
 * Add a card just opened: a photo of the front (number covered), who owns
 * it, and optionally a nickname and the last 4 digits. The photo is shrunk
 * and re-encoded in the browser before it is sent.
 */
export function NewCardFromPhoto({
  action,
  owners,
  defaultOwner,
  disabled,
}: {
  action: (prev: State, form: FormData) => Promise<State>;
  owners: { value: string; label: string }[];
  defaultOwner: string;
  disabled?: boolean;
}) {
  const [state, run, pending] = useActionState(action, null);
  const [localError, setLocalError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLocalError(null);
    const form = new FormData(e.currentTarget);
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return setLocalError("Choose a photo of the card's front first.");
    try {
      const blob = await shrink(file);
      form.set("file", new File([blob], "card.jpg", { type: "image/jpeg" }));
    } catch {
      return setLocalError("Could not read that picture. Try a JPEG or PNG.");
    }
    startTransition(() => run(form));
  }

  const error = localError ?? (state && !state.ok ? state.error : null);
  return (
    <form ref={formRef} onSubmit={onSubmit} className="grid gap-3 rounded-xl border p-4 text-sm sm:grid-cols-2">
      <div className="space-y-1 sm:col-span-2">
        <h2 className="text-lg font-semibold">Add a card you just opened</h2>
        <p className="text-xs text-muted-foreground">
          Take a photo of the front with the card number covered. Claude reads the bank and card name from it, adds the card
          here and to Rewards, and shows its current benefits. When bank sync later finds the card, it joins this one by its
          last 4 digits. The photo is sent to the AI only to read the card&apos;s name; the last 4 digits never are.
        </p>
      </div>
      <label className="space-y-1">
        <span className="text-xs text-muted-foreground">Photo of the front</span>
        <input name="file" type="file" accept="image/jpeg,image/png,image/webp,image/heic" className="block w-full text-xs" disabled={disabled || pending} />
      </label>
      <label className="space-y-1">
        <span className="text-xs text-muted-foreground">Owner</span>
        <select name="owner" defaultValue={defaultOwner} className={input} disabled={disabled || pending}>
          {owners.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <label className="space-y-1">
        <span className="text-xs text-muted-foreground">Nickname (optional)</span>
        <input name="nickname" maxLength={80} placeholder="e.g. Travel card" className={input} disabled={disabled || pending} />
      </label>
      <label className="space-y-1">
        <span className="text-xs text-muted-foreground">Last 4 digits (optional)</span>
        <input name="last4" inputMode="numeric" pattern="\d{4}" maxLength={4} placeholder="1234" className={input} disabled={disabled || pending} />
      </label>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button className="rounded border px-3 py-1" disabled={disabled || pending}>{pending ? "Reading the card…" : "Add card"}</button>
        {error ? <span className="text-destructive">{error}</span> : null}
        {state?.ok ? (
          <span className="text-success">
            Added {state.product}
            {state.confidence !== "high" ? " (check the name is right)" : ""}.
            {state.hasTerms ? " Its benefits are below." : " Looking up its benefits now; they appear here within a few minutes."}
          </span>
        ) : null}
      </div>
    </form>
  );
}
