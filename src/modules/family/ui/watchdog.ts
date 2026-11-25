/**
 * Self-recovery rules for the kitchen kiosk. Pure, so they are unit tested;
 * the timers live in useKioskWatchdog() (kiosk-shell.tsx).
 *
 * The kiosk re-renders from the server every 30 s. Each fresh render brings
 * a new `renderedAt`. The watchdog reloads the whole page when:
 *
 * - renders have stopped arriving for STALL_MS while the server answers
 *   pings (a stuck router, a dead Server Action, a deploy that left the old
 *   page's code behind), or
 * - the connection came back after an outage (one reload, to get a clean
 *   page and fresh data), or
 * - it is the nightly fresh start (NIGHTLY_HOUR, household time), which
 *   clears slow memory leaks on a screen that runs for weeks.
 *
 * It never reloads while offline: a reload would only land on the offline
 * page. Instead it pings with backoff (15 s doubling to 5 min) and reloads
 * once a ping succeeds. Reloads are capped at MAX_RELOADS per RELOAD_WINDOW_MS
 * so a broken server cannot put the screen into a reload loop.
 */
export const STALL_MS = 3 * 60_000;
export const PING_MIN_MS = 15_000;
export const PING_MAX_MS = 5 * 60_000;
export const MAX_RELOADS = 3;
export const RELOAD_WINDOW_MS = 15 * 60_000;
export const NIGHTLY_HOUR = 3;

export type WatchdogState = {
  /** Last time a fresh server render arrived (client clock). */
  lastRenderAt: number;
  /** Ping results: whether the last ping reached the server. */
  online: boolean;
  /** Set when the screen went offline; cleared after the recovery reload. */
  offlineSince: number | null;
  /** Consecutive failed pings, for backoff. */
  failedPings: number;
  /** Times of recent watchdog reloads (kept in sessionStorage across reloads). */
  reloads: number[];
  /** When the page was loaded (client clock). */
  loadedAt: number;
};

export type Decision = { action: "none" } | { action: "reload"; reason: "stalled" | "back-online" | "nightly" } | { action: "wait"; reason: "offline" | "too-many-reloads" };

export function nextPingDelay(failedPings: number): number {
  return Math.min(PING_MAX_MS, PING_MIN_MS * 2 ** Math.max(0, failedPings));
}

/** Whether `now` is in the nightly fresh-start window and the page is older than that window. */
export function isNightlyReloadDue(now: number, loadedAt: number, hourInHousehold: number): boolean {
  return hourInHousehold === NIGHTLY_HOUR && now - loadedAt > 60 * 60_000;
}

export function decide(s: WatchdogState, now: number, hourInHousehold: number): Decision {
  if (!s.online) return { action: "wait", reason: "offline" };

  const recent = s.reloads.filter((t) => now - t < RELOAD_WINDOW_MS);
  const capped = recent.length >= MAX_RELOADS;

  let reason: "stalled" | "back-online" | "nightly" | null = null;
  if (s.offlineSince !== null) reason = "back-online";
  else if (now - s.lastRenderAt > STALL_MS) reason = "stalled";
  else if (isNightlyReloadDue(now, s.loadedAt, hourInHousehold)) reason = "nightly";

  if (!reason) return { action: "none" };
  if (capped) return { action: "wait", reason: "too-many-reloads" };
  return { action: "reload", reason };
}
