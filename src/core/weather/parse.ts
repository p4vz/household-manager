/**
 * Home weather: parsing and shaping, pure so it is unit tested. The fetch is
 * in ./home-weather.ts.
 */
export type WeatherPlace = { label: string; latitude: number; longitude: number };

/** HOME_WEATHER="Abington, PA|40.12|-75.12" (label | latitude | longitude). */
export function parseWeatherPlace(raw: string | undefined): WeatherPlace | null {
  const parts = (raw ?? "").split("|").map((p) => p.trim());
  if (parts.length !== 3) return null;
  const [label, lat, lon] = parts;
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!label || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { label: label.slice(0, 40), latitude, longitude };
}

export type WeatherDay = { date: string; day: string; label: string; icon: string; high: number; low: number; rainChance: number | null };
export type HomeWeather = {
  place: string;
  now: { temp: number; feelsLike: number; icon: string; label: string };
  days: WeatherDay[];
  fetchedAt: string;
};

/** WMO weather code → short label and emoji; isDay picks sun or moon for clear skies. */
export function weatherLook(code: number, isDay = true): { label: string; icon: string } {
  if (code === 0) return { label: "Clear", icon: isDay ? "☀️" : "🌙" };
  if (code <= 2) return { label: "Partly cloudy", icon: isDay ? "⛅" : "☁️" };
  if (code === 3) return { label: "Cloudy", icon: "☁️" };
  if (code <= 48) return { label: "Fog", icon: "🌫️" };
  if (code <= 57) return { label: "Drizzle", icon: "🌦️" };
  if (code <= 67) return { label: "Rain", icon: "🌧️" };
  if (code <= 77) return { label: "Snow", icon: "🌨️" };
  if (code <= 82) return { label: "Showers", icon: "🌦️" };
  if (code <= 86) return { label: "Snow showers", icon: "🌨️" };
  return { label: "Thunderstorms", icon: "⛈️" };
}

type OpenMeteo = {
  current?: { temperature_2m: number; apparent_temperature: number; weather_code: number; is_day: number };
  daily?: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max?: (number | null)[];
  };
};

/** Shapes an Open-Meteo answer (°F) for the screen; null if it is missing parts. */
export function toHomeWeather(place: WeatherPlace, json: OpenMeteo, fetchedAt: Date): HomeWeather | null {
  const c = json.current;
  const d = json.daily;
  if (!c || !d?.time?.length) return null;
  const day = (iso: string, i: number) =>
    i === 0 ? "Today" : new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(new Date(`${iso}T00:00:00Z`));
  return {
    place: place.label,
    now: { temp: Math.round(c.temperature_2m), feelsLike: Math.round(c.apparent_temperature), ...weatherLook(c.weather_code, c.is_day === 1) },
    days: d.time.slice(0, 5).map((date, i) => ({
      date,
      day: day(date, i),
      ...weatherLook(d.weather_code[i]),
      high: Math.round(d.temperature_2m_max[i]),
      low: Math.round(d.temperature_2m_min[i]),
      rainChance: d.precipitation_probability_max?.[i] ?? null,
    })),
    fetchedAt: fetchedAt.toISOString(),
  };
}
