import { describe, expect, it } from "vitest";
import { parseWeatherPlace, toHomeWeather, weatherLook } from "@/core/weather/parse";

describe("home weather", () => {
  it("reads HOME_WEATHER as label|lat|lon and refuses anything else", () => {
    expect(parseWeatherPlace("Abington, PA|40.1207|-75.1179")).toEqual({ label: "Abington, PA", latitude: 40.1207, longitude: -75.1179 });
    for (const bad of [undefined, "", "Abington", "A|x|1", "A|91|0", "A|1|2|3"]) expect(parseWeatherPlace(bad)).toBeNull();
  });

  it("shapes an Open-Meteo answer for the screen", () => {
    const w = toHomeWeather(
      { label: "Abington, PA", latitude: 40.12, longitude: -75.12 },
      {
        current: { temperature_2m: 41.6, apparent_temperature: 36.2, weather_code: 0, is_day: 0 },
        daily: {
          time: ["2026-11-25", "2026-11-26", "2026-11-27"],
          weather_code: [3, 63, 71],
          temperature_2m_max: [48.4, 45, 38],
          temperature_2m_min: [33.1, 36, 29],
          precipitation_probability_max: [5, 80, null],
        },
      },
      new Date("2026-11-25T15:00:00Z"),
    );
    expect(w?.now).toEqual({ temp: 42, feelsLike: 36, icon: "🌙", label: "Clear" });
    expect(w?.days.map((d) => [d.day, d.label, d.high, d.low, d.rainChance])).toEqual([
      ["Today", "Cloudy", 48, 33, 5],
      ["Thu", "Rain", 45, 36, 80],
      ["Fri", "Snow", 38, 29, null],
    ]);
  });

  it("returns nothing for an incomplete answer", () => {
    expect(toHomeWeather({ label: "x", latitude: 0, longitude: 0 }, {}, new Date())).toBeNull();
  });

  it("maps weather codes", () => {
    expect(weatherLook(95).label).toBe("Thunderstorms");
    expect(weatherLook(0, true).icon).toBe("☀️");
  });
});
