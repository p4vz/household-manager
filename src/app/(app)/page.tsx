import Link from "next/link";
import { redirect } from "next/navigation";
import { needsAttention } from "@/assistant/attention";
import { needsWelcome, onboarding } from "@/assistant/onboarding";
import { whatsNew } from "@/assistant/whats-new";
import { NeedsAttention } from "@/components/home/needs-attention";
import { OnboardingCard } from "@/components/home/onboarding-card";
import { WhatsNew } from "@/components/home/whats-new";
import { UploadInbox } from "@/components/home/upload-inbox";
import { InstallAppButton } from "@/components/pwa/install-app-button";
import { WeatherWidget } from "@/components/weather-widget";
import { memberDisplayName } from "@/core/auth/display-name";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { householdTimeZone, zonedParts } from "@/core/time/zoned";
import { recordVisit } from "@/core/visits";
import { homeWeather } from "@/core/weather/home-weather";
import { today } from "@/modules/family/api";
import { viewerFromLabel } from "@/modules/finance/api";
import { listVehicles } from "@/modules/maintenance/api";
import { MODULE_DEFINITIONS } from "@/modules/registry";
import {
  fileCarDueAction,
  fileBinderAction,
  fileEventAction,
  fileReturnAction,
  fileUpkeepAction,
  noteOnTransactionAction,
  readUploadAction,
  receiptMatchesAction,
} from "./home-actions";
import { hideOnboardingAction, tickStepAction } from "./welcome/actions";

/** "Tuesday 8:14 PM", or "Today 8:14 AM" / "Yesterday ..." when recent. */
function sinceWords(since: Date, now: Date, tz: string): string {
  const time = since.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  const a = zonedParts(since, tz).date;
  const b = zonedParts(now, tz).date;
  const days = Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days < 7) return `${since.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" })} ${time}`;
  return `${since.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" })} ${time}`;
}

function greeting(now: Date, tz: string): string {
  const h = zonedParts(now, tz).hour;
  return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default async function Home() {
  const user = await requireUserOrRedirect();
  if (await needsWelcome(user.owner)) redirect("/welcome");
  const now = new Date();
  const tz = householdTimeZone();
  const day = today(now);
  const viewer = viewerFromLabel(user.owner);
  const { since } = await recordVisit(user.owner, now);
  const other = memberDisplayName(user.owner === "User 1" ? "User 2" : "User 1");
  const [weather, groups, cars, news, setup] = await Promise.all([
    homeWeather(),
    needsAttention(viewer, day),
    listVehicles().catch(() => []),
    since ? whatsNew(viewer, since, { now, today: day, sinceDay: zonedParts(since, tz).date }) : Promise.resolve([]),
    onboarding(user.owner, now, other),
  ]);
  const dateLine = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">
          {greeting(now, tz)}, {memberDisplayName(user.owner)}
        </h1>
        <p className="text-sm text-muted-foreground">{dateLine}</p>
      </div>
      <InstallAppButton className="sm:max-w-sm" />
      <OnboardingCard data={setup} actions={{ tick: tickStepAction, hide: hideOnboardingAction }} />
      <WhatsNew items={news} sinceLabel={since ? sinceWords(since, now, tz) : null} />
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
            fileBinder: fileBinderAction,
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
