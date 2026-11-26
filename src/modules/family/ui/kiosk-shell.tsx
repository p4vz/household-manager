"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useKioskWatchdog } from "./use-kiosk-watchdog";

/**
 * Kiosk frame: exactly one 100vh screen (no page scroll), live clock,
 * background refresh every 30 s so changes from a phone show up, and night
 * mode. From 9:00 PM to 6:30 AM household time the screen dims (same light
 * theme, lower brightness, to cut glare in the kitchen; the app is light
 * only), and after 3 minutes without a touch it shows a dim drifting clock to avoid
 * burn-in; a tap wakes it. The moon button forces night mode on or off
 * until the next change of period. During the day the layout also shifts by
 * a pixel or two every few minutes.
 *
 * Screen modes (the mode button, remembered by this screen's browser):
 * - Auto (default): night mode by the clock, as above.
 * - Day / Night: always bright / always dimmed.
 * - Timeout: bright while in use; after a set time without a touch (30 s by
 *   default) the screen goes as dark as it can while staying readable. The
 *   first tap only wakes it. (A web page can't change the tablet's own
 *   backlight, so this darkens the picture.)
 *
 * A watchdog (watchdog.ts) reloads the page if fresh renders stop arriving,
 * after the connection comes back, and once a night, without ever looping
 * while offline.
 */
const REFRESH_MS = 30_000;
const IDLE_MS = 3 * 60_000;
/** Night mode dims the light theme rather than switching to a dark one. */
const NIGHT_BRIGHTNESS = 0.5;
/** How dark Timeout mode goes: still readable up close. */
const TIMEOUT_DIM_OPACITY = 0.88;
export const TIMEOUT_CHOICES = [15, 30, 60, 120, 300] as const;
export type ScreenMode = "auto" | "day" | "night" | "timeout";
const MODE_KEY = "kiosk.screenMode";
const MODE_ICON: Record<ScreenMode, string> = { auto: "🕘", day: "☀️", night: "🌙", timeout: "⏲️" };
const MODE_LABEL: Record<ScreenMode, string> = { auto: "Auto (night 9 PM–6:30 AM)", day: "Day", night: "Night", timeout: "Timeout" };

function loadMode(): { mode: ScreenMode; seconds: number } {
  try {
    const raw = JSON.parse(window.localStorage.getItem(MODE_KEY) ?? "null") as { mode?: string; seconds?: number } | null;
    const mode = (["auto", "day", "night", "timeout"] as const).find((m) => m === raw?.mode) ?? "auto";
    const seconds = TIMEOUT_CHOICES.find((x) => x === raw?.seconds) ?? 30;
    return { mode, seconds };
  } catch {
    return { mode: "auto", seconds: 30 };
  }
}

function zoned(now: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value);
  const m = Number(parts.find((p) => p.type === "minute")?.value);
  return h * 60 + m;
}

export function isNight(now: Date, tz: string): boolean {
  const mins = zoned(now, tz);
  return mins >= 21 * 60 || mins < 6 * 60 + 30;
}

export function KioskShell({
  tz,
  renderedAt,
  children,
  header,
  weather,
}: {
  tz: string;
  renderedAt: number;
  children: ReactNode;
  header: ReactNode;
  /** Shown next to the date. */
  weather?: ReactNode;
}) {
  const router = useRouter();
  const { offline } = useKioskWatchdog(renderedAt, tz);
  const [now, setNow] = useState(() => new Date());
  const [override, setOverride] = useState<{ night: boolean; scheduled: boolean } | null>(null);
  const [idle, setIdle] = useState(false);
  const [screen, setScreen] = useState<{ mode: ScreenMode; seconds: number }>({ mode: "auto", seconds: 30 });
  const [menu, setMenu] = useState(false);
  const [dimmed, setDimmed] = useState(false);
  const lastTouch = useRef(0);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after mount (no localStorage on the server)
    setScreen(loadMode());
  }, []);
  const chooseScreen = (next: { mode: ScreenMode; seconds: number }) => {
    setScreen(next);
    setOverride(null);
    try {
      window.localStorage.setItem(MODE_KEY, JSON.stringify(next));
    } catch {
      /* not remembered */
    }
  };
  // Timeout mode: check every second whether the screen has been left alone long enough.
  useEffect(() => {
    if (screen.mode !== "timeout") return;
    const check = setInterval(() => setDimmed(Date.now() - lastTouch.current > screen.seconds * 1000), 1000);
    return () => clearInterval(check);
  }, [screen]);
  // A refresh that cannot reach the server makes Next.js fall back to a full
  // page load (which lands on the offline page), so skip refreshes while
  // offline and let the watchdog reload once the connection is back.
  const offlineRef = useRef(offline);
  useEffect(() => {
    offlineRef.current = offline;
  }, [offline]);

  useEffect(() => {
    lastTouch.current = Date.now();
    const tick = setInterval(() => {
      const d = new Date();
      setNow(d);
      setIdle(Date.now() - lastTouch.current > IDLE_MS);
    }, 15_000);
    const refresh = setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine && !offlineRef.current) router.refresh();
    }, REFRESH_MS);
    const wake = () => {
      lastTouch.current = Date.now();
      setIdle(false);
      setDimmed(false);
    };
    window.addEventListener("pointerdown", wake, { capture: true });
    return () => {
      clearInterval(tick);
      clearInterval(refresh);
      window.removeEventListener("pointerdown", wake, { capture: true });
    };
  }, [router]);

  const scheduled = isNight(now, tz);
  // Auto: the clock decides; a manual override lasts until the schedule itself flips.
  const night =
    screen.mode === "night" ? true : screen.mode === "day" || screen.mode === "timeout" ? false : override && override.scheduled === scheduled ? override.night : scheduled;
  const screensaver = night && idle;
  const timedOut = screen.mode === "timeout" && dimmed;

  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(now);
  const date = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(now);
  const shift = Math.floor(now.getTime() / 300_000) % 4;

  return (
    <div className="h-screen w-screen overflow-hidden">
      <div
        className="flex h-full w-full flex-col overflow-hidden bg-slate-100 text-slate-900 transition-[filter] duration-700"
        style={{ transform: `translate(${shift % 2}px, ${shift >> 1}px)`, filter: night ? `brightness(${NIGHT_BRIGHTNESS})` : undefined }}
      >
        <header className="flex h-20 shrink-0 items-center gap-6 px-6">
          <div className="text-5xl font-bold tabular-nums">{time}</div>
          <div className="text-2xl font-medium opacity-80">{date}</div>
          {weather}
          <div className="ml-auto flex items-center gap-3">
            {offline ? (
              <span role="status" className="rounded-full bg-amber-500 px-4 py-2 text-lg font-semibold text-white">
                Offline, reconnecting…
              </span>
            ) : null}
            {header}
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenu((m) => !m)}
                className="min-h-12 min-w-12 rounded-xl border text-2xl"
                aria-label={`Screen mode: ${MODE_LABEL[screen.mode]}`}
                aria-expanded={menu}
              >
                {screen.mode === "auto" ? (night ? "🌙" : "☀️") : MODE_ICON[screen.mode]}
              </button>
              {menu ? (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setMenu(false)} />
                  <div className="absolute right-0 top-full z-40 mt-2 w-72 space-y-1 rounded-2xl border bg-white p-2 text-base shadow-2xl">
                    {(["auto", "day", "night", "timeout"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        aria-pressed={screen.mode === m}
                        onClick={() => {
                          chooseScreen({ ...screen, mode: m });
                          if (m !== "timeout") setMenu(false);
                        }}
                        className={`flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left font-medium ${screen.mode === m ? "bg-sky-100" : ""}`}
                      >
                        <span className="text-2xl">{MODE_ICON[m]}</span>
                        {MODE_LABEL[m]}
                      </button>
                    ))}
                    {screen.mode === "timeout" ? (
                      <div className="border-t px-2 pt-2">
                        <div className="mb-1 text-sm opacity-70">Darken the screen after</div>
                        <div className="flex flex-wrap gap-1">
                          {TIMEOUT_CHOICES.map((sec) => (
                            <button
                              key={sec}
                              type="button"
                              aria-pressed={screen.seconds === sec}
                              onClick={() => chooseScreen({ mode: "timeout", seconds: sec })}
                              className={`min-h-11 min-w-14 rounded-lg border px-2 text-sm font-semibold ${screen.seconds === sec ? "border-sky-500 bg-sky-100" : ""}`}
                            >
                              {sec < 60 ? `${sec} s` : `${sec / 60} min`}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {screen.mode === "auto" ? (
                      <button type="button" onClick={() => (setOverride({ night: !night, scheduled }), setMenu(false))} className="min-h-11 w-full rounded-xl border text-sm">
                        {night ? "☀️ Brighten until morning" : "🌙 Dim until tonight"}
                      </button>
                    ) : null}
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </header>
        <div className="min-h-0 flex-1 px-4 pb-4">{children}</div>
      </div>
      {timedOut ? (
        // Catches the waking tap so it doesn't also press whatever is underneath.
        <div className="fixed inset-0 z-50 bg-black transition-opacity duration-1000" style={{ opacity: TIMEOUT_DIM_OPACITY }} aria-label="Tap to wake" />
      ) : null}
      {screensaver ? (
        <div className="fixed inset-0 z-50 bg-black" aria-label="Tap to wake">
          <div
            className="absolute text-center text-slate-500"
            style={{ left: `${10 + ((now.getMinutes() * 7) % 60)}%`, top: `${10 + ((now.getMinutes() * 13) % 60)}%` }}
          >
            <div className="text-7xl font-light tabular-nums">{time}</div>
            <div className="text-xl">{date}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
