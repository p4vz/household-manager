import "server-only";
import { outboundFetch } from "@/core/net/outbound";
import type { GfCandidate } from "../dining-import";

/**
 * OpenStreetMap via Overpass. The `diet:gluten_free` tag (`only` / `yes` /
 * `limited`) is actively maintained by coeliac mappers and is the one open,
 * queryable gluten-free dataset. Only coordinates are sent.
 */
const OVERPASS = "https://overpass-api.de/api/interpreter";

type OverpassElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

function address(tags: Record<string, string>): string | null {
  const parts = [[tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "), tags["addr:city"], tags["addr:postcode"]].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export function toCandidate(el: OverpassElement): GfCandidate | null {
  const tags = el.tags ?? {};
  if (!tags.name) return null;
  const gf = tags["diet:gluten_free"];
  return {
    name: tags.name,
    source: "openstreetmap",
    sourceRef: `${el.type}/${el.id}`,
    cuisine: tags.cuisine?.replace(/;/g, ", ") ?? null,
    address: address(tags),
    latitude: el.lat ?? el.center?.lat ?? null,
    longitude: el.lon ?? el.center?.lon ?? null,
    phone: tags.phone ?? tags["contact:phone"] ?? null,
    website: tags.website ?? tags["contact:website"] ?? null,
    // "only" = the whole kitchen is gluten-free, the gold standard for coeliac.
    gfStatus: gf === "only" ? "dedicated_gf" : gf === "yes" ? "gf_menu" : "accommodating",
    celiacFriendly: gf === "only" ? true : null,
    notes:
      gf === "only"
        ? "OpenStreetMap lists this as an entirely gluten-free kitchen."
        : "Tagged gluten-free in OpenStreetMap. Call ahead to confirm.",
  };
}

export async function searchGlutenFreeNearby(input: { latitude: number; longitude: number; radiusMeters?: number }): Promise<GfCandidate[]> {
  const radius = Math.min(20_000, Math.max(500, input.radiusMeters ?? 5000));
  const filter = `["diet:gluten_free"~"^(yes|only|limited)$"]`;
  const area = `(around:${radius},${input.latitude},${input.longitude})`;
  const query = `[out:json][timeout:25];\n(\n  node${filter}${area};\n  way${filter}${area};\n);\nout center tags 80;`;
  try {
    const res = await outboundFetch(OVERPASS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "HouseholdManager/0.1 (private family app)" },
      body: new URLSearchParams({ data: query }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { elements?: OverpassElement[] };
    const seen = new Set<string>();
    return (data.elements ?? [])
      .map(toCandidate)
      .filter((c): c is GfCandidate => c !== null)
      // Overpass often returns one venue as both a node and a way.
      .filter((c) => (seen.has(c.name.toLowerCase()) ? false : (seen.add(c.name.toLowerCase()), true)))
      .sort((a, b) => Number(b.gfStatus === "dedicated_gf") - Number(a.gfStatus === "dedicated_gf"));
  } catch {
    return [];
  }
}
