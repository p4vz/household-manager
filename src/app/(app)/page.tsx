import Link from "next/link";
import { InstallAppButton } from "@/components/pwa/install-app-button";
import { WeatherWidget } from "@/components/weather-widget";
import { homeWeather } from "@/core/weather/home-weather";
import { MODULE_DEFINITIONS } from "@/modules/registry";

export default async function Home() {
  const weather = await homeWeather();
  return (
    <div className="space-y-4">
      <InstallAppButton className="sm:max-w-sm" />
      <div className="sm:max-w-md">
        <WeatherWidget weather={weather} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
      {MODULE_DEFINITIONS.map((m) => (
        <Link key={m.name} href={m.href} className="rounded-xl border p-6 hover:bg-foreground/5">
          <h2 className="text-lg font-medium">{m.title}</h2>
        </Link>
      ))}
      </div>
    </div>
  );
}
