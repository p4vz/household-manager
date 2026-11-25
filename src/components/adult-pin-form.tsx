"use client";

import { useState } from "react";

/** Settings: set or change the kitchen screen's adult PIN (never from the screen itself). */
export function AdultPinForm({ isSet, save }: { isSet: boolean; save: (input: { pin: string; confirm: string }) => Promise<{ error: string | null }> }) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = "min-h-12 w-40 rounded-lg border px-3 text-lg tracking-widest";
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const f = new FormData(form);
        setBusy(true);
        setError(null);
        setDone(false);
        try {
          const res = await save({ pin: String(f.get("pin") ?? ""), confirm: String(f.get("confirm") ?? "") });
          if (res.error) setError(res.error);
          else {
            setDone(true);
            form.reset();
          }
        } catch {
          setError("That didn't save. Try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-sm">
          {isSet ? "New adult PIN" : "Adult PIN"}
          <input name="pin" type="password" inputMode="numeric" autoComplete="new-password" pattern="\d{4,8}" maxLength={8} required className={input} />
        </label>
        <label className="grid gap-1 text-sm">
          Again
          <input name="confirm" type="password" inputMode="numeric" autoComplete="new-password" pattern="\d{4,8}" maxLength={8} required className={input} />
        </label>
        <button type="submit" disabled={busy} className="min-h-12 rounded-lg bg-foreground px-4 text-background disabled:opacity-50">
          {busy ? "Saving…" : isSet ? "Change PIN" : "Set PIN"}
        </button>
      </div>
      {error ? <p className="text-sm font-medium text-red-600">{error}</p> : null}
      {done ? <p className="text-sm text-emerald-700">Saved. Any screen in adult mode was locked.</p> : null}
    </form>
  );
}
