import type { GfStatus } from "./schema";

/** A venue from any gluten-free source, before it is saved. */
export type GfCandidate = {
  name: string;
  source: "openstreetmap" | "find_me_gluten_free";
  sourceRef: string;
  cuisine?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  phone?: string | null;
  website?: string | null;
  gfStatus: GfStatus;
  celiacFriendly?: boolean | null;
  notes?: string | null;
};

/**
 * Find Me Gluten Free publishes no API or export, and scraping would breach
 * its terms, so places are copied out of the app and pasted here. One per line:
 *
 *   Bakery Name
 *   Bakery Name | 12 Main St, Rome
 *   Bakery Name | 12 Main St, Rome | dedicated | great pizza
 *
 * Separators may be `|`, a tab, or an em/en dash. `#` starts a comment.
 * Unparseable lines are reported, not silently dropped.
 */
export function parsePastedPlaces(text: string): { places: GfCandidate[]; skipped: string[] } {
  const places: GfCandidate[] = [];
  const skipped: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s*(?:\||\t|—|–)\s*/).map((p) => p.trim()).filter(Boolean);
    const name = parts[0];
    if (!name || name.length < 2) {
      skipped.push(raw);
      continue;
    }
    const address = parts[1] ?? null;
    const word = parts[2]?.toLowerCase() ?? "";
    places.push({
      name,
      source: "find_me_gluten_free",
      sourceRef: `${name.toLowerCase()}|${(address ?? "").toLowerCase()}`,
      address,
      gfStatus: word.includes("dedicated")
        ? "dedicated_gf"
        : word.includes("menu")
          ? "gf_menu"
          : word.includes("avoid")
            ? "avoid"
            : word.includes("accommodat")
              ? "accommodating"
              : "unknown",
      celiacFriendly: word.includes("dedicated") ? true : null,
      notes: parts.slice(3).join(" - ") || null,
    });
  }
  return { places, skipped };
}
