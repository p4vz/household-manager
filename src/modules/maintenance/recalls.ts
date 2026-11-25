import "server-only";
import { outboundFetch } from "@/core/net/outbound";
import type { RecallHit } from "./schema";

/**
 * Product recalls from the U.S. Consumer Product Safety Commission's public
 * recall API (saferproducts.gov, keyless). Only a product description such
 * as "GE refrigerator" is sent: never names, addresses, model serials or
 * anything about the household.
 */

const API = "https://www.saferproducts.gov/RestWebServices/Recall";
const MAX_HITS = 10;

type CpscRecall = {
  RecallDate?: string;
  Title?: string;
  URL?: string;
  Hazards?: { Name?: string }[];
  Remedies?: { Name?: string }[];
};

function clean(s: string | undefined | null, max = 300): string | null {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

export function toHits(raw: unknown): RecallHit[] {
  if (!Array.isArray(raw)) return [];
  return (raw as CpscRecall[])
    .map((r) => ({
      title: clean(r.Title, 200) ?? "Recall",
      date: r.RecallDate ? r.RecallDate.slice(0, 10) : null,
      url: r.URL && /^https:\/\/(www\.)?cpsc\.gov\//.test(r.URL) ? r.URL : null,
      hazard: clean(r.Hazards?.map((h) => h.Name).filter(Boolean).join("; ")),
      remedy: clean(r.Remedies?.map((h) => h.Name).filter(Boolean).join("; ")),
    }))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .slice(0, MAX_HITS);
}

async function query(params: Record<string, string>): Promise<RecallHit[]> {
  const url = new URL(API);
  url.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await outboundFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Recall lookup failed (${res.status})`);
  return toHits(await res.json());
}

/** Only letters, digits and a few separators, so nothing but a product phrase leaves. */
export function recallQuery(text: string): string {
  return text
    .replace(/\([^)]*\)/g, " ")
    .replace(/#\S*/g, " ")
    // Words carrying 4+ digits look like model, serial or order numbers.
    .replace(/\S*\d[^\s]*/g, (w) => ((w.match(/\d/g)?.length ?? 0) >= 4 ? " " : w))
    .replace(/[^A-Za-z0-9 .&'-]/g, " ")
    .replace(/\b\d{5,}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/**
 * Recalls matching a product, newest first. Tries the whole phrase as a
 * product name, then brand as manufacturer with the rest as product name.
 */
export async function searchRecalls(product: string): Promise<RecallHit[]> {
  const q = recallQuery(product);
  if (q.length < 3) return [];
  const direct = await query({ ProductName: q });
  if (direct.length) return direct;
  const [brand, ...rest] = q.split(" ");
  if (!rest.length) return [];
  return query({ Manufacturer: brand, ProductName: rest.join(" ") });
}
