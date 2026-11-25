import "server-only";
import { z } from "zod";
import { runStructured } from "@/core/ai/run";
import { legalNamesFromEnv, sanitizeReferencePayload } from "@/core/ai/sanitize";
import { createGoogleEvent } from "@/modules/calendar/api";
import { addReturn, assertNoCardNumber, isoDateInWords, scrubMailText } from "@/modules/family/api";
import { paymentsNear, transactionsForEdit, updateTransactionFields, type Viewer } from "@/modules/finance/api";
import { listOpenTasks, listVehicles, scheduleTask, updateTask } from "@/modules/maintenance/api";

/**
 * Home page "Drop anything here": a member adds a photo, a PDF or pasted
 * text, Claude says what it is and suggests where it goes, and the member
 * confirms each suggestion before anything is saved.
 *
 * Privacy:
 * - Photos are read on the member's device (OCR in the browser). Only the
 *   text the member saw and could edit is sent here, never the picture.
 * - PDFs are not read: only the file name and the member's own note go to
 *   the AI. The file itself is kept only if the member files it.
 * - The text is scrubbed (scrubMailText, then the shared reference
 *   sanitizer): card, account, order and phone numbers, links, email
 *   addresses, codes and the household's legal names never reach the model.
 * - What comes back is checked again (dates, no long digit runs) before it
 *   is shown.
 */

export const MAX_UPLOAD_TEXT = 6000;

export const CAR_DUE_KINDS = ["registration", "inspection", "emissions", "insurance", "other"] as const;
export type CarDueKind = (typeof CAR_DUE_KINDS)[number];
export const CAR_DUE_TITLES: Record<CarDueKind, string> = {
  registration: "Registration renewal",
  inspection: "State safety inspection",
  emissions: "Emissions inspection",
  insurance: "Car insurance renewal",
  other: "Car paperwork",
};

export const BINDER_KINDS = ["manual", "warranty", "insurance", "property_tax", "receipt", "other"] as const;

const isoDate = z.string().describe("YYYY-MM-DD");
const time = z.string().describe("24-hour HH:MM");

export const UploadReading = z.object({
  what: z.string().describe("What this is, at most 12 words, e.g. 'School flyer: winter concert' or 'Target receipt'."),
  events: z
    .array(
      z.object({
        title: z.string().describe("Short event name, at most 8 words."),
        date: isoDate,
        endDate: isoDate.nullable().describe("Last day for a multi-day event, else null."),
        startTime: time.nullable(),
        endTime: time.nullable(),
        location: z.string().nullable().describe("Place name, e.g. 'School gym'. No street numbers."),
        notes: z.string().nullable().describe("What to bring or do, at most 25 words."),
      }),
    )
    .describe("Dated events to put on the family calendar: school events, appointments, games, deadlines with a date."),
  returns: z
    .array(
      z.object({
        store: z.string(),
        itemName: z.string().describe("At most 6 words."),
        returnDeadline: isoDate.nullable().describe("Last day to return. 'Within N days' counts from the purchase date."),
      }),
    )
    .describe("Purchases that state a return window, or return labels and return requests."),
  receipt: z
    .object({
      merchant: z.string(),
      date: isoDate.nullable(),
      total: z.number().nullable().describe("Total paid in dollars."),
      note: z.string().describe("What was bought, at most 15 words, for the bank transaction's note."),
    })
    .nullable()
    .describe("Set for a purchase receipt or invoice."),
  binder: z
    .object({
      title: z.string().describe("e.g. 'Bosch dishwasher manual' or 'Homeowners insurance policy 2026'."),
      kind: z.enum(BINDER_KINDS),
      expiresOn: isoDate.nullable().describe("Warranty end, policy renewal or tax due date."),
    })
    .nullable()
    .describe("Set for manuals, warranties, insurance papers, property tax bills and other papers to keep."),
  carDue: z
    .array(
      z.object({
        kind: z.enum(CAR_DUE_KINDS),
        dueDate: isoDate.describe("When it expires or is due."),
        car: z.string().nullable().describe("Which of CARS it is for, by name, if you can tell; else null."),
      }),
    )
    .describe("Car registration, inspection, emissions or insurance due dates."),
  upkeep: z
    .array(
      z.object({
        title: z.string().describe("House or car job, at most 8 words."),
        dueDate: isoDate.nullable(),
        recurrenceDays: z.number().int().nullable().describe("Repeat interval in days if stated (e.g. filter every 90 days)."),
        parts: z.string().nullable(),
      }),
    )
    .describe("House maintenance jobs, e.g. from a manual's maintenance schedule or a service visit."),
  newCard: z.boolean().describe("True if this is the front of a credit or debit card or a new-card letter."),
  advice: z.string().nullable().describe("One sentence for anything that fits none of the above, else null."),
});
export type UploadReading = z.infer<typeof UploadReading>;

const SYSTEM = [
  "You sort a family's papers for their household app: school flyers, emails, receipts, manuals, warranties, insurance, tax bills, car registrations.",
  "Use only what the text says. Never invent dates; leave a field null if it is not stated.",
  "A date with no year is in the next 12 months from TODAY.",
  "Never output card, account, order, policy, VIN or plate numbers, codes, phone numbers, email addresses, street addresses or people's surnames.",
  "Children's first names may appear in event titles.",
].join(" ");

/** Numeric dates with dashes ("12-05-2026") read as long numbers to the scrubber, so they get slashes first. */
export function normalizeDates(text: string): string {
  return text.replace(/\b(\d{1,2})[-.](\d{1,2})[-.](\d{2}|\d{4})\b/g, "$1/$2/$3");
}

export function scrubUploadText(text: string, names = legalNamesFromEnv()): string {
  return scrubMailText(normalizeDates(text), names).slice(0, MAX_UPLOAD_TEXT);
}

export type UploadInput = {
  text: string;
  note: string;
  fileName: string | null;
  fileKind: "image" | "pdf" | "text";
  today: string;
};

export async function readUpload(input: UploadInput): Promise<UploadReading> {
  const names = legalNamesFromEnv();
  const cars = (await listVehicles()).map((v) => v.name);
  const payload = sanitizeReferencePayload(
    {
      // In words: the reference sanitizer treats ISO dates as long numbers.
      TODAY: isoDateInWords(input.today) ?? input.today,
      kind: input.fileKind,
      fileName: input.fileName ? scrubUploadText(input.fileName.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_]+/g, " "), names).slice(0, 120) : null,
      note: input.note ? scrubUploadText(input.note, names).slice(0, 500) : null,
      text: input.text ? scrubUploadText(input.text, names) : null,
      CARS: cars,
    },
    names,
  );
  const out = await runStructured({
    tier: "fast",
    system: SYSTEM,
    task:
      input.fileKind === "pdf"
        ? "The member added a PDF file; only its name and their note are given. Say what it most likely is and where it belongs."
        : "Say what this is and suggest where it belongs in the household app. Fill every list that applies; most papers fit only one.",
    payload,
    schema: UploadReading,
  });
  return cleanReading(out, input.today);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const okDate = (s: string | null | undefined) => (s && DATE.test(s) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s ? s : null);
const okTime = (s: string | null | undefined) => (s && TIME.test(s) ? s : null);

/** Trim, and drop anything that still looks like an identifier (5+ digits in a row). */
function tidy(s: string | null | undefined, max: number): string | null {
  const t = s?.replace(/\[redacted\]/gi, " ").replace(/\s{2,}/g, " ").trim();
  if (!t || /\d{5,}/.test(t.replace(/[\s-]/g, ""))) return null;
  return t.slice(0, max);
}

export function cleanReading(r: UploadReading, today: string): UploadReading {
  const yearAgo = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
  const events = r.events
    .map((e) => {
      const date = okDate(e.date);
      const title = tidy(e.title, 120);
      if (!date || !title || date < yearAgo) return null;
      const endDate = okDate(e.endDate);
      return {
        title,
        date,
        endDate: endDate && endDate >= date ? endDate : null,
        startTime: okTime(e.startTime),
        endTime: okTime(e.startTime) ? okTime(e.endTime) : null,
        location: tidy(e.location, 200),
        notes: tidy(e.notes, 400),
      };
    })
    .filter((e) => e !== null)
    .slice(0, 10);
  const returns = r.returns
    .map((x) => {
      const store = tidy(x.store, 40);
      const itemName = tidy(x.itemName, 80);
      return store && itemName ? { store, itemName, returnDeadline: okDate(x.returnDeadline) } : null;
    })
    .filter((x) => x !== null)
    .slice(0, 5);
  const receiptMerchant = tidy(r.receipt?.merchant, 60);
  const receipt =
    r.receipt && receiptMerchant
      ? {
          merchant: receiptMerchant,
          date: okDate(r.receipt.date),
          total: r.receipt.total != null && Number.isFinite(r.receipt.total) && r.receipt.total > 0 && r.receipt.total < 1_000_000 ? Math.round(r.receipt.total * 100) / 100 : null,
          note: tidy(r.receipt.note, 200) ?? "",
        }
      : null;
  const binderTitle = tidy(r.binder?.title, 120);
  const binder = r.binder && binderTitle && BINDER_KINDS.includes(r.binder.kind) ? { title: binderTitle, kind: r.binder.kind, expiresOn: okDate(r.binder.expiresOn) } : null;
  const carDue = r.carDue
    .map((c) => {
      const dueDate = okDate(c.dueDate);
      return dueDate && CAR_DUE_KINDS.includes(c.kind) ? { kind: c.kind, dueDate, car: tidy(c.car, 60) } : null;
    })
    .filter((c) => c !== null)
    .slice(0, 4);
  const upkeep = r.upkeep
    .map((u) => {
      const title = tidy(u.title, 120);
      if (!title) return null;
      const every = u.recurrenceDays != null && u.recurrenceDays >= 1 && u.recurrenceDays <= 3650 ? Math.round(u.recurrenceDays) : null;
      return { title, dueDate: okDate(u.dueDate), recurrenceDays: every, parts: tidy(u.parts, 300) };
    })
    .filter((u) => u !== null)
    .slice(0, 8);
  return {
    what: tidy(r.what, 120) ?? "Something to file",
    events,
    returns,
    receipt,
    binder,
    carDue,
    upkeep,
    newCard: Boolean(r.newCard),
    advice: tidy(r.advice, 300),
  };
}

// ---------------------------------------------------------------- filing ----

export type EventFields = {
  title: string;
  date: string;
  endDate: string | null;
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  notes: string | null;
};

export async function fileEvent(e: EventFields) {
  assertNoCardNumber(e.title, e.location, e.notes);
  const timed = Boolean(e.startTime);
  const endDate = e.endDate && e.endDate >= e.date ? e.endDate : e.date;
  await createGoogleEvent({
    title: e.title,
    location: e.location,
    notes: e.notes,
    allDay: !timed,
    startDate: e.date,
    endDate,
    startTime: timed ? e.startTime : null,
    endTime: timed ? (e.endTime ?? plusHour(e.startTime!)) : null,
  });
}

function plusHour(t: string): string {
  const [h, m] = t.split(":").map(Number);
  return `${String(Math.min(23, h + 1)).padStart(2, "0")}:${String(h >= 23 ? 59 : m).padStart(2, "0")}`;
}

export async function fileReturn(r: { store: string; itemName: string; returnDeadline: string | null }) {
  return addReturn({ store: r.store, itemName: r.itemName, returnDeadline: r.returnDeadline, notes: "Added from the home page upload" });
}

/** Bank charges that could be this receipt: about the same amount within 10 days, joint and the viewer's own accounts only. */
export async function receiptMatches(viewer: Viewer, total: number, date: string) {
  const rows = await paymentsNear(viewer, total, date, 10, 1);
  return rows.slice(0, 5).map((r) => ({ id: r.id, date: r.date, merchant: r.merchant, amount: Number(r.amount) }));
}

/** Adds the receipt's note to a visible transaction (kept after any note already there). */
export async function noteOnTransaction(viewer: Viewer, id: string, note: string) {
  assertNoCardNumber(note);
  const current = (await transactionsForEdit(viewer, [id])).get(id);
  if (!current) throw new Error("Transaction not found");
  const text = note.trim();
  if (!text || current.notes?.includes(text)) return;
  await updateTransactionFields(viewer, id, { notes: current.notes ? `${current.notes}\n${text}` : text });
}

/**
 * A car registration / inspection date: moves the car's matching open item
 * (e.g. "Registration renewal: Honda") to the new date, or adds a yearly item.
 */
export async function fileCarDue(input: { carId: string; kind: CarDueKind; dueDate: string }) {
  const car = (await listVehicles()).find((v) => v.id === input.carId);
  if (!car) throw new Error("Car not found");
  const label = CAR_DUE_TITLES[input.kind];
  const existing = (await listOpenTasks()).find((t) => t.assetId === car.id && t.title.toLowerCase().startsWith(label.toLowerCase()));
  if (existing) {
    await updateTask(existing.id, { dueDate: input.dueDate });
    return { updated: true };
  }
  await scheduleTask({
    title: `${label}: ${car.name}`,
    area: "Vehicles",
    assetId: car.id,
    dueDate: input.dueDate,
    recurrenceDays: input.kind === "other" ? null : 365,
    notes: "Added from the home page upload",
  });
  return { updated: false };
}

export async function fileUpkeep(u: { title: string; dueDate: string; recurrenceDays: number | null; parts: string | null }) {
  assertNoCardNumber(u.title, u.parts);
  await scheduleTask({ title: u.title, dueDate: u.dueDate, recurrenceDays: u.recurrenceDays, parts: u.parts, notes: "Added from the home page upload" });
}
