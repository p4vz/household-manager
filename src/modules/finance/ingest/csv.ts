import { createHash } from "node:crypto";
import Papa from "papaparse";
import { normalizeMerchant, looksLikeTransfer } from "./merchant";

/**
 * Quicken Simplifi transaction export parser. Header names are matched
 * loosely so small differences between export versions do not break it.
 */
export type CsvRow = {
  account: string;
  date: string; // YYYY-MM-DD
  amount: number;
  description: string;
  merchant: string;
  category: string | null;
  subcategory: string | null;
  notes: string | null;
  isTransfer: boolean;
  pending: boolean;
};

export type ParsedCsv = { rows: CsvRow[]; skipped: { line: number; reason: string }[] };

const HEADERS = {
  account: ["account", "account name"],
  date: ["postedon", "posted on", "date", "transaction date"],
  payee: ["payee", "merchant", "description"],
  amount: ["amount"],
  category: ["category"],
  notes: ["notes", "memo"],
  state: ["state", "status"],
} as const;

function findColumn(fields: string[], names: readonly string[]): string | undefined {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[_-]/g, " ");
  return fields.find((f) => names.includes(norm(f) as never) || names.includes(norm(f).replace(/\s/g, "") as never));
}

export function parseAmount(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || s.startsWith("-");
  const n = Number(s.replace(/[()$,\s+-]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round((negative ? -n : n) * 100) / 100;
}

export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return iso(y, +m[1], +m[2]);
  }
  return null;
}

function iso(y: number, mo: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

export function splitCategory(raw: string): { category: string | null; subcategory: string | null } {
  const s = raw.trim();
  if (!s || /^uncategori[sz]ed$/i.test(s)) return { category: null, subcategory: null };
  const [parent, ...rest] = s.split(":").map((p) => p.trim());
  return { category: parent, subcategory: rest.length ? rest.join(": ") : null };
}

export function parseSimplifiCsv(text: string): ParsedCsv {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: "greedy",
  });
  const fields = parsed.meta.fields ?? [];
  const col = {
    account: findColumn(fields, HEADERS.account),
    date: findColumn(fields, HEADERS.date),
    payee: findColumn(fields, HEADERS.payee),
    amount: findColumn(fields, HEADERS.amount),
    category: findColumn(fields, HEADERS.category),
    notes: findColumn(fields, HEADERS.notes),
    state: findColumn(fields, HEADERS.state),
  };
  const missing = (["date", "payee", "amount"] as const).filter((k) => !col[k]);
  if (missing.length) {
    throw new Error(`This CSV is missing required columns: ${missing.join(", ")}. Found: ${fields.join(", ")}`);
  }

  const rows: CsvRow[] = [];
  const skipped: ParsedCsv["skipped"] = [];
  parsed.data.forEach((r, i) => {
    const line = i + 2;
    const date = parseDate(r[col.date!] ?? "");
    const amount = parseAmount(r[col.amount!] ?? "");
    const description = (r[col.payee!] ?? "").trim();
    if (!date) return skipped.push({ line, reason: "unreadable date" });
    if (amount === null) return skipped.push({ line, reason: "unreadable amount" });
    if (!description) return skipped.push({ line, reason: "no payee" });
    const { category, subcategory } = splitCategory(col.category ? (r[col.category] ?? "") : "");
    const state = col.state ? (r[col.state] ?? "").toLowerCase() : "";
    rows.push({
      account: (col.account ? r[col.account] : "")?.trim() || "Imported account",
      date,
      amount,
      description,
      merchant: normalizeMerchant(description),
      category,
      subcategory,
      notes: col.notes ? (r[col.notes] ?? "").trim() || null : null,
      isTransfer: looksLikeTransfer(description, category),
      pending: state === "pending",
    });
  });
  return { rows, skipped };
}

/**
 * Stable id for a CSV row: same file (or an overlapping export) imported
 * twice produces the same ids, so re-imports never duplicate. Identical
 * rows on the same day are told apart by their occurrence number.
 */
export function assignExternalIds<T extends Pick<CsvRow, "date" | "amount" | "description">>(
  rows: T[],
): (T & { externalId: string })[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = `${r.date}|${r.amount.toFixed(2)}|${r.description.toLowerCase()}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...r, externalId: createHash("sha256").update(`${base}|${n}`).digest("hex").slice(0, 32) };
  });
}

export type CsvAccountSummary = { name: string; rows: number; firstDate: string; lastDate: string };

export function summarizeByAccount(rows: CsvRow[]): CsvAccountSummary[] {
  const map = new Map<string, CsvAccountSummary>();
  for (const r of rows) {
    const s = map.get(r.account) ?? { name: r.account, rows: 0, firstDate: r.date, lastDate: r.date };
    s.rows++;
    if (r.date < s.firstDate) s.firstDate = r.date;
    if (r.date > s.lastDate) s.lastDate = r.date;
    map.set(r.account, s);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}
