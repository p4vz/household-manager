import "server-only";
import type { OwnerLabel } from "@/core/auth/allowlist";
import { allApiKeyStatus } from "@/core/ai/keys";
import { backupStatus } from "@/core/backup/run";
import { hasAdultPin } from "@/core/kiosk/adult";
import { listKioskDevices } from "@/core/kiosk/devices";
import { lastCronCall } from "@/core/net/cron-seen";
import { listDevices } from "@/core/push/push";
import { getSetting, setSetting } from "@/core/settings/store";
import { readVisits } from "@/core/visits";
import { parseWeatherPlace } from "@/core/weather/parse";
import { listMailboxes, slideshowStatus } from "@/modules/family/api";
import { syncStatus } from "@/modules/finance/api";
import { listVehicles } from "@/modules/maintenance/api";

/**
 * Setup checklists, one per member (Pavel, 2026-11-26: "an onboarding list
 * for me and Raisa"). Pavel's list is the household setup that is still
 * open (server settings, cron, backups, kitchen screen, cars); Raisa's is
 * her first-login list (her own accounts, subscriptions, phone, calendar).
 *
 * Where the app can tell, a step ticks itself (`auto`). Anything else the
 * member ticks by hand; a hand tick also overrides a check that can't see
 * the whole picture (one car instead of two). Status only: no secret,
 * address or account detail is read into a step, and nothing here goes to
 * an AI or out of the server except the member's own page.
 */
export type Member = "user1" | "user2";

export type OnboardingStep = {
  id: string;
  title: string;
  /** What to do, in a sentence or two. */
  detail: string;
  href: string;
  /** Label for the link (default "Open"). */
  action?: string;
  /** True when the app checks this itself. */
  auto: boolean;
  done: boolean;
  /** "checked": the app saw it done. "ticked": the member ticked it. */
  doneBy?: "checked" | "ticked";
};

export type Onboarding = {
  member: Member;
  steps: OnboardingStep[];
  done: number;
  total: number;
  /** The member hid the card from the home page. */
  hidden: boolean;
  /** When the member first saw the welcome page (Raisa's first-login flow). */
  welcomedAt: string | null;
};

type Saved = { ticked: string[]; hidden: boolean; welcomedAt: string | null };

export const memberOf = (owner: OwnerLabel): Member => (owner === "User 1" ? "user1" : "user2");
const key = (m: Member) => `onboarding.${m}`;

async function loadSaved(m: Member): Promise<Saved> {
  const v = (await getSetting(key(m))) as Partial<Saved> | undefined;
  return { ticked: Array.isArray(v?.ticked) ? v.ticked.filter((s) => typeof s === "string") : [], hidden: v?.hidden === true, welcomedAt: v?.welcomedAt ?? null };
}

async function save(m: Member, patch: Partial<Saved>) {
  await setSetting(key(m), { ...(await loadSaved(m)), ...patch });
}

/** How long a cron job may be silent before the checklist says it isn't scheduled. */
const CRON_STALE_MS = 3 * 86_400_000;
export const CRON_COMMAND = "node scripts/cron.mjs simplefin-sync monthly-advisor card-catalog family-hub backup notifications";

/** Each check fails soft: if an area can't be read, the step just stays open. */
async function check<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[onboarding] check failed: ${err instanceof Error ? err.message : "error"}`);
    return fallback;
  }
}

type Def = Omit<OnboardingStep, "done" | "doneBy"> & { checked?: boolean };

/** Exported for tests: legal names set in "Legal Name=Nickname" form. */
export function legalNamesLookRight(raw: string | undefined): boolean {
  const entries = (raw ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  return entries.length > 0 && entries.some((e) => /^[^=]+=[^=]+$/.test(e));
}

async function sharedChecks(m: Member) {
  const [mail, push] = await Promise.all([check(async () => (await listMailboxes(m)).length > 0, false), check(async () => (await listDevices(m)).length > 0, false)]);
  return { mail, push };
}

async function pavelSteps(now: Date, otherName: string): Promise<Def[]> {
  const [bank, keys, pin, kiosks, cars, backup, slideshow, catalogSeen, raisa, own] = await Promise.all([
    check(async () => (await syncStatus()).connection.connected, false),
    check(async () => {
      const k = await allApiKeyStatus();
      return k.claude_subscription.source !== null || k.anthropic.source !== null;
    }, false),
    check(hasAdultPin, false),
    check(async () => (await listKioskDevices()).length > 0, false),
    check(async () => (await listVehicles()).length, 0),
    check(backupStatus, null),
    check(slideshowStatus, null),
    check(() => lastCronCall("card-catalog"), null),
    check(() => readVisits("User 2"), null),
    sharedChecks("user1"),
  ]);
  const backupDetail = !backup?.keySet
    ? "Set BACKUP_KEY in Railway (32 random bytes, base64), then connect Google Drive in Settings and run the first backup."
    : !backup.drive.connected
      ? "BACKUP_KEY is set. Connect Google Drive in Settings, then tap Back up now once."
      : "Drive is connected. Tap Back up now once to check it works; after that it runs every night at 3 AM.";
  return [
    { id: "bank", title: "Connect the banks", detail: "Link SimpleFIN so cards and accounts sync twice a day.", href: "/settings#bank-sync", auto: true, checked: bank },
    {
      id: "accounts",
      title: "Check accounts, types and card photos",
      detail: "Make sure each Wells Fargo account has the right type (checking, savings, card) and owner, and add card photos so you can tell cards apart.",
      href: "/finance/accounts",
      auto: false,
    },
    { id: "claude", title: "Save the Claude token", detail: "Ask Claude, categorizing and audits use it.", href: "/settings", auto: true, checked: keys },
    {
      id: "legal-names",
      title: "Update HOUSEHOLD_LEGAL_NAMES",
      detail: 'In Railway, set it to comma-separated "Legal Name=Nickname" entries (for example "Daniel Example=Dan"), so Claude keeps first names and nicknames and never sees surnames.',
      href: "https://railway.com/dashboard",
      action: "Open Railway",
      auto: true,
      checked: legalNamesLookRight(process.env.HOUSEHOLD_LEGAL_NAMES),
    },
    {
      id: "weather",
      title: "Set HOME_WEATHER",
      detail: 'In Railway, set HOME_WEATHER to "Town, ST|latitude|longitude" (for example "Abington, PA|40.12|-75.12") to show weather here and on the kitchen screen.',
      href: "https://railway.com/dashboard",
      action: "Open Railway",
      auto: true,
      checked: parseWeatherPlace(process.env.HOME_WEATHER) !== null,
    },
    {
      id: "cron",
      title: "Add the new jobs to the Railway cron",
      detail: `Set the cron service's start command to: ${CRON_COMMAND}. This ticks itself after the card catalog job first runs (6 AM).`,
      href: "https://railway.com/dashboard",
      action: "Open Railway",
      auto: true,
      checked: catalogSeen !== null && now.getTime() - catalogSeen.getTime() < CRON_STALE_MS,
    },
    { id: "backups", title: "Turn on nightly backups", detail: backupDetail, href: "/settings#backups", auto: true, checked: Boolean(backup?.keySet && backup.drive.connected && backup.lastOkAt) },
    { id: "cars", title: "Add both cars", detail: "Add each car with its mileage; the usual oil, tire, inspection and registration items come with it.", href: "/maintenance#vehicles", auto: true, checked: cars >= 2 },
    { id: "kiosk", title: "Pair the kitchen screen", detail: "Make a pairing code in Settings and type it on the kitchen phone.", href: "/settings#kiosk", auto: true, checked: kiosks },
    { id: "kiosk-pin", title: "Set the kitchen screen adult PIN", detail: "The PIN unlocks adult mode on the kitchen screen (to-do deletes, Ask Claude).", href: "/settings#kiosk", auto: true, checked: pin },
    {
      id: "slideshow",
      title: "Set up the photo slideshow",
      detail: "In the Google Cloud project used for sign-in, enable the Photos Picker API and add the photospicker.mediaitems.readonly scope to the consent screen. Then choose photos in Settings.",
      href: "/settings#slideshow",
      auto: true,
      checked: (slideshow?.photos ?? 0) > 0,
    },
    { id: "email", title: "Connect your email for returns", detail: "The app reads return and refund emails (read-only) and suggests returns with deadlines.", href: "/settings#email", auto: true, checked: own.mail },
    { id: "push", title: "Turn on phone notifications", detail: "For upkeep, return deadlines, registrations and inspections. Not bills.", href: "/settings#notifications", auto: true, checked: own.push },
    { id: "install", title: "Install the app on your phone", detail: "Open this site on your phone and add it to the home screen. Ticks itself when you open the installed app.", href: "/settings#phone-app", auto: true },
    { id: "raisa", title: `Get ${otherName} signed in`, detail: "Send the link. A welcome checklist opens the first time they sign in.", href: "/", action: "", auto: true, checked: raisa !== null },
  ];
}

async function raisaSteps(): Promise<Def[]> {
  const own = await sharedChecks("user2");
  return [
    {
      id: "accounts",
      title: "Check which accounts are yours",
      detail: "Your own accounts are private to you; joint ones are shared by you both. Fix any that are marked wrong and add card photos if you like.",
      href: "/finance/accounts",
      auto: false,
    },
    { id: "subscriptions", title: "Go through your subscriptions", detail: "Mark which are yours, your partner's or joint, and cancel any you don't use.", href: "/finance/subscriptions", auto: false },
    { id: "install", title: "Install the app on your phone", detail: "Open this site on your phone and add it to the home screen. Ticks itself when you open the installed app.", href: "/settings#phone-app", auto: true },
    { id: "push", title: "Turn on phone notifications", detail: "For upkeep, return deadlines, registrations and inspections. Not bills.", href: "/settings#notifications", auto: true, checked: own.push },
    {
      id: "calendar",
      title: "Add the shared calendar on your phone",
      detail: 'Events here live on the shared family Google calendar. Make sure it shows in Google Calendar on your phone, and try adding an event here.',
      href: "/calendar",
      auto: false,
    },
    { id: "email", title: "Connect your email for returns", detail: "Only you see your mailbox and what's found in it, until you add a return to the shared list.", href: "/settings#email", auto: true, checked: own.mail },
    { id: "kids", title: "Look at the kids' chores and reading", detail: "Chores, reading streaks, stars and prizes for the kids.", href: "/family", auto: false },
    { id: "ask", title: "Try Ask Claude", detail: "Ask about the calendar, chores, shopping, upkeep or your own spending, or have it add things for you.", href: "/assistant", auto: false },
  ];
}

/** `otherName`: the other member's first name, for one on-screen line (passed in by the page). */
export async function onboarding(owner: OwnerLabel, now = new Date(), otherName = "the other member"): Promise<Onboarding> {
  const m = memberOf(owner);
  const [saved, defs] = await Promise.all([loadSaved(m), m === "user1" ? pavelSteps(now, otherName) : raisaSteps()]);
  const steps: OnboardingStep[] = defs.map(({ checked, ...d }) => {
    if (checked) return { ...d, done: true, doneBy: "checked" };
    if (saved.ticked.includes(d.id)) return { ...d, done: true, doneBy: "ticked" };
    return { ...d, done: false };
  });
  const done = steps.filter((s) => s.done).length;
  return { member: m, steps, done, total: steps.length, hidden: saved.hidden, welcomedAt: saved.welcomedAt };
}

/** Step ids each member's list can hold, so a tick can't store arbitrary text. */
export const STEP_IDS: Record<Member, readonly string[]> = {
  user1: ["bank", "accounts", "claude", "legal-names", "weather", "cron", "backups", "cars", "kiosk", "kiosk-pin", "slideshow", "email", "push", "install", "raisa"],
  user2: ["accounts", "subscriptions", "install", "push", "calendar", "email", "kids", "ask"],
};

export async function tickStep(owner: OwnerLabel, id: string, done: boolean): Promise<void> {
  const m = memberOf(owner);
  if (!STEP_IDS[m].includes(id)) throw new Error("Unknown step");
  const saved = await loadSaved(m);
  const ticked = new Set(saved.ticked);
  if (done) ticked.add(id);
  else ticked.delete(id);
  await save(m, { ticked: [...ticked] });
}

export async function setOnboardingHidden(owner: OwnerLabel, hidden: boolean): Promise<void> {
  await save(memberOf(owner), { hidden });
}

/** Marks the welcome page as seen; returns true the first time. */
export async function markWelcomed(owner: OwnerLabel, now = new Date()): Promise<boolean> {
  const m = memberOf(owner);
  const saved = await loadSaved(m);
  if (saved.welcomedAt) return false;
  await save(m, { welcomedAt: now.toISOString() });
  return true;
}

/** Raisa's first sign-in goes to the welcome page once. Pavel set the app up, so he never does. */
export async function needsWelcome(owner: OwnerLabel): Promise<boolean> {
  if (owner !== "User 2") return false;
  return (await loadSaved("user2")).welcomedAt === null;
}
