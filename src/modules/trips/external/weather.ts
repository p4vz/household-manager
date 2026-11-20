import "server-only";
import { outboundFetch } from "@/core/net/outbound";

/** Open-Meteo geocoding and forecast. Free and keyless; only a place name or coordinates are sent. */

export type GeocodeResult = {
  name: string;
  country: string;
  countryCode: string;
  latitude: number;
  longitude: number;
  timezone: string;
};

export async function geocodePlace(query: string): Promise<GeocodeResult | null> {
  try {
    const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
    url.searchParams.set("name", query);
    url.searchParams.set("count", "1");
    url.searchParams.set("language", "en");
    url.searchParams.set("format", "json");
    const res = await outboundFetch(url, { next: { revalidate: 86400 } });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      results?: { name: string; country: string; country_code: string; latitude: number; longitude: number; timezone: string }[];
    };
    const hit = data.results?.[0];
    if (!hit) return null;
    return {
      name: hit.name,
      country: hit.country,
      countryCode: hit.country_code,
      latitude: hit.latitude,
      longitude: hit.longitude,
      timezone: hit.timezone,
    };
  } catch {
    return null;
  }
}

export type DailyForecast = { date: string; maxC: number; minC: number; precipitationMm: number; weatherCode: number };

/**
 * Open-Meteo only forecasts about 16 days out. For trips further away it
 * returns nothing, and the UI says so instead of inventing a forecast.
 */
export async function fetchForecast(latitude: number, longitude: number, startDate: string, endDate: string): Promise<DailyForecast[]> {
  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(latitude));
    url.searchParams.set("longitude", String(longitude));
    url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code");
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("start_date", startDate);
    url.searchParams.set("end_date", endDate);
    const res = await outboundFetch(url, { next: { revalidate: 3600 } });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      daily?: { time: string[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_sum: number[]; weather_code: number[] };
    };
    const d = data.daily;
    if (!d) return [];
    return d.time.map((date, i) => ({
      date,
      maxC: d.temperature_2m_max[i],
      minC: d.temperature_2m_min[i],
      precipitationMm: d.precipitation_sum[i],
      weatherCode: d.weather_code[i],
    }));
  } catch {
    return [];
  }
}

/** WMO weather codes, condensed to what a traveller cares about. */
export function describeWeatherCode(code: number): string {
  if (code === 0) return "Clear";
  if (code <= 3) return "Partly cloudy";
  if (code <= 48) return "Fog";
  if (code <= 57) return "Drizzle";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Showers";
  if (code <= 86) return "Snow showers";
  return "Thunderstorm";
}

export function summariseForecast(days: DailyForecast[]): string | null {
  if (days.length === 0) return null;
  const highs = days.map((d) => d.maxC);
  const lows = days.map((d) => d.minC);
  const wet = days.filter((d) => d.precipitationMm >= 1).length;
  return `Highs ${Math.round(Math.min(...highs))}-${Math.round(Math.max(...highs))}°C, lows around ${Math.round(Math.min(...lows))}°C, ${wet} of ${days.length} days with rain.`;
}
