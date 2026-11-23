"use client";

import { useActionState } from "react";
import { pairKioskAction, type PairState } from "./actions";

export function PairForm() {
  const [state, action, pending] = useActionState<PairState, FormData>(pairKioskAction, { error: null });
  return (
    <form action={action} className="space-y-4">
      <input
        name="code"
        required
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        placeholder="ABCD-EFGH"
        className="h-16 w-full rounded-xl border bg-transparent px-4 text-center font-mono text-3xl tracking-widest uppercase"
      />
      <input
        name="name"
        placeholder="Screen name (Kitchen)"
        maxLength={60}
        className="h-12 w-full rounded-xl border bg-transparent px-4"
      />
      {state.error ? <p className="text-red-600">{state.error}</p> : null}
      <button type="submit" disabled={pending} className="h-14 w-full rounded-xl bg-foreground text-lg text-background disabled:opacity-50">
        {pending ? "Pairing…" : "Pair"}
      </button>
    </form>
  );
}
