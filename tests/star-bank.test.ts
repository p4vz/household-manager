import { describe, expect, it } from "vitest";
import { starBank } from "@/modules/family/stars";

const prizes = [
  { id: "l", name: "Large prize", emoji: "🏆", stars: 500 },
  { id: "s", name: "Small prize", emoji: "🍭", stars: 25 },
  { id: "m", name: "Medium prize", emoji: "🎁", stars: 100 },
];

describe("star bank", () => {
  it("saves stars and points at the next prize", () => {
    const b = starBank(18, 0, prizes);
    expect(b.saved).toBe(18);
    expect(b.best).toBeNull();
    expect(b.next).toMatchObject({ id: "s", missing: 7 });
    expect(b.prizes.map((p) => p.stars)).toEqual([25, 100, 500]);
  });

  it("offers the best affordable prize and the next one to save for", () => {
    const b = starBank(130, 0, prizes);
    expect(b.best?.id).toBe("m");
    expect(b.next).toMatchObject({ id: "l", missing: 370 });
  });

  it("spending lowers saved stars but not lifetime", () => {
    const b = starBank(130, 100, prizes);
    expect(b).toMatchObject({ saved: 30, lifetime: 130 });
    expect(b.best?.id).toBe("s");
    expect(starBank(10, 50, prizes).saved).toBe(0);
  });

  it("handles no prizes", () => {
    expect(starBank(5, 0, [])).toMatchObject({ saved: 5, next: null, best: null });
  });
});
