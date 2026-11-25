"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { addTransactionToHouse, categorizeQuestion, linkTransactionToProject, runHouseAudit } from "@/assistant/house-audit";
import { answerTransaction } from "@/assistant/review";
import { authedAction } from "@/core/actions/authed-action";
import { UnauthorizedError } from "@/core/auth/guard";
import { householdToday } from "@/modules/family/ui/dates";
import { recordLargePurchaseAnswer, viewerFromLabel } from "@/modules/finance/api";
import {
  ASSET_KINDS,
  addAsset,
  addProject,
  addVehicle,
  getAsset,
  updateAsset,
  checkAssetRecalls,
  completeTask,
  deleteAsset,
  deleteProject,
  deleteTask,
  scheduleTask,
  updateProject,
  updateTask,
} from "@/modules/maintenance/api";

/** Home maintenance actions. Each reports back through ?m= and jumps to its section. */

const PAGE = "/maintenance";

function refresh() {
  revalidatePath(PAGE);
  revalidatePath("/kiosk");
  revalidatePath("/family");
  revalidatePath("/finance/review");
}

async function done(anchor: string, work: () => Promise<string>): Promise<never> {
  let message: string;
  try {
    message = await work();
  } catch (e) {
    if (e instanceof UnauthorizedError) throw e;
    message = `Couldn't do that: ${e instanceof Error ? e.message : "unknown error"}`;
  }
  refresh();
  redirect(`${PAGE}?m=${encodeURIComponent(message.slice(0, 300))}#${anchor}`);
}

const blankToNull = (v: unknown) => (v === "" || v == null ? null : v);
const optNumber = z.preprocess((v) => (blankToNull(v) == null ? null : Number(v)), z.number().nonnegative().nullable());
const optDays = z.preprocess((v) => (blankToNull(v) == null ? null : Number(v)), z.number().int().min(1).max(3650).nullable());
const optDay = z.preprocess(blankToNull, z.iso.date().nullable());
const optMiles = z.preprocess((v) => (blankToNull(v) == null ? null : Number(String(v).replace(/,/g, ""))), z.number().int().min(0).max(2_000_000).nullable());
const optId = z.preprocess(blankToNull, z.uuid().nullable());
const today = () => householdToday();
const optText = (max: number) => z.preprocess((v) => (typeof v === "string" ? v.trim() || null : null), z.string().max(max).nullable());
const fields = (form: FormData, names: string[]) => Object.fromEntries(names.map((n) => [n, form.get(n)]));

// ------------------------------------------------------------- action items ----

const TaskInput = z.object({
  title: z.string().trim().min(1).max(120),
  dueDate: z.iso.date(),
  recurrenceDays: optDays,
  estimatedCost: optNumber,
  notes: optText(1000),
  area: optText(60),
  parts: optText(300),
  lastDoneOn: optDay,
  assetId: optId,
  dueMileage: optMiles,
  recurrenceMiles: optMiles,
});
const TASK_FIELDS = ["title", "dueDate", "recurrenceDays", "estimatedCost", "notes", "area", "parts", "lastDoneOn", "assetId", "dueMileage", "recurrenceMiles"];

export const scheduleTaskAction = authedAction(TaskInput, async (input) => {
  await scheduleTask(input);
  return `Added "${input.title}".`;
});
export async function addTaskFormAction(form: FormData) {
  return done("items", () => scheduleTaskAction(fields(form, TASK_FIELDS)));
}

const editTask = authedAction(TaskInput.extend({ taskId: z.uuid() }), async ({ taskId, ...input }) => {
  await updateTask(taskId, input);
  return `Saved "${input.title}".`;
});
export async function updateTaskFormAction(form: FormData) {
  return done("items", () => editTask(fields(form, [...TASK_FIELDS, "taskId"])));
}

export const completeTaskAction = authedAction(
  z.object({ taskId: z.uuid(), date: z.iso.date(), actualCost: optNumber, mileage: optMiles.optional() }),
  async ({ taskId, date, actualCost, mileage }) => {
    const { nextTaskId } = await completeTask(taskId, { date, actualCost, mileage: mileage ?? null });
    return nextTaskId ? "Marked done. The next one is scheduled." : "Marked done.";
  },
);
export async function completeTaskFormAction(form: FormData) {
  return done("items", () => completeTaskAction(fields(form, ["taskId", "date", "actualCost", "mileage"])));
}

export const deleteTaskAction = authedAction(z.object({ taskId: z.uuid() }), async ({ taskId }) => {
  await deleteTask(taskId);
  return "Removed.";
});
export async function deleteTaskFormAction(form: FormData) {
  return done("items", () => deleteTaskAction(fields(form, ["taskId"])));
}

// -------------------------------------------------------------- equipment ----

const AssetInput = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(ASSET_KINDS),
  location: optText(60),
  installedOn: optDay,
  cost: optNumber,
  notes: optText(500),
});
const addAssetAction = authedAction(AssetInput, async (input) => {
  await addAsset(input);
  return `Added ${input.name}.`;
});
export async function addAssetFormAction(form: FormData) {
  return done("equipment", () => addAssetAction(fields(form, ["name", "kind", "location", "installedOn", "cost", "notes"])));
}

const removeAsset = authedAction(z.object({ id: z.uuid() }), async ({ id }) => {
  await deleteAsset(id);
  return "Removed.";
});
export async function deleteAssetFormAction(form: FormData) {
  return done("equipment", () => removeAsset(fields(form, ["id"])));
}

const recalls = authedAction(z.object({ id: z.uuid() }), async ({ id }) => {
  const hits = await checkAssetRecalls(id);
  return hits.length ? `Found ${hits.length} ${hits.length === 1 ? "recall" : "recalls"} to look at.` : "No recalls found for it.";
});
export async function checkRecallsFormAction(form: FormData) {
  return done(form.get("anchor") === "vehicles" ? "vehicles" : "equipment", () => recalls(fields(form, ["id"])));
}

// --------------------------------------------------------------- vehicles ----

/** No VIN or plate fields: the app keeps neither. */
const VehicleInput = z.object({
  name: z.string().trim().min(1).max(80),
  make: optText(40),
  model: optText(60),
  year: z.preprocess((v) => (blankToNull(v) == null ? null : Number(v)), z.number().int().min(1950).max(2100).nullable()),
  mileage: optMiles,
});
const VEHICLE_FIELDS = ["name", "make", "model", "year", "mileage"];

const addVehicleAction = authedAction(VehicleInput.extend({ standardItems: z.boolean() }), async ({ standardItems, ...input }) => {
  await addVehicle(input, { standardItems, today: today() });
  return standardItems ? `Added ${input.name} with oil change, inspection, registration and tire rotation items. Set their real due dates.` : `Added ${input.name}.`;
});
export async function addVehicleFormAction(form: FormData) {
  return done("vehicles", () => addVehicleAction({ ...fields(form, VEHICLE_FIELDS), standardItems: form.get("standardItems") === "on" }));
}

const editVehicle = authedAction(VehicleInput.extend({ id: z.uuid() }), async ({ id, ...input }) => {
  const before = await getAsset(id);
  if (before?.kind !== "vehicle") throw new Error("Car not found");
  await updateAsset(id, { ...input, ...(input.mileage !== before.mileage && { mileageOn: input.mileage == null ? null : today() }) });
  return `Saved ${input.name}.`;
});
export async function updateVehicleFormAction(form: FormData) {
  return done("vehicles", () => editVehicle(fields(form, [...VEHICLE_FIELDS, "id"])));
}

const mileage = authedAction(z.object({ id: z.uuid(), mileage: optMiles }), async ({ id, mileage }) => {
  const v = await getAsset(id);
  if (v?.kind !== "vehicle") throw new Error("Car not found");
  if (mileage == null) throw new Error("Type the odometer reading");
  await updateAsset(id, { mileage, mileageOn: today() });
  return `${v.name}: ${mileage.toLocaleString("en-US")} miles.`;
});
export async function updateMileageFormAction(form: FormData) {
  return done("vehicles", () => mileage(fields(form, ["id", "mileage"])));
}

const removeVehicle = authedAction(z.object({ id: z.uuid() }), async ({ id }) => {
  await deleteAsset(id);
  return "Removed the car and its open items. Its service history stays in the house history.";
});
export async function deleteVehicleFormAction(form: FormData) {
  return done("vehicles", () => removeVehicle(fields(form, ["id"])));
}

// --------------------------------------------------------- project history ----

const ProjectInput = z.object({
  date: optDay,
  period: optText(40),
  title: z.string().trim().min(1).max(120),
  vendor: optText(120),
  description: optText(1000),
  amount: optNumber,
  amountNote: optText(60),
  assetId: optId.optional(),
});
const PROJECT_FIELDS = ["date", "period", "title", "vendor", "description", "amount", "amountNote"];

const addProjectAction = authedAction(ProjectInput, async (input) => {
  await addProject(input);
  return `Added "${input.title}" to the house history.`;
});
export async function addProjectFormAction(form: FormData) {
  const anchor = form.get("assetId") ? "vehicles" : "history";
  return done(anchor, () => addProjectAction(fields(form, [...PROJECT_FIELDS, "assetId"])));
}

const editProject = authedAction(ProjectInput.extend({ id: z.uuid() }), async ({ id, ...input }) => {
  await updateProject(id, input);
  return `Saved "${input.title}".`;
});
export async function updateProjectFormAction(form: FormData) {
  return done("history", () => editProject(fields(form, [...PROJECT_FIELDS, "id"])));
}

const removeProject = authedAction(z.object({ id: z.uuid() }), async ({ id }) => {
  await deleteProject(id);
  return "Removed from the house history.";
});
export async function deleteProjectFormAction(form: FormData) {
  return done("history", () => removeProject(fields(form, ["id"])));
}

const unlinkProject = authedAction(z.object({ id: z.uuid() }), async ({ id }) => {
  await updateProject(id, { transactionId: null });
  return "Unlinked the payment.";
});
export async function unlinkProjectFormAction(form: FormData) {
  return done("history", () => unlinkProject(fields(form, ["id"])));
}

// ------------------------------------------------ questionable transactions ----

const audit = authedAction(z.object({}), async (_i, user) => (await runHouseAudit(viewerFromLabel(user.owner))).note);
export async function runAuditFormAction() {
  return done("questions", () => audit({}));
}

const answer = authedAction(z.object({ id: z.uuid(), answer: z.string().trim().min(1).max(500) }), async ({ id, answer }, user) =>
  (await answerTransaction(user, id, answer)).summary,
);
export async function answerQuestionFormAction(form: FormData) {
  return done("questions", () => answer(fields(form, ["id", "answer"])));
}

const addToHouse = authedAction(z.object({ id: z.uuid(), title: z.string().max(120), vehicleId: optId }), ({ id, title, vehicleId }, user) =>
  addTransactionToHouse(user, id, title, new Date(), vehicleId),
);
export async function addToHouseFormAction(form: FormData) {
  return done("questions", () => addToHouse({ id: form.get("id"), title: form.get("title") ?? "", vehicleId: form.get("vehicleId") }));
}

const link = authedAction(z.object({ id: z.uuid(), projectId: z.uuid() }), ({ id, projectId }, user) => linkTransactionToProject(user, id, projectId));
export async function linkToProjectFormAction(form: FormData) {
  return done("questions", () => link(fields(form, ["id", "projectId"])));
}

const categorize = authedAction(z.object({ id: z.uuid(), category: z.string().trim().min(1).max(130) }), ({ id, category }, user) =>
  categorizeQuestion(user, id, category),
);
export async function categorizeQuestionFormAction(form: FormData) {
  return done("questions", () => categorize(fields(form, ["id", "category"])));
}

const skip = authedAction(z.object({ id: z.uuid() }), async ({ id }, user) => {
  await recordLargePurchaseAnswer(viewerFromLabel(user.owner), id, "dismissed", null, { summary: "Not a house expense", changesetId: null });
  return "Skipped: not a house expense.";
});
export async function skipQuestionFormAction(form: FormData) {
  return done("questions", () => skip(fields(form, ["id"])));
}
