import { createHash } from "node:crypto";
import Papa from "papaparse";
import { normalizeMerchant, looksLikeTransfer } from "./merchant";

/**
 * Quicken Simplifi transaction export parser. Header names are matched
 * loosely (case, spaces and punctuation ignored) and dates and amounts accept
 * the common US spreadsheet formats, so small differences between export
 * versions, or a file re-saved from Excel or Numbers, do not break it.
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

export type SkippedLine = { line: number; reason: string; value?: string };

/** Which CSV header each field was read from, so the importer can show it. */
export type CsvColumns = Partial<Record<"account" | "date" | "payee" | "amount" | "debit" | "credit" | "category" | "notes" | "state", string>>;

export type ParsedCsv = { rows: CsvRow[]; skipped: SkippedLine[]; columns: CsvColumns; headerLine: number };

/**
 * Accepted header names, normalised to lowercase letters and digits only, in
 * order of preference. Simplifi's own export uses account, state, postedOn,
 * payee, usage, category, tags, notes and amount; the rest cover other
 * versions and exports re-saved from a spreadsheet.
 */
const HEADERS = {
  account: ["account", "accountname", "accountnickname"],
  date: ["postedon", "date", "transactiondate", "posteddate", "posted", "datepostedon"],
  payee: ["payee", "merchant", "description", "payeename", "name", "originalpayee", "originaldescription"],
  amount: ["amount", "amountusd", "transactionamount"],
  debit: ["debit", "outflow", "withdrawal", "withdrawals", "spent", "expense"],
  credit: ["credit", "inflow", "deposit", "deposits", "received", "income"],
  category: ["category", "categoryname"],
  notes: ["notes", "memo", "note"],
  state: ["state", "status"],
} as const;

const normHeader = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function findColumn(fields: string[], names: readonly string[]): number {
  const normed = fields.map(normHeader);
  for (const name of names) {
    const i = normed.indexOf(name);
    if (i >= 0) return i;
  }
  return -1;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function parseAmount(raw: string): number | null {
  let s = raw
    .replace(/[\u2212\u2012\u2013\u2014]/g, "-") // unicode minus and dashes
    .replace(/[\s\u00a0'"]/g, "")
    .replace(/^(usd|us\$|cad|eur|gbp)|(usd|cad|eur|gbp)$/i, "")
    .replace(/[$€£]/g, "");
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/dr$/i.test(s)) {
    negative = true;
    s = s.slice(0, -2);
  } else if (/cr$/i.test(s)) {
    s = s.slice(0, -2);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  // Leftover sign or currency after the minus, e.g. "-$" already stripped; "$-12" handled here.
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }
  // Decimal comma ("1.234,56" or "12,50"): a comma followed by exactly two digits at the end
  // with no later dot. "1,234" stays one thousand two hundred thirty-four.
  if (/^[\d.]*,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n * 100) / 100;
  return negative ? -rounded : rounded;
}

export function parseDate(raw: string): string | null {
  // Drop a time part: "2024-03-02T00:00:00Z", "3/2/2024 12:00:00 AM", "2024-03-02 00:00".
  const s = raw
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/[T\s]+\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\s*([ap]\.?m\.?)?\s*(z|[+-]\d{2}:?\d{2}|utc|gmt)?$/i, "")
    .trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    // US month/day first; fall back to day/month when the first number can't be a month.
    return iso(y, +m[1], +m[2]) ?? (+m[1] > 12 ? iso(y, +m[2], +m[1]) : null);
  }
  // "Mar 2, 2024", "March 2 2024", "2 Mar 2024", "02-Mar-2024"
  m = /^([a-z]{3,})\.?[\s-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s-]+(\d{4}|\d{2})$/i.exec(s);
  if (m) return monthName(m[1], +m[2], m[3]);
  m = /^(\d{1,2})[\s-]+([a-z]{3,})\.?,?[\s-]+(\d{4}|\d{2})$/i.exec(s);
  if (m) return monthName(m[2], +m[1], m[3]);
  return null;
}

function monthName(name: string, day: number, year: string): string | null {
  const mo = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
  if (mo < 0) return null;
  return iso(year.length === 2 ? 2000 + +year : +year, mo + 1, day);
}

function iso(y: number, mo: number, d: number): string | null {
  if (y < 1900 || y > 2100) return null;
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

type ColumnIndex = Record<keyof typeof HEADERS, number>;

function columnsFor(fields: string[]): ColumnIndex {
  return Object.fromEntries(
    (Object.keys(HEADERS) as (keyof typeof HEADERS)[]).map((k) => [k, findColumn(fields, HEADERS[k])]),
  ) as ColumnIndex;
}

const usable = (c: ColumnIndex) => c.date >= 0 && c.payee >= 0 && (c.amount >= 0 || c.debit >= 0 || c.credit >= 0);

/** Keep skip examples short and never echo more than a field's worth of text. */
const sample = (v: string | undefined) => {
  const t = (v ?? "").trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
};

export function parseSimplifiCsv(text: string): ParsedCsv {
  const parsed = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), { header: false, skipEmptyLines: false });
  const data = parsed.data;

  // The header is usually line 1, but exports re-saved from a spreadsheet or
  // other tools can put a title or date-range line above it.
  let headerIdx = -1;
  let col: ColumnIndex | null = null;
  for (let i = 0; i < Math.min(data.length, 25); i++) {
    const c = columnsFor(data[i] ?? []);
    if (usable(c)) {
      headerIdx = i;
      col = c;
      break;
    }
  }
  if (!col) {
    const first = (data.find((r) => r.some((f) => f.trim())) ?? []).map((f) => f.trim()).filter(Boolean);
    const c = columnsFor(first);
    const missing = [
      c.date < 0 && "date",
      c.payee < 0 && "payee",
      c.amount < 0 && c.debit < 0 && c.credit < 0 && "amount",
    ].filter(Boolean);
    throw new Error(
      `This CSV is missing required columns: ${missing.join(", ")}. Found: ${first.slice(0, 20).join(", ") || "nothing"}`,
    );
  }
  const header = data[headerIdx];
  const columns: CsvColumns = Object.fromEntries(
    Object.entries(col)
      .filter(([, i]) => i >= 0)
      .map(([k, i]) => [k, header[i].trim()]),
  );

  const rows: CsvRow[] = [];
  const skipped: SkippedLine[] = [];
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "") : "");

  for (let i = headerIdx + 1; i < data.length; i++) {
    const r = data[i];
    // Papa reports the record's position, not the physical line; quoted fields can span
    // lines, so this is the record number counting the header as 1.
    const line = i + 1;
    if (!r || r.every((f) => !f.trim())) continue; // blank line
    // A repeated header (several exports pasted together) is not a transaction.
    if (normHeader(cell(r, col.date)) === normHeader(header[col.date])) continue;

    const rawDate = cell(r, col.date);
    const date = parseDate(rawDate);
    const description = cell(r, col.payee).trim();

    let amount: number | null;
    let rawAmount: string;
    if (col.amount >= 0 && cell(r, col.amount).trim()) {
      rawAmount = cell(r, col.amount);
      amount = parseAmount(rawAmount);
    } else if (col.debit >= 0 || col.credit >= 0) {
      const d = cell(r, col.debit).trim();
      const c = cell(r, col.credit).trim();
      rawAmount = [d, c].filter(Boolean).join(" / ");
      const dv = d ? parseAmount(d) : 0;
      const cv = c ? parseAmount(c) : 0;
      amount = dv === null || cv === null || (!d && !c) ? null : Math.round((Math.abs(cv) - Math.abs(dv)) * 100) / 100;
    } else {
      rawAmount = "";
      amount = null;
    }

    if (!date) {
      // Totals or footer lines: no date and nothing that looks like a payee.
      const footer = !rawDate.trim() && /total|balance|summary|count|export/i.test(r.join(" "));
      skipped.push(
        footer
          ? { line, reason: "summary or total line" }
          : rawDate.trim()
            ? { line, reason: "unreadable date", value: sample(rawDate) }
            : { line, reason: "no date" },
      );
      continue;
    }
    if (amount === null) {
      skipped.push(rawAmount.trim() ? { line, reason: "unreadable amount", value: sample(rawAmount) } : { line, reason: "no amount" });
      continue;
    }
    if (!description) {
      skipped.push({ line, reason: "no payee" });
      continue;
    }
    const { category, subcategory } = splitCategory(cell(r, col.category));
    const state = cell(r, col.state).trim().toLowerCase();
    rows.push({
      account: cell(r, col.account).trim() || "Imported account",
      date,
      amount,
      description,
      merchant: normalizeMerchant(description),
      category,
      subcategory,
      notes: cell(r, col.notes).trim() || null,
      isTransfer: looksLikeTransfer(description, category),
      pending: state === "pending",
    });
  }
  return { rows, skipped, columns, headerLine: headerIdx + 1 };
}

export type SkipSummary = { reason: string; count: number; lines: number[]; examples: string[] };

/** Group skipped lines by reason, with a few line numbers and distinct example values. */
export function summarizeSkipped(skipped: SkippedLine[]): SkipSummary[] {
  const map = new Map<string, SkipSummary>();
  for (const s of skipped) {
    const g = map.get(s.reason) ?? { reason: s.reason, count: 0, lines: [], examples: [] };
    g.count++;
    if (g.lines.length < 5) g.lines.push(s.line);
    if (s.value && g.examples.length < 3 && !g.examples.includes(s.value)) g.examples.push(s.value);
    map.set(s.reason, g);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
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
