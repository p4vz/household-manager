import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const ROOT = resolve(__dirname, "..");
const json = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), "utf8"));

describe("Household phone app manifest", () => {
  const m = json("public/manifest.webmanifest");

  it("keeps the id of the first install so existing phone installs update in place", () => {
    expect(m.id).toBe("/family");
  });

  it("opens the whole app, not only the family view, and leaves the kitchen screen out", () => {
    expect(m.start_url).toBe("/");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");
    expect(JSON.stringify(m.shortcuts)).not.toContain("/kiosk");
  });

  it("stays a separate app from the kitchen screen", () => {
    expect(json("public/kiosk.webmanifest").id).not.toBe(m.id);
  });
});

describe("service worker", () => {
  const sw = readFileSync(resolve(ROOT, "public/sw.js"), "utf8");

  it("never caches pages, API responses or version.json", () => {
    // Only build files and icons are cached on demand; pages go to the network.
    expect(sw).toMatch(/startsWith\("\/_next\/static\/"\) \|\| url\.pathname\.startsWith\("\/icons\/"\)/);
    expect(sw).not.toMatch(/\/api\//);
    expect(sw).not.toContain("version.json");
  });

  it("lets the Update app button activate a waiting worker", () => {
    expect(sw).toContain("SKIP_WAITING");
  });
});

describe("update check", () => {
  async function load(version: string | undefined) {
    vi.resetModules();
    if (version === undefined) delete process.env.HM_APP_VERSION;
    else process.env.HM_APP_VERSION = version;
    return import("@/components/pwa/app-version");
  }

  it("offers an update only when the server runs a different build", async () => {
    const { isNewer } = await load("abc1234");
    expect(isNewer("def5678")).toBe(true);
    expect(isNewer("abc1234")).toBe(false);
    expect(isNewer(null)).toBe(false);
  });

  it("never nags in development builds", async () => {
    const { isNewer } = await load(undefined);
    expect(isNewer("def5678")).toBe(false);
  });
});

describe("Aprelev Household branding", () => {
  it("names both apps and ships maskable icons", () => {
    const m = json("public/manifest.webmanifest");
    const k = json("public/kiosk.webmanifest");
    expect(m.name).toBe("Aprelev Household");
    expect(k.name).toBe("Aprelev Kitchen");
    for (const man of [m, k]) {
      const purposes = man.icons.map((i: { purpose: string }) => i.purpose);
      expect(purposes).toContain("maskable");
      expect(purposes).toContain("any");
    }
  });
});
