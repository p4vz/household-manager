import "server-only";
import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { openBytes, sealBytes, vaultConfigured } from "@/core/secrets/file-vault";
import { BINDER_CATEGORIES, BINDER_CATEGORY_LABELS, maintenanceDocuments, type BinderCategory } from "./schema";

export { BINDER_CATEGORIES, BINDER_CATEGORY_LABELS, type BinderCategory };
export { vaultConfigured as binderVaultConfigured };

/** Same limit as trip documents: enough for a scanned manual or policy. */
export const MAX_BINDER_FILE_BYTES = 8 * 1024 * 1024;
export const BINDER_PAGE = "/maintenance/binder";

export type BinderFile = { fileName: string; mediaType: string; bytes: Buffer };

export type BinderInput = {
  category: BinderCategory;
  title: string;
  provider?: string | null;
  assetId?: string | null;
  projectId?: string | null;
  startsOn?: string | null;
  expiresOn?: string | null;
  amount?: number | null;
  url?: string | null;
  notes?: string | null;
};

/**
 * What the reminder for a dated document says, and how many days ahead of the
 * date it is due. Manuals, receipts and "other" get no reminder.
 */
const REMINDERS: Partial<Record<BinderCategory, { daysBefore: number; title: (t: string) => string; notes: string }>> = {
  warranty: { daysBefore: 30, title: (t) => `Warranty ends soon: ${t}`, notes: "Get anything covered looked at before the warranty ends." },
  insurance: { daysBefore: 30, title: (t) => `Insurance renews: ${t}`, notes: "Check the renewal price and coverage; shop around if it went up." },
  property_tax: { daysBefore: 14, title: (t) => `Property tax due: ${t}`, notes: "Pay before the due date (check for the discount period)." },
};

/** The reminder's due date: `daysBefore` ahead of the date, but not before today. Null when the date has passed. */
export function reminderDueDate(category: BinderCategory, expiresOn: string | null | undefined, today: string): string | null {
  const r = REMINDERS[category];
  if (!r || !expiresOn || expiresOn < today) return null;
  const d = new Date(`${expiresOn}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - r.daysBefore);
  const due = d.toISOString().slice(0, 10);
  return due < today ? today : due;
}

/** Hooks into the task list without importing api.ts (which re-exports this file). */
export type ReminderTasks = {
  schedule(input: { title: string; dueDate: string; notes: string; area: string; assetId: string | null }): Promise<string>;
  remove(taskId: string): Promise<void>;
  isOpen(taskId: string): Promise<boolean>;
};

async function syncReminder(id: string, tasks: ReminderTasks, today: string) {
  const [doc] = await db().select().from(maintenanceDocuments).where(eq(maintenanceDocuments.id, id));
  if (!doc) return;
  if (doc.reminderTaskId && (await tasks.isOpen(doc.reminderTaskId))) await tasks.remove(doc.reminderTaskId);
  const due = reminderDueDate(doc.category, doc.expiresOn, today);
  let reminderTaskId: string | null = null;
  if (due) {
    const r = REMINDERS[doc.category]!;
    reminderTaskId = await tasks.schedule({
      title: r.title(doc.title),
      dueDate: due,
      notes: `${r.notes} Date: ${doc.expiresOn}. See the home binder.`,
      area: "Home binder",
      assetId: doc.assetId,
    });
  }
  await db().update(maintenanceDocuments).set({ reminderTaskId }).where(eq(maintenanceDocuments.id, id));
}

function sealFile(file: BinderFile | null | undefined) {
  if (!file) return {};
  if (!vaultConfigured()) throw new Error("Set DOC_VAULT_KEY before uploading files. Entries without a file work without it.");
  if (file.bytes.length === 0) throw new Error("The file is empty");
  if (file.bytes.length > MAX_BINDER_FILE_BYTES) throw new Error("That file is larger than 8 MB. Store a compressed scan instead.");
  const sealed = sealBytes(file.bytes);
  return {
    fileName: cleanFileName(file.fileName),
    mimeType: file.mediaType || "application/octet-stream",
    sizeBytes: file.bytes.length,
    ...sealed,
  };
}

/** Keeps a readable name; drops any path. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop()?.trim() ?? "";
  return (base || "document").slice(0, 120);
}

const clean = (input: Partial<BinderInput>) =>
  Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<BinderInput>;

export async function addDocument(
  input: BinderInput,
  file: BinderFile | null,
  addedBy: "user1" | "user2" | null,
  tasks: ReminderTasks,
  today: string,
): Promise<string> {
  const [row] = await db()
    .insert(maintenanceDocuments)
    .values({ ...clean(input), category: input.category, title: input.title, ...sealFile(file), addedBy })
    .returning({ id: maintenanceDocuments.id });
  await syncReminder(row.id, tasks, today);
  return row.id;
}

export async function updateDocument(id: string, patch: Partial<BinderInput>, file: BinderFile | null, tasks: ReminderTasks, today: string) {
  const set = { ...clean(patch), ...sealFile(file) };
  if (Object.keys(set).length) await db().update(maintenanceDocuments).set(set).where(eq(maintenanceDocuments.id, id));
  await syncReminder(id, tasks, today);
}

export async function deleteDocument(id: string, tasks: ReminderTasks) {
  const [doc] = await db().delete(maintenanceDocuments).where(eq(maintenanceDocuments.id, id)).returning();
  if (doc?.reminderTaskId && (await tasks.isOpen(doc.reminderTaskId))) await tasks.remove(doc.reminderTaskId);
}

/** Everything but the encrypted bytes. */
const listColumns = {
  id: maintenanceDocuments.id,
  category: maintenanceDocuments.category,
  title: maintenanceDocuments.title,
  provider: maintenanceDocuments.provider,
  assetId: maintenanceDocuments.assetId,
  projectId: maintenanceDocuments.projectId,
  startsOn: maintenanceDocuments.startsOn,
  expiresOn: maintenanceDocuments.expiresOn,
  amount: maintenanceDocuments.amount,
  url: maintenanceDocuments.url,
  notes: maintenanceDocuments.notes,
  fileName: maintenanceDocuments.fileName,
  sizeBytes: maintenanceDocuments.sizeBytes,
  hasFile: sql<boolean>`${maintenanceDocuments.cipherText} is not null`,
  reminderTaskId: maintenanceDocuments.reminderTaskId,
  addedBy: maintenanceDocuments.addedBy,
  createdAt: maintenanceDocuments.createdAt,
};

export async function listDocuments() {
  return db().select(listColumns).from(maintenanceDocuments).orderBy(asc(maintenanceDocuments.category), asc(maintenanceDocuments.title));
}

export async function getDocument(id: string) {
  const [row] = await db().select(listColumns).from(maintenanceDocuments).where(eq(maintenanceDocuments.id, id));
  return row ?? null;
}

/** Warranties, policies and tax bills dated on or before `through` (and not long gone), soonest first. */
export async function expiringDocuments(from: string, through: string) {
  return db()
    .select(listColumns)
    .from(maintenanceDocuments)
    .where(and(isNotNull(maintenanceDocuments.expiresOn), lte(maintenanceDocuments.expiresOn, through), sql`${maintenanceDocuments.expiresOn} >= ${from}`))
    .orderBy(asc(maintenanceDocuments.expiresOn));
}

/** Decrypts one file for the signed-in member who asked for it. */
export async function openDocumentFile(id: string) {
  const [doc] = await db().select().from(maintenanceDocuments).where(eq(maintenanceDocuments.id, id));
  if (!doc) throw new Error("Document not found");
  if (!doc.cipherText || !doc.iv || !doc.authTag) throw new Error("This entry has no file attached");
  const bytes = openBytes({ cipherText: Buffer.from(doc.cipherText), iv: Buffer.from(doc.iv), authTag: Buffer.from(doc.authTag) });
  return { filename: doc.fileName ?? "document", mimeType: doc.mimeType ?? "application/octet-stream", base64: bytes.toString("base64") };
}

/** Unlinks documents from equipment or a project that is being removed. */
export async function unlinkDocuments(link: { assetId?: string; projectId?: string }) {
  if (link.assetId) await db().update(maintenanceDocuments).set({ assetId: null }).where(eq(maintenanceDocuments.assetId, link.assetId));
  if (link.projectId) await db().update(maintenanceDocuments).set({ projectId: null }).where(eq(maintenanceDocuments.projectId, link.projectId));
}
