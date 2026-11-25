/**
 * Star bank for one kid. Pure, so it is unit tested.
 *
 * Every chore adds its stars to the kid's saved stars. When a parent gives a
 * prize, its stars are spent from the saved ones, so a kid can cash in a
 * small prize now or keep saving for a bigger one. Lifetime stars (used for
 * badges) never go down.
 */
export type StarPrize = { id: string; name: string; emoji: string; stars: number };
export type PrizeState = StarPrize & { ready: boolean; missing: number };
export type StarBank = {
  saved: number;
  lifetime: number;
  prizes: PrizeState[];
  /** The cheapest prize not yet affordable, for "12 more for 🎁". */
  next: PrizeState | null;
  /** The best prize the saved stars cover now. */
  best: PrizeState | null;
};

export function starBank(lifetime: number, spent: number, prizes: readonly StarPrize[]): StarBank {
  const saved = Math.max(0, lifetime - spent);
  const sorted = [...prizes].sort((a, b) => a.stars - b.stars);
  const states = sorted.map((p) => ({ ...p, ready: saved >= p.stars, missing: Math.max(0, p.stars - saved) }));
  const ready = states.filter((p) => p.ready);
  return {
    saved,
    lifetime,
    prizes: states,
    next: states.find((p) => !p.ready) ?? null,
    best: ready.at(-1) ?? null,
  };
}
