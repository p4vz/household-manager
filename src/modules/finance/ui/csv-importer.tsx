"use client";

import { useState, useTransition } from "react";

type SkipSummary = { reason: string; count: number; lines: number[]; examples: string[] };
type Preview = {
  accounts: { name: string; rows: number; firstDate: string; lastDate: string; suggestedAccountId: string | null }[];
  skippedLines: number;
  skipReasons: SkipSummary[];
  columns: Record<string, string | undefined>;
  readableRows: number;
  existingAccounts: { id: string; name: string; simplefinStartDate: string | null }[];
};
type PreviewResult = { ok: true; preview: Preview } | { ok: false; error: string };
type ImportResult = {
  inserted: number;
  alreadyPresent: number;
  coveredBySimplefin: number;
  skippedLines: number;
  skipReasons: SkipSummary[];
};

const FIELD_LABELS: Record<string, string> = {
  date: "Date",
  payee: "Payee",
  amount: "Amount",
  debit: "Debit",
  credit: "Credit",
  account: "Account",
  category: "Category",
};

/** Lists why lines were skipped, with line numbers and example values, so a bad export can be fixed. */
function SkipReasons({ total, reasons, readable }: { total: number; reasons: SkipSummary[]; readable?: number }) {
  if (!total) return null;
  const most = readable !== undefined && total > readable;
  return (
    <div className={`space-y-1 rounded-lg p-3 text-sm ${most ? "bg-amber-500/10" : "bg-foreground/5"}`}>
      <p className="font-medium">
        {total} {total === 1 ? "line" : "lines"} can&apos;t be read and will be skipped:
      </p>
      <ul className="list-disc space-y-1 pl-5">
        {reasons.map((r) => (
          <li key={r.reason}>
            <span className="font-medium">{r.reason}</span>: {r.count} {r.count === 1 ? "line" : "lines"} (line{" "}
            {r.lines.join(", ")}
            {r.count > r.lines.length ? ", …" : ""})
            {r.examples.length ? (
              <span className="opacity-70">
                {" "}
                for example {r.examples.map((e) => `“${e}”`).join(", ")}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {most ? (
        <p className="opacity-80">
          Most of the file can&apos;t be read, so you may want to check these examples before importing.
        </p>
      ) : null}
    </div>
  );
}

export function CsvImporter(props: {
  preview: (input: { text: string }) => Promise<PreviewResult>;
  commit: (input: { text: string; mapping: Record<string, string> }) => Promise<ImportResult>;
}) {
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pending, start] = useTransition();

  function load(file: File) {
    setError(null);
    setResult(null);
    setFileName(file.name);
    file.text().then((t) => {
      setText(t);
      start(async () => {
        const res = await props.preview({ text: t });
        if (!res.ok) {
          setPreview(null);
          setError(res.error);
          return;
        }
        setPreview(res.preview);
        setMapping(
          Object.fromEntries(res.preview.accounts.map((a) => [a.name, a.suggestedAccountId ?? "new"])),
        );
      });
    });
  }

  return (
    <div className="space-y-6">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f) load(f);
        }}
        className={`flex h-40 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed ${
          dragging ? "border-foreground bg-foreground/5" : "border-foreground/30"
        }`}
      >
        <span>{fileName || "Drop your Simplifi CSV export here, or click to choose"}</span>
        <input
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && load(e.target.files[0])}
        />
      </label>

      {pending ? <p className="opacity-70">Working…</p> : null}
      {error ? <p className="rounded bg-red-500/10 p-3 text-red-600">{error}</p> : null}

      {preview && !result ? (
        <div className="space-y-4">
          <table className="w-full text-sm">
            <thead className="text-left opacity-70">
              <tr>
                <th className="py-1">Account in CSV</th>
                <th>Rows</th>
                <th>Dates</th>
                <th>Import into</th>
              </tr>
            </thead>
            <tbody>
              {preview.accounts.map((a) => {
                const target = preview.existingAccounts.find((x) => x.id === mapping[a.name]);
                return (
                  <tr key={a.name} className="border-t">
                    <td className="py-2">{a.name}</td>
                    <td>{a.rows}</td>
                    <td>
                      {a.firstDate} to {a.lastDate}
                    </td>
                    <td>
                      <select
                        value={mapping[a.name]}
                        onChange={(e) => setMapping({ ...mapping, [a.name]: e.target.value })}
                        className="rounded border bg-transparent px-2 py-1"
                      >
                        <option value="new">New account</option>
                        <option value="skip">Skip</option>
                        {preview.existingAccounts.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                      </select>
                      {target?.simplefinStartDate ? (
                        <div className="text-xs opacity-60">
                          Only rows before {target.simplefinStartDate} (bank sync covers the rest)
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-xs opacity-60">
            {preview.readableRows} transactions read. Columns used:{" "}
            {Object.entries(FIELD_LABELS)
              .filter(([k]) => preview.columns[k])
              .map(([k, label]) => `${label} from “${preview.columns[k]}”`)
              .join(", ")}
            .
          </p>
          <SkipReasons total={preview.skippedLines} reasons={preview.skipReasons} readable={preview.readableRows} />
          <button
            disabled={pending || !text}
            onClick={() =>
              start(async () => {
                try {
                  setResult(await props.commit({ text: text!, mapping }));
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Import failed");
                }
              })
            }
            className="rounded-lg bg-foreground px-4 py-2 text-background disabled:opacity-50"
          >
            Import
          </button>
        </div>
      ) : null}

      {result ? (
        <div className="rounded-xl border p-4 text-sm">
          <p className="font-medium">Imported {result.inserted} transactions.</p>
          <p className="opacity-70">
            {result.alreadyPresent} were already here, {result.coveredBySimplefin} are covered by bank sync,{" "}
            {result.skippedLines} lines were unreadable.
          </p>
          <div className="mt-2">
            <SkipReasons total={result.skippedLines} reasons={result.skipReasons} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
