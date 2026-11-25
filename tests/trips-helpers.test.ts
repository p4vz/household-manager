import { describe, expect, it } from "vitest";
import { sanitizeReferencePayload } from "@/core/ai/sanitize";
import { parsePastedPlaces } from "@/modules/trips/dining-import";
import { toCandidate } from "@/modules/trips/external/osm";
import { collapseToTemplate, expandTemplate } from "@/modules/trips/packing";
import { formatLeg, slugify, utcToZonedInput, zonedToUtc } from "@/modules/trips/ui/format";

describe("times carry two zones", () => {
  it("parses ticket times in their own zones", () => {
    expect(zonedToUtc("2026-11-20T18:35", "America/New_York").toISOString()).toBe("2026-11-20T23:35:00.000Z");
    expect(zonedToUtc("2026-11-21T08:15", "Europe/Zurich").toISOString()).toBe("2026-11-21T07:15:00.000Z");
    expect(utcToZonedInput(new Date("2026-11-21T07:15:00Z"), "Europe/Zurich")).toBe("2026-11-21T08:15");
  });

  it("renders a transatlantic leg in departure and arrival zones", () => {
    const leg = formatLeg(new Date("2026-11-20T23:35:00Z"), new Date("2026-11-21T07:15:00Z"), "America/New_York", "Europe/Zurich");
    expect(leg).toBe("18:35 New York → 08:15 Zurich (21 Nov)");
  });

  it("drops zone labels when both ends share an offset", () => {
    expect(formatLeg(new Date("2026-11-22T09:00:00Z"), new Date("2026-11-22T12:30:00Z"), "Europe/Zurich", "Europe/Vienna")).toBe("10:00 → 13:30");
  });
});

describe("packing templates", () => {
  const template = [
    { name: "Socks", category: "clothing" as const, quantity: 5, perPerson: true, notes: null },
    { name: "Plug adapter", category: "electronics" as const, quantity: 2, perPerson: false, notes: null },
  ];

  it("expands per-person items once per traveller and shared items once", () => {
    const rows = expandTemplate(template, ["a", "b"]);
    expect(rows.map((r) => `${r.name}:${r.travelerId}`)).toEqual(["Socks:a", "Socks:b", "Plug adapter:null"]);
  });

  it("collapses a trip list back into a template", () => {
    expect(collapseToTemplate(expandTemplate(template, ["a", "b"]))).toEqual(template);
  });
});

describe("gluten-free sources", () => {
  it("parses pasted Find Me Gluten Free lines and reports junk", () => {
    const { places, skipped } = parsePastedPlaces("# saved\nPanificio Senza | Via Roma 1, Bolzano | dedicated | great bread\nX\nCafé Sacher\tVienna");
    expect(places.map((p) => [p.name, p.gfStatus])).toEqual([["Panificio Senza", "dedicated_gf"], ["Café Sacher", "unknown"]]);
    expect(places[0].notes).toBe("great bread");
    expect(skipped).toEqual(["X"]);
  });

  it("treats OSM diet:gluten_free=only as a dedicated kitchen", () => {
    const c = toCandidate({ type: "node", id: 7, lat: 1, lon: 2, tags: { name: "Glutenfrei", "diet:gluten_free": "only" } });
    expect(c).toMatchObject({ gfStatus: "dedicated_gf", celiacFriendly: true, sourceRef: "node/7" });
    expect(toCandidate({ type: "node", id: 8, tags: { "diet:gluten_free": "yes" } })).toBeNull();
  });
});

describe("reference payloads for trip AI", () => {
  it("keeps years but strips long numbers and legal names", () => {
    const out = sanitizeReferencePayload({ reference: "Built in 1387 by Alexandra Smith. Call 0471 123456, card ****1234." }, ["Alexandra Smith"]);
    expect(out.reference).toContain("1387");
    expect(out.reference).not.toMatch(/Smith|123456|1234\./);
  });
});

it("slugifies trip names", () => {
  expect(slugify("Thanksgiving: Zürich & Südtirol 2026")).toBe("thanksgiving-zurich-sudtirol-2026");
});
