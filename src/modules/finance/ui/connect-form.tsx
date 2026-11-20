"use client";

import { useActionState } from "react";

type State =
  | null
  | { ok: false; error: string }
  | { ok: true; result: { status: string; inserted?: number; accounts?: number; error?: string; reason?: string } };

export function ConnectForm({ action }: { action: (prev: State, form: FormData) => Promise<State> }) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="space-y-3">
      <textarea
        name="token"
        required
        rows={4}
        autoComplete="off"
        spellCheck={false}
        placeholder="Paste the SimpleFIN setup token"
        className="w-full rounded border bg-transparent p-2 font-mono text-xs"
      />
      <button disabled={pending} className="rounded-lg bg-foreground px-4 py-2 text-background disabled:opacity-50">
        {pending ? "Connecting…" : "Connect"}
      </button>
      {state && !state.ok ? <p className="text-red-600">{state.error}</p> : null}
      {state && state.ok ? (
        <p>
          Connected.{" "}
          {state.result.status === "ok"
            ? `Pulled ${state.result.accounts} accounts and ${state.result.inserted} transactions.`
            : (state.result.error ?? state.result.reason)}
        </p>
      ) : null}
    </form>
  );
}
