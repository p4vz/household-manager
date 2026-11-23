"use client";

import { useState, useTransition } from "react";

/** "Make pairing code" button; shows the one-time code and when it expires. */
export function KioskPairingCode({ make }: { make: () => Promise<{ code: string; expiresAt: string }> }) {
  const [result, setResult] = useState<{ code: string; expiresAt: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => setResult(await make()))}
        className="min-h-12 rounded-lg bg-foreground px-4 text-background disabled:opacity-50"
      >
        {pending ? "Making code…" : "Make pairing code"}
      </button>
      {result ? (
        <div className="rounded-lg bg-foreground/5 p-3">
          <div className="font-mono text-3xl tracking-widest">{result.code}</div>
          <div className="text-sm opacity-70">
            Works once, until {new Date(result.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.
          </div>
        </div>
      ) : null}
    </div>
  );
}
