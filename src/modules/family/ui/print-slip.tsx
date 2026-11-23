"use client";

import { useState } from "react";
import { layout, type ReceiptLine } from "@/lib/thermal/receipt";
import { isBluetoothPrintingSupported, pairPrinter, printReceipt } from "@/lib/thermal/thermalPrinter";

/**
 * One-tap print to the 58 mm Bluetooth printer. Where Web Bluetooth is
 * missing (iPhone, Firefox) or the print fails, shows a 58 mm preview that
 * can go through the browser's own print dialog instead.
 */
export function PrintSlipButton({
  label,
  lines,
  className,
}: {
  label: string;
  /** Built on tap so the slip reflects what is on screen right now. */
  lines: () => ReceiptLine[];
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ lines: ReceiptLine[]; message: string | null } | null>(null);

  async function go() {
    const slip = lines();
    if (!isBluetoothPrintingSupported()) {
      setPreview({ lines: slip, message: "Bluetooth printing works in Chrome on Android or a computer. You can print from the browser instead." });
      return;
    }
    setBusy(true);
    try {
      await printReceipt(slip);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const cancelled = /cancel|chosen|NotFoundError/i.test(msg);
      setPreview({ lines: slip, message: cancelled ? "No printer chosen." : `Printer problem: ${msg}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className={className ?? "min-h-12 rounded-lg border px-4 font-medium active:scale-95 disabled:opacity-50"}
      >
        🖨️ {busy ? "Printing…" : label}
      </button>
      {preview ? <ReceiptPreview {...preview} onClose={() => setPreview(null)} onRetry={() => { setPreview(null); void go(); }} /> : null}
    </>
  );
}

function ReceiptPreview({
  lines,
  message,
  onClose,
  onRetry,
}: {
  lines: ReceiptLine[];
  message: string | null;
  onClose: () => void;
  onRetry: () => void;
}) {
  const supported = isBluetoothPrintingSupported();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 print:static print:bg-transparent print:p-0">
      <div className="flex max-h-full w-full max-w-sm flex-col gap-3 rounded-xl bg-background p-4 text-foreground shadow-xl print:hidden">
        {message ? <p className="text-sm">{message}</p> : null}
        <div className="overflow-auto rounded border bg-white p-3 text-black">
          <ReceiptText lines={lines} />
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => window.print()} className="min-h-12 flex-1 rounded-lg bg-foreground px-4 text-background">
            Print from browser
          </button>
          {supported ? (
            <>
              <button type="button" onClick={onRetry} className="min-h-12 rounded-lg border px-4">Try printer again</button>
              <button
                type="button"
                onClick={() => void pairPrinter({ showAll: true }).then(onRetry, () => undefined)}
                className="min-h-12 rounded-lg border px-4"
              >
                Pick another printer
              </button>
            </>
          ) : null}
          <button type="button" onClick={onClose} className="min-h-12 rounded-lg border px-4">Close</button>
        </div>
      </div>
      <div className="receipt-print hidden print:block">
        <ReceiptText lines={lines} />
      </div>
    </div>
  );
}

export function ReceiptText({ lines }: { lines: ReceiptLine[] }) {
  return (
    <pre className="font-mono text-[12px] leading-tight whitespace-pre">
      {layout(lines).map((l, i) => (
        <div key={i} className={`${l.bold ? "font-bold" : ""} ${l.large ? "text-[24px] leading-none tracking-tight" : ""}`}>
          {l.text || " "}
        </div>
      ))}
    </pre>
  );
}
