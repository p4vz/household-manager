import { describe, expect, it } from "vitest";
import { decide, MAX_RELOADS, nextPingDelay, PING_MAX_MS, PING_MIN_MS, STALL_MS, type WatchdogState } from "@/modules/family/ui/watchdog";

const T0 = 1_000_000_000;
const base = (over: Partial<WatchdogState> = {}): WatchdogState => ({
  lastRenderAt: T0,
  online: true,
  offlineSince: null,
  failedPings: 0,
  reloads: [],
  loadedAt: T0,
  ...over,
});

describe("kiosk watchdog", () => {
  it("leaves a healthy page alone", () => {
    expect(decide(base(), T0 + 60_000, 14)).toEqual({ action: "none" });
  });

  it("reloads when fresh renders stop arriving", () => {
    expect(decide(base(), T0 + STALL_MS + 1, 14)).toEqual({ action: "reload", reason: "stalled" });
  });

  it("never reloads while offline, however long renders have stopped", () => {
    expect(decide(base({ online: false, offlineSince: T0 }), T0 + 60 * 60_000, 14)).toEqual({ action: "wait", reason: "offline" });
  });

  it("reloads once when the connection comes back", () => {
    expect(decide(base({ offlineSince: T0 }), T0 + 10 * 60_000, 14)).toEqual({ action: "reload", reason: "back-online" });
  });

  it("caps reloads so a broken server cannot cause a reload loop", () => {
    const now = T0 + STALL_MS + 1;
    const reloads = Array.from({ length: MAX_RELOADS }, (_, i) => now - (i + 1) * 60_000);
    expect(decide(base({ reloads }), now, 14)).toEqual({ action: "wait", reason: "too-many-reloads" });
    // Old reloads fall out of the window.
    expect(decide(base({ reloads: reloads.map((t) => t - 60 * 60_000) }), now, 14)).toMatchObject({ action: "reload" });
  });

  it("starts fresh once a night, only if the page is over an hour old", () => {
    expect(decide(base({ lastRenderAt: T0 + 2 * 60 * 60_000 }), T0 + 2 * 60 * 60_000, 3)).toEqual({ action: "reload", reason: "nightly" });
    expect(decide(base({ loadedAt: T0, lastRenderAt: T0 + 30 * 60_000 }), T0 + 30 * 60_000, 3)).toEqual({ action: "none" });
  });

  it("backs off pings from 15 s to 5 min", () => {
    expect(nextPingDelay(0)).toBe(PING_MIN_MS);
    expect(nextPingDelay(1)).toBe(30_000);
    expect(nextPingDelay(3)).toBe(120_000);
    expect(nextPingDelay(20)).toBe(PING_MAX_MS);
  });
});
