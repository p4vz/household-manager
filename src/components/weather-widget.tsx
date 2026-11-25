import type { HomeWeather } from "@/core/weather/parse";

/** Current conditions and the next days. `size="kiosk"` is the large wall-screen strip. */
export function WeatherWidget({ weather, size = "card" }: { weather: HomeWeather | null; size?: "card" | "kiosk" }) {
  if (!weather) return null;
  const { now, days } = weather;
  if (size === "kiosk") {
    return (
      <div className="flex items-center gap-4" aria-label={`Weather in ${weather.place}`}>
        <div className="flex items-center gap-2">
          <span className="text-5xl leading-none">{now.icon}</span>
          <div className="leading-tight">
            <div className="text-4xl font-bold tabular-nums">{now.temp}°</div>
            <div className="text-sm opacity-70">
              {now.label}
              {days[0] ? ` · ${days[0].high}°/${days[0].low}°` : ""}
            </div>
          </div>
        </div>
        <div className="hidden gap-3 xl:flex">
          {days.slice(1, 4).map((d) => (
            <div key={d.date} className="text-center leading-tight">
              <div className="text-sm font-semibold opacity-70">{d.day}</div>
              <div className="text-2xl">{d.icon}</div>
              <div className="text-sm tabular-nums">
                {d.high}°<span className="opacity-60">/{d.low}°</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <section className="rounded-xl border p-4" aria-label={`Weather in ${weather.place}`}>
      <div className="flex items-center gap-3">
        <span className="text-4xl">{now.icon}</span>
        <div>
          <div className="text-3xl font-semibold tabular-nums">{now.temp}°F</div>
          <div className="text-sm opacity-70">
            {now.label} · feels like {now.feelsLike}° · {weather.place}
          </div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-5 gap-1 text-center text-sm">
        {days.map((d) => (
          <div key={d.date}>
            <div className="font-medium opacity-70">{d.day}</div>
            <div className="text-xl">{d.icon}</div>
            <div className="tabular-nums">
              {d.high}°<span className="opacity-60">/{d.low}°</span>
            </div>
            {d.rainChance !== null && d.rainChance >= 30 ? <div className="text-xs text-sky-600">{d.rainChance}%</div> : null}
          </div>
        ))}
      </div>
    </section>
  );
}
