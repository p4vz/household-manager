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

// ---------- vehicles (NHTSA) ----------

const NHTSA = "https://api.nhtsa.gov/recalls/recallsByVehicle";

type NhtsaRecall = { NHTSACampaignNumber?: string; Component?: string; Summary?: string; Consequence?: string; Remedy?: string };

/** NHTSA campaign numbers start with the year: "23V123000" is from 2023. */
function campaignYear(id: string | undefined): string | null {
  const m = id?.match(/^(\d{2})[A-Z]/);
  return m ? `20${m[1]}` : null;
}

export function toVehicleHits(raw: unknown): RecallHit[] {
  const results = (raw as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  return (results as NhtsaRecall[])
    .map((r) => {
      const id = r.NHTSACampaignNumber && /^[0-9A-Z]{6,12}$/.test(r.NHTSACampaignNumber) ? r.NHTSACampaignNumber : null;
      return {
        title: clean(r.Component, 200) ?? "Recall",
        date: campaignYear(id ?? undefined),
        url: id ? `https://www.nhtsa.gov/recalls?nhtsaId=${id}` : null,
        hazard: clean(r.Consequence ?? r.Summary),
        remedy: clean(r.Remedy),
      };
    })
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .slice(0, MAX_HITS);
}

/**
 * Vehicle safety recalls from NHTSA's public API (keyless), by make, model
 * and model year only. Never a VIN or plate: the app doesn't store either.
 */
export async function searchVehicleRecalls(v: { make: string; model: string; year: number }): Promise<RecallHit[]> {
  const make = recallQuery(v.make);
  const model = recallQuery(v.model);
  if (!make || !model || !(v.year >= 1950 && v.year <= 2100)) return [];
  const url = new URL(NHTSA);
  url.searchParams.set("make", make);
  url.searchParams.set("model", model);
  url.searchParams.set("modelYear", String(v.year));
  const res = await outboundFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  // NHTSA answers 400 for a make/model it doesn't know.
  if (res.status === 400) return [];
  if (!res.ok) throw new Error(`Recall lookup failed (${res.status})`);
  return toVehicleHits(await res.json());
}
