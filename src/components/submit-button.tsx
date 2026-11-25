"use client";

import { useFormStatus } from "react-dom";

/** A submit button that says it's working while its form's server action runs. */
export function SubmitButton({ children, pending, className }: { children: React.ReactNode; pending?: string; className?: string }) {
  const { pending: busy } = useFormStatus();
  return (
    <button type="submit" disabled={busy} aria-busy={busy} className={className}>
      {busy ? (pending ?? "Working…") : children}
    </button>
  );
}
