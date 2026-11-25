import Link from "next/link";
import { needsAttention } from "@/assistant/attention";
import { NeedsAttention } from "@/components/home/needs-attention";
import { UploadInbox } from "@/components/home/upload-inbox";
import { InstallAppButton } from "@/components/pwa/install-app-button";
import { WeatherWidget } from "@/components/weather-widget";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { homeWeather } from "@/core/weather/home-weather";
import { today } from "@/modules/family/api";
import { viewerFromLabel } from "@/modules/finance/api";
import { listVehicles } from "@/modules/maintenance/api";
import { MODULE_DEFINITIONS } from "@/modules/registry";
import {
  fileCarDueAction,
  fileEventAction,
  fileReturnAction,
  fileUpkeepAction,
  noteOnTransactionAction,
  readUploadAction,
  receiptMatchesAction,
} from "./home-actions";

export default async function Home() {
  const user = await requireUserOrRedirect();
  const day = today();
  const [weather, groups, cars] = await Promise.all([
    homeWeather(),
    needsAttention(viewerFromLabel(user.owner), day),
    listVehicles().catch(() => []),
  ]);
  return (
    <div className="space-y-6">
      <InstallAppButton className="sm:max-w-sm" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <UploadInbox
          today={day}
          cars={cars.map((c) => ({ id: c.id, name: c.name }))}
          actions={{
            read: readUploadAction,
            fileEvent: fileEventAction,
            fileReturn: fileReturnAction,
            receiptMatches: receiptMatchesAction,
            noteOnTransaction: noteOnTransactionAction,
            fileCarDue: fileCarDueAction,
            fileUpkeep: fileUpkeepAction,
          }}
        />
        <div>
          <WeatherWidget weather={weather} />
        </div>
      </div>
      <NeedsAttention groups={groups} />
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
