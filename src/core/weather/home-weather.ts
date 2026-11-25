import "server-only";
import { outboundFetch } from "@/core/net/outbound";
import { householdTimeZone } from "@/core/time/zoned";
import { parseWeatherPlace, toHomeWeather, type HomeWeather } from "./parse";

export type { HomeWeather, WeatherDay } from "./parse";

/**
 * Weather at home for the kitchen screen and the app's home page, from
 * Open-Meteo (free, keyless, already on the outbound allowlist). Only the
 * coordinates in HOME_WEATHER are sent. Cached in memory for 15 minutes, so
 * the kiosk's 30-second refresh does not call out each time; a failure shows
 * the last good copy (up to 3 hours old) or nothing.
 */
const FRESH_MS = 15 * 60_000;
const STALE_MS = 3 * 60 * 60_000;
let cache: { key: string; at: number; value: HomeWeather } | null = null;
let inflight: Promise<HomeWeather | null> | null = null;

export async function homeWeather(now = Date.now()): Promise<HomeWeather | null> {
  const place = parseWeatherPlace(process.env.HOME_WEATHER);
  if (!place) return null;
  const key = `${place.latitude},${place.longitude}`;
  if (cache && cache.key === key && now - cache.at < FRESH_MS) return cache.value;
  inflight ??= load(place, key).finally(() => {
    inflight = null;
  });
  const fresh = await inflight;
  if (fresh) return fresh;
  return cache && cache.key === key && now - cache.at < STALE_MS ? cache.value : null;
}

async function load(place: NonNullable<ReturnType<typeof parseWeatherPlace>>, key: string): Promise<HomeWeather | null> {
  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(place.latitude));
    url.searchParams.set("longitude", String(place.longitude));
    url.searchParams.set("current", "temperature_2m,apparent_temperature,weather_code,is_day");
    url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max");
    url.searchParams.set("temperature_unit", "fahrenheit");
    url.searchParams.set("timezone", householdTimeZone());
    url.searchParams.set("forecast_days", "5");
    const res = await outboundFetch(url, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const value = toHomeWeather(place, await res.json(), new Date());
    if (value) cache = { key, at: Date.now(), value };
    return value;
  } catch {
    return null;
  }
}
