"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authedAction } from "@/core/actions/authed-action";
import { rateLimit } from "@/core/net/rate-limit";
import {
  CAR_DUE_KINDS,
  MAX_UPLOAD_TEXT,
  fileCarDue,
  fileEvent,
  fileReturn,
  fileUpkeep,
  noteOnTransaction,
  readUpload,
  receiptMatches,
  type UploadReading,
} from "@/assistant/inbox";
import { CalendarWriteError } from "@/modules/calendar/api";
import { SensitiveTextError, today } from "@/modules/family/api";
import { viewerFromLabel } from "@/modules/finance/api";

/**
 * Home page upload: read (AI, scrubbed text only) and then file each
 * suggestion the member confirms. Every filing action is a normal member
 * action; nothing is saved by the read step.
 */
type Result = { error: string | null };

const date = z.iso.date();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const short = (max: number) => z.string().trim().max(max);

function refreshHome() {
  revalidatePath("/");
}

/** Errors a member can act on come back as text; anything else is logged by name only. */
async function attempt(label: string, fn: () => Promise<unknown>, paths: string[]): Promise<Result> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof CalendarWriteError || err instanceof SensitiveTextError) return { error: err.message };
    console.warn(`[upload] ${label} failed: ${err instanceof Error ? err.name : "error"}`);
    return { error: "That didn't save. Try again, or add it on its own page." };
  }
  for (const p of paths) revalidatePath(p);
  refreshHome();
  return { error: null };
}

export const readUploadAction = authedAction(
  z.object({
    text: short(MAX_UPLOAD_TEXT),
    note: short(500),
    fileName: short(200).nullable(),
    fileKind: z.enum(["image", "pdf", "text"]),
  }),
  async (input, user): Promise<{ reading: UploadReading | null; error: string | null }> => {
    if (input.text.length < 3 && input.note.length < 3 && !input.fileName) return { reading: null, error: "Add a picture, a file or some text first." };
    if (!rateLimit(`upload-read:${user.owner}`, 10, 60_000)) return { reading: null, error: "Too many tries. Wait a minute." };
    try {
      return { reading: await readUpload({ ...input, today: today() }), error: null };
    } catch (err) {
      console.warn(`[upload] read failed: ${err instanceof Error ? err.name : "error"}`);
      return { reading: null, error: "Claude couldn't read it. Check Settings → AI configuration, or try again." };
    }
  },
);

export const fileEventAction = authedAction(
  z.object({
    title: short(120).min(1),
    date,
    endDate: date.nullable(),
    startTime: hhmm.nullable(),
    endTime: hhmm.nullable(),
    location: short(200).nullable(),
    notes: short(4000).nullable(),
  }),
  async (input) => attempt("event", () => fileEvent(input), ["/calendar", "/family", "/kiosk"]),
);

export const fileReturnAction = authedAction(
  z.object({ store: short(40).min(1), itemName: short(80).min(1), returnDeadline: date.nullable() }),
  async (input) => attempt("return", () => fileReturn(input), ["/family", "/kiosk"]),
);

export const receiptMatchesAction = authedAction(
  z.object({ total: z.number().positive().max(1_000_000), date }),
  async ({ total, date: on }, user) => {
    try {
      return { matches: await receiptMatches(viewerFromLabel(user.owner), total, on), error: null as string | null };
    } catch (err) {
      console.warn(`[upload] receipt match failed: ${err instanceof Error ? err.name : "error"}`);
      return { matches: [], error: "Couldn't look up bank charges." };
    }
  },
);

export const noteOnTransactionAction = authedAction(z.object({ id: z.uuid(), note: short(200).min(1) }), async ({ id, note }, user) =>
  attempt("receipt note", () => noteOnTransaction(viewerFromLabel(user.owner), id, note), ["/finance/transactions"]),
);

export const fileCarDueAction = authedAction(
  z.object({ carId: z.uuid(), kind: z.enum(CAR_DUE_KINDS), dueDate: date }),
  async (input) => attempt("car date", () => fileCarDue(input), ["/maintenance"]),
);

export const fileUpkeepAction = authedAction(
  z.object({ title: short(120).min(1), dueDate: date, recurrenceDays: z.number().int().min(1).max(3650).nullable(), parts: short(300).nullable() }),
  async (input) => attempt("upkeep", () => fileUpkeep(input), ["/maintenance"]),
);
