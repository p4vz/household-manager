"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";

type State = null | { ok: true } | { ok: false; error: string };

export function AdvisorButton({ action }: { action: () => Promise<State> }) {
  const [state, run, pending] = useActionState(action, null);
  return (
    <form action={run} className="flex items-center gap-3">
      <Button size="sm" disabled={pending}>{pending ? "Reviewing…" : "Run AI review now"}</Button>
      {state && !state.ok ? <span className="text-sm text-destructive">{state.error}</span> : null}
    </form>
  );
}
