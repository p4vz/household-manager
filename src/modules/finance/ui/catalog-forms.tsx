"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";

type State = null | { ok: true; message: string } | { ok: false; error: string };
type Action = (prev: State, form: FormData) => Promise<State>;

function Status({ state }: { state: State }) {
  if (!state) return null;
  return state.ok ? (
    <span className="text-xs text-muted-foreground">{state.message}</span>
  ) : (
    <span className="text-xs text-destructive">{state.error}</span>
  );
}

/** "Check now": looks the card up against its issuer (takes 20 to 60 seconds). */
export function CatalogCheckButton({ action, productId }: { action: Action; productId: string }) {
  const [state, run, pending] = useActionState(action, null);
  return (
    <form action={run} className="flex items-center gap-2">
      <input type="hidden" name="productId" value={productId} />
      <Button size="sm" variant="outline" disabled={pending}>{pending ? "Checking…" : "Check now"}</Button>
      <Status state={state} />
    </form>
  );
}

/** Raw JSON editor for one card's terms, validated on the server. */
export function CatalogTermsEditor({ action, productId, terms }: { action: Action; productId: string; terms: string }) {
  const [state, run, pending] = useActionState(action, null);
  return (
    <form action={run} className="space-y-2">
      <input type="hidden" name="productId" value={productId} />
      <textarea name="terms" defaultValue={terms} rows={14} spellCheck={false} className="w-full rounded-md border bg-background p-2 font-mono text-xs" />
      <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" disabled={pending}>{pending ? "Saving…" : "Save my edits"}</Button>
        <Status state={state} />
      </div>
    </form>
  );
}
