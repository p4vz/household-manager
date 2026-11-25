import "server-only";
import { z } from "zod";
import { runStructured } from "@/core/ai/run";
import { legalNamesFromEnv, sanitizeReferencePayload, scrubReferenceText } from "@/core/ai/sanitize";
import type { HouseholdUser } from "@/core/auth/guard";
import * as finance from "@/modules/finance/api";
import * as maintenance from "@/modules/maintenance/api";
import { DraftBook, recordChangeset } from "./changesets";
import { adapterFor, AssetFields, UpkeepFields } from "./entities";
import { contextFor } from "./service";

/**
 * Finance review, step 3 to 4: the member says what a large purchase was
 * for, and Claude turns that into house records: a note on the transaction,
 * the equipment it bought (furnace, roof, fridge) and the upkeep it now
 * needs (yearly HVAC service, gutter check). The edits go through the same
 * changesets as Ask Claude, so they show in its history and can be undone.
 * Claude sees the purchase's date, merchant, amount and category and the
 * member's answer, scrubbed like every other AI payload; never the account.
 */

const MAX_ANSWER = 500;

const Plan = z.object({
  summary: z.string().describe("One short sentence for the member: what you recorded."),
  note: z.string().describe("Short note for the transaction, e.g. 'New furnace and AC install'. At most 120 characters."),
  houseRelated: z.boolean().describe("True when the purchase is about the house, its equipment or its upkeep, or about upkeep of one of the household's cars."),
  vehicle: z
    .string()
    .nullable()
    .describe("When it was car upkeep (oil change, repair, tires, inspection, registration): the name of the car from vehicles, exactly as listed. Null otherwise."),
  equipment: z
    .object({
      name: z.string().describe("e.g. 'Furnace (Carrier)', 'Roof', 'Refrigerator'"),
      kind: z.enum(maintenance.ASSET_KINDS),
      location: z.string().nullable(),
      installedOn: z.string().nullable().describe("YYYY-MM-DD; usually the purchase date"),
      notes: z.string().nullable(),
    })
    .nullable()
    .describe("Equipment or part of the house this purchase bought or replaced, if any. Null for repairs to equipment already listed."),
  project: z
    .object({ title: z.string().describe("e.g. 'Furnace replacement', 'Gutter repair'"), description: z.string().nullable() })
    .nullable()
    .describe("When it was work on the house or a purchase for it: an entry for the house project history. Null otherwise."),
  tasks: z
    .array(
      z.object({
        title: z.string(),
        firstDueDate: z.string().describe("YYYY-MM-DD, today or later"),
        repeatEveryDays: z.number().int().nullable().describe("e.g. 365 for yearly service; null for one-off"),
        estimatedCost: z.number().nullable(),
        notes: z.string().nullable(),
      }),
    )
    .describe("Upkeep the house now needs because of this purchase (at most 3). Skip anything already in openUpkeepTasks."),
});

const SYSTEM = [
  "You keep a household's house-upkeep records. A member explained a purchase or cash withdrawal. Decide whether it concerns the house.",
  "If it does, add it to the house project history, record the equipment it bought or replaced and the routine upkeep that equipment needs, with sensible intervals (HVAC service yearly, water heater flush yearly, roof inspection every 2 years, gutter cleaning twice a year).",
  "Never repeat an upkeep task, equipment or house project that already exists (houseProjects); if this payment belongs to one of them, set project to null. Never invent facts the member did not give; leave unknown fields null.",
  "Car upkeep counts too: set vehicle to the car it was for, add it to the history like house work and suggest that car's next service only if it isn't already in openUpkeepTasks.",
  "Never include card, account, serial, VIN, plate or phone numbers or people's full names.",
].join(" ");

const iso = (d: Date) => d.toISOString().slice(0, 10);
const validDay = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null);

export type AnswerResult = { summary: string; changesetId: string | null };

export async function answerTransaction(user: HouseholdUser, transactionId: string, rawAnswer: string, now = new Date()): Promise<AnswerResult> {
  const ctx = contextFor(user, now);
  const legal = legalNamesFromEnv();
  const answer = scrubReferenceText(rawAnswer.trim().slice(0, MAX_ANSWER), legal);
  if (!answer) throw new Error("Type what it was for");
  const txn = await finance.reviewTransaction(ctx.viewer, transactionId);
  const today = iso(now);

  let plan: z.infer<typeof Plan> | null = null;
  let vehicles: Awaited<ReturnType<typeof maintenance.listVehicles>> = [];
  let aiError: string | null = null;
  try {
    const [tasks, equipment, projects] = await Promise.all([maintenance.listOpenTasks(), maintenance.listAssets(), maintenance.listProjects()]);
    vehicles = equipment.filter((x) => x.kind === "vehicle");
    plan = await runStructured({
      tier: "flagship",
      system: SYSTEM,
      task: "Plan the house records for this purchase.",
      payload: sanitizeReferencePayload(
        {
          today,
          purchase: { date: txn.date, merchant: txn.merchant, amount: Math.abs(txn.amount), category: finance.formatPair(txn) },
          memberAnswer: answer,
          openUpkeepTasks: tasks.map((x) => x.title),
          equipment: equipment.filter((x) => x.kind !== "vehicle").map((x) => x.name),
          // Nickname, make, model and year only: the app keeps no VIN or plate.
          vehicles: vehicles.map((v) => ({ name: v.name, make: v.make, model: v.model, year: v.year, mileage: v.mileage })),
          houseProjects: projects.slice(0, 60).map((x) => ({ title: x.title, date: x.date ?? x.period })),
        },
        legal,
      ),
      schema: Plan,
    });
  } catch (e) {
    aiError = e instanceof Error ? e.message.slice(0, 160) : "AI call failed";
  }

  const drafts = new DraftBook();
  const note = (plan?.note?.trim() || answer).slice(0, 120);
  const current = await adapterFor("transaction").get(ctx, transactionId);
  if (current) {
    const before = current.fields.notes as string | null;
    const notes = before && !before.includes(note) ? `${before} · ${note}`.slice(0, 500) : note;
    if (notes !== before) {
      drafts.add({ entity: "transaction", op: "update", key: transactionId, label: current.label, before: { notes: before }, after: { notes } });
    }
  }
  const vehicleId = plan?.vehicle ? (vehicles.find((v) => v.name.toLowerCase() === plan!.vehicle!.trim().toLowerCase())?.id ?? null) : null;
  if (plan?.houseRelated) {
    if (plan.project?.title.trim()) {
      const title = plan.project.title.trim().slice(0, 120);
      drafts.add({
        entity: "house_project",
        op: "create",
        key: null,
        label: `${title} (${txn.date})`,
        before: null,
        after: {
          date: txn.date,
          period: null,
          title,
          vendor: txn.merchant.slice(0, 120),
          description: scrubReferenceText(plan.project.description ?? answer, legal).slice(0, 1000) || null,
          amount: Math.abs(txn.amount),
          amountNote: null,
          transactionId,
          ...(vehicleId && { assetId: vehicleId }),
        },
      });
    }
    if (plan.equipment && plan.equipment.kind !== "vehicle") {
      const f = AssetFields.safeParse({
        name: plan.equipment.name.trim().slice(0, 80),
        kind: plan.equipment.kind,
        location: plan.equipment.location?.trim().slice(0, 60) || null,
        installedOn: validDay(plan.equipment.installedOn) ?? txn.date,
        cost: Math.abs(txn.amount),
        notes: scrubReferenceText(plan.equipment.notes ?? "", legal).slice(0, 500) || null,
      });
      if (f.success) drafts.add({ entity: "upkeep_asset", op: "create", key: null, label: f.data.name, before: null, after: f.data });
    }
    for (const task of plan.tasks.slice(0, 3)) {
      const due = validDay(task.firstDueDate);
      const f = UpkeepFields.safeParse({
        title: task.title.trim().slice(0, 120),
        dueDate: due && due >= today ? due : today,
        estimatedCost: task.estimatedCost != null && task.estimatedCost >= 0 ? Math.round(task.estimatedCost * 100) / 100 : null,
        recurrenceDays: task.repeatEveryDays && task.repeatEveryDays >= 1 && task.repeatEveryDays <= 3650 ? task.repeatEveryDays : null,
        notes: scrubReferenceText(task.notes ?? "", legal).slice(0, 1000) || null,
        ...(vehicleId && { assetId: vehicleId, area: "Vehicles" }),
      });
      if (f.success) drafts.add({ entity: "upkeep_task", op: "create", key: null, label: `${f.data.title} (due ${f.data.dueDate})`, before: null, after: f.data });
    }
  }

  const label = `Finance review: ${txn.merchant} ${txn.date} $${Math.abs(txn.amount).toFixed(2)}`;
  const changesetId = await recordChangeset(ctx, null, label, drafts.drafts);
  const added = drafts.drafts.filter((d) => d.entity !== "transaction").length;
  const summary = plan
    ? `${plan.summary.trim().slice(0, 240)}${added ? "" : plan.houseRelated ? " No new upkeep needed." : ""}`
    : `Saved your answer as the purchase's note. Claude couldn't be reached${aiError ? ` (${aiError})` : ""}, so add any upkeep on the Home maintenance page.`;
  const outcome = { summary, changesetId };
  await finance.recordLargePurchaseAnswer(ctx.viewer, transactionId, "answered", answer, outcome);
  return outcome;
}

/** The large-purchase step and the questionable-transactions tracker share one flow. */
export const answerLargePurchase = answerTransaction;
