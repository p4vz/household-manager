"use client";

import { useState } from "react";

/**
 * Decrypts a vault document through a server action and opens it from a
 * blob URL, so no download route is needed (the app exposes no HTTP API).
 */
export function OpenDocumentButton({
  id,
  action,
}: {
  id: string;
  action: (input: { id: string }) => Promise<{ filename: string; mimeType: string; base64: string }>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setError(null);
    try {
      const doc = await action({ id });
      const bytes = Uint8Array.from(atob(doc.base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: doc.mimeType }));
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setError("Could not open it");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" onClick={open} disabled={busy} className="text-sm underline disabled:opacity-50">
        {busy ? "Decrypting…" : "Download"}
      </button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
}
