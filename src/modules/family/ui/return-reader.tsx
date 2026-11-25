"use client";

import { useRef, useState } from "react";
import { ErrorNote, field, tap } from "./kit";

export type ExtractResult = {
  fields: { itemName?: string; store?: string; returnDeadline?: string; notes?: string } | null;
  error: string | null;
};

/**
 * "Fill from a screenshot or text". A screenshot is read on this device with
 * Tesseract OCR (assets in /ocr, same origin): the image is never uploaded or
 * kept. The recognised text appears in the box so the member can check it and
 * delete anything before "Fill in" sends it, scrubbed, to the household's AI.
 */
export function ReturnReader({ extract, onFields }: { extract: (input: { text: string }) => Promise<ExtractResult>; onFields: (f: NonNullable<ExtractResult["fields"]>) => void }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function readImage(file: File) {
    setError(null);
    setBusy(true);
    setStatus("Reading the screenshot on this phone…");
    try {
      const { createWorker, OEM } = await import("tesseract.js");
      const worker = await createWorker("eng", OEM.LSTM_ONLY, {
        workerPath: "/ocr/worker.min.js",
        corePath: "/ocr/core",
        langPath: "/ocr/lang",
        workerBlobURL: false,
      });
      try {
        const { data } = await worker.recognize(file);
        const read = data.text.replace(/\n{3,}/g, "\n\n").trim();
        setText((t) => (t ? `${t}\n${read}` : read).slice(0, 6000));
        setStatus(read ? "Check the text, delete anything private, then tap Fill in." : null);
        if (!read) setError("No text found in that picture.");
      } finally {
        await worker.terminate();
      }
    } catch {
      setStatus(null);
      setError("Could not read that picture. Paste the text instead.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function fill() {
    setError(null);
    setBusy(true);
    setStatus("Reading…");
    try {
      const res = await extract({ text });
      if (res.fields) {
        onFields(res.fields);
        setStatus("Filled in below. Check it, then add.");
      } else {
        setStatus(null);
        setError(res.error ?? "Could not find a return in that text.");
      }
    } catch {
      setStatus(null);
      setError("That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 grid gap-2 rounded-xl border border-dashed border-slate-400 p-3">
      <div className="text-sm font-semibold">Fill from a screenshot or text</div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, 6000))}
        rows={4}
        placeholder="Paste an order or return email, or type a note like: Old Navy jeans, return by Dec 20"
        className={`${field} py-2`}
      />
      <div className="flex flex-wrap gap-2">
        <label className={`${tap} flex cursor-pointer items-center border ${busy ? "opacity-50" : ""}`}>
          📷 Screenshot
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (f) void readImage(f);
            }}
          />
        </label>
        <button type="button" disabled={busy || text.trim().length < 5} onClick={fill} className={`${tap} bg-slate-800 text-white disabled:opacity-50 dark:bg-slate-200 dark:text-slate-900`}>
          ✨ Fill in
        </button>
      </div>
      {status ? <p className="text-sm opacity-80">{status}</p> : null}
      <ErrorNote error={error} />
      <p className="text-xs opacity-60">Screenshots are read on this phone and not uploaded. Card, order and tracking numbers are removed before the text goes to the AI.</p>
    </div>
  );
}
