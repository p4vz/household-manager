/**
 * Pure shopping helpers (no database), shared by the API, the client panel
 * and the tests.
 */

/** Stores offered for a new section before the household has used any. */
export const DEFAULT_STORES = ["Costco", "Sam's Club", "Russian store", "Trader Joe's", "Giant", "Acme", "Target"] as const;

/** How long a ticked item stays on its list (struck through) before the hourly tidy-up removes it. */
export const BOUGHT_ITEM_TTL_MS = 12 * 3_600_000;

/**
 * The key two items share when they are "the same thing" on different lists:
 * case, spacing and punctuation do not matter ("Eggs" = " eggs " = "EGGS.").
 */
export function itemKey(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Moves `id` to position `index` of `ids` (removing it first if present). */
export function placeAt<T>(ids: readonly T[], id: T, index: number): T[] {
  const rest = ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(rest.length, Math.floor(index)));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** Swaps `id` with its neighbour above (-1) or below (+1); unchanged at the ends. */
export function nudge<T>(ids: readonly T[], id: T, delta: -1 | 1): T[] {
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return [...ids];
  const out = [...ids];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** True while a list is deferred: it comes back on `deferredUntil` (household date). */
export function isDeferred(deferredUntil: string | null, today: string): boolean {
  return deferredUntil !== null && deferredUntil > today;
}
