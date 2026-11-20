/** Presentation helpers for trip pages. Pure, safe for server and client components. */

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "trip"
  );
}

const utcDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

export function formatDay(iso: string): string {
  return utcDate(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

export function formatDateRange(start: string, end: string): string {
  const a = utcDate(start);
  const b = utcDate(end);
  const sameMonth = a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear();
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", timeZone: "UTC" };
  const s = a.toLocaleDateString("en-GB", sameMonth ? { day: "numeric", timeZone: "UTC" } : opts);
  return `${s} - ${b.toLocaleDateString("en-GB", { ...opts, year: "numeric" })}`;
}

export function formatTime(d: Date, timeZone?: string | null): string {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: timeZone ?? "UTC" });
}

/** Local calendar day of an instant in a zone, as YYYY-MM-DD. */
export function localDay(d: Date, timeZone?: string | null): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function zoneCity(timeZone: string): string {
  return timeZone.split("/").pop()!.replace(/_/g, " ");
}

function offsetMinutes(d: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(d);
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(parts.find((p) => p.type === "timeZoneName")?.value ?? "");
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}

/**
 * "18:35 New York -> 08:15 Zurich (20 Nov)". Each end is shown in its own
 * zone; zone labels are dropped when both ends share an offset, and the
 * arrival date is added when it falls on a different local day.
 */
export function formatLeg(start: Date, end: Date | null, tz: string | null, endTz: string | null): string {
  const startTz = tz ?? "UTC";
  if (!end) return formatTime(start, startTz);
  const arriveTz = endTz ?? startTz;
  const labelled = offsetMinutes(start, startTz) !== offsetMinutes(end, arriveTz);
  const a = `${formatTime(start, startTz)}${labelled ? ` ${zoneCity(startTz)}` : ""}`;
  let b = `${formatTime(end, arriveTz)}${labelled ? ` ${zoneCity(arriveTz)}` : ""}`;
  if (localDay(start, startTz) !== localDay(end, arriveTz)) {
    b += ` (${end.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: arriveTz })})`;
  }
  return `${a} → ${b}`;
}

/**
 * Parses a datetime-local value ("2026-11-20T18:35") as wall-clock time in
 * `timeZone` and returns the UTC instant.
 */
export function zonedToUtc(local: string, timeZone: string | null): Date {
  const asUtc = new Date(`${local.length === 16 ? `${local}:00` : local}Z`);
  if (!timeZone) return asUtc;
  // Two passes handle instants near a DST change.
  let guess = new Date(asUtc.getTime() - offsetMinutes(asUtc, timeZone) * 60_000);
  guess = new Date(asUtc.getTime() - offsetMinutes(guess, timeZone) * 60_000);
  return guess;
}

/** Inverse of zonedToUtc, for prefilling datetime-local inputs. */
export function utcToZonedInput(d: Date, timeZone: string | null): string {
  const shifted = new Date(d.getTime() + offsetMinutes(d, timeZone ?? "UTC") * 60_000);
  return shifted.toISOString().slice(0, 16);
}

export function daysUntil(iso: string, today = new Date()): number {
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((utcDate(iso).getTime() - t) / 86_400_000);
}

export function nightsBetween(start: string, end: string): number {
  return Math.max(0, Math.round((utcDate(end).getTime() - utcDate(start).getTime()) / 86_400_000));
}

export function tripDays(start: string, end: string): string[] {
  const days: string[] = [];
  for (let d = utcDate(start); d <= utcDate(end); d = new Date(d.getTime() + 86_400_000)) days.push(d.toISOString().slice(0, 10));
  return days;
}

export const ITINERARY_LABELS = {
  flight: "Flight",
  train: "Train",
  drive: "Drive",
  ferry: "Ferry",
  lodging: "Stay",
  activity: "Activity",
  meal: "Meal",
  meeting: "Meeting",
  note: "Note",
} as const;

export const ITINERARY_ICONS = {
  flight: "✈️",
  train: "🚆",
  drive: "🚗",
  ferry: "⛴️",
  lodging: "🏨",
  activity: "🎯",
  meal: "🍽️",
  meeting: "📅",
  note: "📝",
} as const;

export const BOOKING_LABELS = {
  idea: "Idea",
  needs_booking: "Needs booking",
  booked: "Booked",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
} as const;

export function bookingVariant(s: keyof typeof BOOKING_LABELS): "default" | "secondary" | "warning" | "destructive" | "outline" {
  return s === "confirmed" ? "default" : s === "booked" ? "secondary" : s === "needs_booking" ? "warning" : s === "cancelled" ? "destructive" : "outline";
}

export const GF_LABELS = {
  unknown: "Not rated",
  dedicated_gf: "Dedicated gluten-free",
  gf_menu: "Gluten-free menu",
  accommodating: "Can accommodate",
  avoid: "Avoid",
} as const;

export function gfVariant(s: keyof typeof GF_LABELS): "default" | "secondary" | "warning" | "destructive" | "outline" {
  return s === "dedicated_gf" ? "default" : s === "gf_menu" ? "secondary" : s === "accommodating" ? "warning" : s === "avoid" ? "destructive" : "outline";
}

export const PACKING_LABELS = {
  clothing: "Clothing",
  toiletries: "Toiletries",
  electronics: "Electronics",
  documents: "Documents",
  medical: "Medical",
  gf_food: "Gluten-free food",
  kids: "Kids",
  gear: "Gear",
  other: "Other",
} as const;

export const DOCUMENT_LABELS = {
  passport: "Passport",
  visa: "Visa",
  id_card: "ID card",
  insurance: "Insurance",
  vaccination: "Vaccination",
  booking: "Booking",
  ticket: "Ticket",
  medical: "Medical",
  other: "Other",
} as const;

export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
