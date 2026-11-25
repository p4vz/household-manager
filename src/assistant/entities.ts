import "server-only";
import { z } from "zod";
import type { OwnerLabel } from "@/core/auth/allowlist";
import * as family from "@/modules/family/api";
import * as finance from "@/modules/finance/api";
import * as maintenance from "@/modules/maintenance/api";
import * as trips from "@/modules/trips/api";

/**
 * Everything the assistant can change, one adapter per kind of row. Each
 * adapter goes through the owning module's api.ts (never its tables) and
 * exposes only fields a person could edit by hand in the app.
 *
 * Deliberately absent: moving money, account settings and ownership,
 * deleting accounts or transactions, bank connections, keys, settings,
 * assistant permissions, trips' booking codes and documents.
 */

export type AssistantCtx = {
  email: string;
  owner: OwnerLabel;
  viewer: finance.Viewer;
  now: Date;
};

export type Fields = Record<string, unknown>;

export type EntityAdapter = {
  entity: string;
  /** Shown in the change list: "Transaction", "Upkeep task". */
  title: string;
  /** Current editable fields, or null if the row is gone (or not visible to this member). */
  get(ctx: AssistantCtx, key: string): Promise<{ fields: Fields; label: string } | null>;
  update(ctx: AssistantCtx, key: string, patch: Fields): Promise<void>;
  create?(ctx: AssistantCtx, fields: Fields): Promise<string>;
  remove?(ctx: AssistantCtx, key: string): Promise<void>;
  /** Brings back a removed row from its snapshot. Returns its (possibly new) key. */
  restore?(ctx: AssistantCtx, key: string, snapshot: Fields): Promise<string>;
};

const text = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) => z.string().trim().max(max).nullable();
const day = z.iso.date();
const miles = z.number().int().min(0).max(2_000_000).nullable();

// ----------------------------------------------------------- finance ----

export const TransactionPatch = z
  .object({
    category: optText(60),
    subcategory: optText(60),
    notes: optText(500),
    isTransfer: z.boolean(),
  })
  .partial()
  .strict();

const transaction: EntityAdapter = {
  entity: "transaction",
  title: "Transaction",
  async get(ctx, key) {
    const row = (await finance.transactionsForEdit(ctx.viewer, [key])).get(key);
    if (!row) return null;
    const { label, ...fields } = row;
    return { fields, label };
  },
  async update(ctx, key, patch) {
    await finance.updateTransactionFields(ctx.viewer, key, TransactionPatch.parse(patch));
  },
};

export const MerchantRuleFields = z.object({ category: text(60), subcategory: optText(60) }).strict();

const merchantRule: EntityAdapter = {
  entity: "merchant_rule",
  title: "Category rule",
  async get(_ctx, key) {
    const rule = await finance.getMerchantRule(key);
    return rule ? { fields: { merchant: key, ...rule }, label: `Rule for ${key}` } : null;
  },
  async update(_ctx, key, patch) {
    const current = await finance.getMerchantRule(key);
    const rest = { ...patch };
    delete rest.merchant;
    await finance.setMerchantRule(key, MerchantRuleFields.parse({ ...current, ...rest }));
  },
  async create(_ctx, fields) {
    // The key is the merchant, passed in with the fields.
    const { merchant, ...rule } = fields as { merchant: string } & Fields;
    await finance.setMerchantRule(merchant, MerchantRuleFields.parse(rule));
    return merchant;
  },
  async remove(_ctx, key) {
    await finance.deleteMerchantRule(key);
  },
  async restore(_ctx, key, snapshot) {
    const rule = { ...snapshot };
    delete rule.merchant;
    await finance.setMerchantRule(key, MerchantRuleFields.parse(rule));
    return key;
  },
};

// ------------------------------------------------------- maintenance ----

export const UpkeepFields = z
  .object({
    title: text(120),
    dueDate: day,
    estimatedCost: z.number().min(0).max(1_000_000).nullable(),
    recurrenceDays: z.number().int().min(1).max(3650).nullable(),
    notes: optText(1000),
    area: optText(60),
    parts: optText(300),
    lastDoneOn: day.nullable(),
    assetId: z.uuid().nullable(),
    dueMileage: miles,
    recurrenceMiles: miles,
    lastDoneMileage: miles,
  })
  .partial({ area: true, parts: true, lastDoneOn: true, assetId: true, dueMileage: true, recurrenceMiles: true, lastDoneMileage: true })
  .strict();

const upkeepTask: EntityAdapter = {
  entity: "upkeep_task",
  title: "Upkeep task",
  async get(_ctx, key) {
    const t = await maintenance.getTask(key);
    if (!t) return null;
    return {
      fields: {
        title: t.title,
        dueDate: t.dueDate,
        estimatedCost: t.estimatedCost,
        recurrenceDays: t.recurrenceDays,
        notes: t.notes,
        area: t.area,
        parts: t.parts,
        lastDoneOn: t.lastDoneOn,
        assetId: t.assetId,
        dueMileage: t.dueMileage,
        recurrenceMiles: t.recurrenceMiles,
        lastDoneMileage: t.lastDoneMileage,
      },
      label: `${t.title} (due ${t.dueDate}${t.completedOn ? `, done ${t.completedOn}` : ""})`,
    };
  },
  async update(_ctx, key, patch) {
    await maintenance.updateTask(key, UpkeepFields.partial().parse(patch));
  },
  async create(_ctx, fields) {
    return maintenance.scheduleTask(UpkeepFields.parse(fields));
  },
  async remove(_ctx, key) {
    const t = await maintenance.getTask(key);
    if (t?.completedOn) throw new Error("Completed tasks are kept as history and can't be deleted");
    await maintenance.deleteTask(key);
  },
  async restore(_ctx, _key, snapshot) {
    return maintenance.scheduleTask(UpkeepFields.parse(snapshot));
  },
};

export const AssetFields = z
  .object({
    name: text(80),
    kind: z.enum(maintenance.ASSET_KINDS),
    location: optText(60),
    installedOn: day.nullable(),
    cost: z.number().min(0).max(1_000_000).nullable(),
    notes: optText(500),
    make: optText(40),
    model: optText(60),
    year: z.number().int().min(1950).max(2100).nullable(),
    mileage: miles,
    mileageOn: day.nullable(),
  })
  .partial({ make: true, model: true, year: true, mileage: true, mileageOn: true })
  .strict();

const upkeepAsset: EntityAdapter = {
  entity: "upkeep_asset",
  title: "Home equipment",
  async get(_ctx, key) {
    const a = await maintenance.getAsset(key);
    if (!a) return null;
    return {
      fields: {
        name: a.name,
        kind: a.kind,
        location: a.location,
        installedOn: a.installedOn,
        cost: a.cost,
        notes: a.notes,
        make: a.make,
        model: a.model,
        year: a.year,
        mileage: a.mileage,
        mileageOn: a.mileageOn,
      },
      label: a.name,
    };
  },
  async update(_ctx, key, patch) {
    await maintenance.updateAsset(key, AssetFields.partial().parse(patch));
  },
  async create(_ctx, fields) {
    return maintenance.addAsset(AssetFields.parse({ location: null, installedOn: null, cost: null, notes: null, ...fields }));
  },
  async remove(_ctx, key) {
    await maintenance.deleteAsset(key);
  },
  async restore(ctx, _key, snapshot) {
    return this.create!(ctx, snapshot);
  },
};

export const ProjectFields = z
  .object({
    date: day.nullable(),
    period: optText(40),
    title: text(120),
    vendor: optText(120),
    description: optText(1000),
    amount: z.number().min(0).max(10_000_000).nullable(),
    amountNote: optText(60),
    assetId: z.uuid().nullable(),
  })
  .partial({ assetId: true })
  .strict();

/** House project and expense history. The linked transaction is kept as is and never shown here. */
const houseProject: EntityAdapter = {
  entity: "house_project",
  title: "House project",
  async get(_ctx, key) {
    const p = await maintenance.getProject(key);
    if (!p) return null;
    return {
      fields: {
        date: p.date,
        period: p.period,
        title: p.title,
        vendor: p.vendor,
        description: p.description,
        amount: p.amount,
        amountNote: p.amountNote,
        assetId: p.assetId,
      },
      label: `${p.title}${p.date ? ` (${p.date})` : p.period ? ` (${p.period})` : ""}`,
    };
  },
  async update(_ctx, key, patch) {
    await maintenance.updateProject(key, ProjectFields.partial().parse(patch));
  },
  async create(_ctx, fields) {
    const { transactionId, ...rest } = fields as Fields & { transactionId?: string };
    const f = ProjectFields.parse({ date: null, period: null, vendor: null, description: null, amount: null, amountNote: null, ...rest });
    return maintenance.addProject({ ...f, transactionId: typeof transactionId === "string" ? transactionId : null });
  },
  async remove(_ctx, key) {
    await maintenance.deleteProject(key);
  },
  async restore(ctx, _key, snapshot) {
    return this.create!(ctx, snapshot);
  },
};

// ------------------------------------------------------------ family ----

export const ShoppingFields = z
  .object({
    name: text(80),
    store: text(40),
    quantity: optText(20),
    checked: z.boolean(),
    /** List name; a new item goes to the first active list when no list has this name. */
    list: optText(60),
  })
  .strict();

const shoppingItem: EntityAdapter = {
  entity: "shopping_item",
  title: "Shopping item",
  async get(_ctx, key) {
    const i = await family.getShoppingItem(key);
    if (!i) return null;
    const fields: Fields = { name: i.name, store: i.store, quantity: i.quantity, checked: i.checked, list: i.list };
    return { fields, label: `${i.name} (${i.store})` };
  },
  async update(ctx, key, patch) {
    // Moving an item to another list is not an assistant edit; the list field is ignored here.
    const { list: _list, ...rest } = ShoppingFields.partial().parse(patch);
    void _list;
    await family.updateShoppingItem(key, rest, ctx.now);
  },
  async create(ctx, fields) {
    const f = ShoppingFields.parse({ checked: false, quantity: null, list: null, ...fields });
    const id = await family.addShoppingItem({ name: f.name, store: f.store, quantity: f.quantity, list: f.list }, ctx.now);
    if (f.checked) await family.updateShoppingItem(id, { checked: true }, ctx.now);
    return id;
  },
  async remove(_ctx, key) {
    await family.deleteShoppingItem(key);
  },
  async restore(ctx, _key, snapshot) {
    return this.create!(ctx, snapshot);
  },
};

export const ReturnFields = z
  .object({
    itemName: text(80),
    store: text(40),
    returnDeadline: day.nullable(),
    notes: optText(300),
    status: z.enum(family.RETURN_STATUSES),
  })
  .strict();

const purchaseReturn: EntityAdapter = {
  entity: "purchase_return",
  title: "Return",
  async get(_ctx, key) {
    const r = await family.getReturn(key);
    if (!r) return null;
    return {
      fields: { itemName: r.itemName, store: r.store, returnDeadline: r.returnDeadline, notes: r.notes, status: r.status },
      label: `${r.itemName} (${r.store})`,
    };
  },
  async update(ctx, key, patch) {
    await family.updateReturn(key, ReturnFields.partial().parse(patch), ctx.now);
  },
  async create(ctx, fields) {
    const f = ReturnFields.parse({ status: "pending", returnDeadline: null, notes: null, ...fields });
    const id = await family.addReturn(f);
    if (f.status !== "pending") await family.setReturnStatus(id, f.status, ctx.now);
    return id;
  },
  async remove(_ctx, key) {
    await family.deleteReturn(key);
  },
  async restore(ctx, _key, snapshot) {
    return this.create!(ctx, snapshot);
  },
};

export const ChoreFields = z.object({ done: z.boolean() }).strict();

/** Chores: tick or untick for the current period; "delete" archives (history stays). */
const chore: EntityAdapter = {
  entity: "chore",
  title: "Chore",
  async get(ctx, key) {
    const c = await family.getChore(key, ctx.now);
    if (!c || c.archived) return null;
    return { fields: { done: c.done }, label: `${c.kidName}: ${c.title}` };
  },
  async update(ctx, key, patch) {
    const { done } = ChoreFields.parse(patch);
    if (done) await family.completeChore(key, ctx.now);
    else await family.undoChore(key, ctx.now);
  },
  async remove(ctx, key) {
    await family.archiveChore(key, ctx.now);
  },
  async restore(_ctx, key) {
    await family.unarchiveChore(key);
    return key;
  },
};

// ------------------------------------------------------------- trips ----

/**
 * Which trip a bank charge belongs to. Keyed by the transaction; `trip` is
 * the trip's slug, `step` the itinerary step's title on that trip, and
 * `link` is "linked", "dismissed" (not this trip) or null (not reviewed).
 */
export const TripChargeFields = z
  .object({
    trip: z.string().trim().min(1).max(120).nullable(),
    step: optText(200),
    link: z.enum(["linked", "dismissed"]).nullable(),
  })
  .strict();

const tripCharge: EntityAdapter = {
  entity: "trip_charge",
  title: "Trip charge",
  async get(ctx, key) {
    const row = await trips.tripChargeLink(ctx.viewer, key);
    if (!row) return null;
    const link = row.link;
    if (!link) return { fields: { trip: null, step: null, link: null }, label: row.label };
    const info = await trips.tripLinkInfo(link.targetId, link.detailId);
    return { fields: { trip: info.slug, step: info.step, link: link.status }, label: row.label };
  },
  async update(ctx, key, patch) {
    const current = (await this.get(ctx, key))?.fields ?? {};
    const f = TripChargeFields.parse({ ...current, ...patch });
    if (!f.link || !f.trip) {
      await trips.unlinkTripCharges(ctx.viewer, [key]);
      return;
    }
    const target = await trips.resolveTripStep(f.trip, f.link === "linked" ? f.step : null);
    if (f.link === "dismissed") await trips.dismissTripCharges(ctx.viewer, target.tripId, [key], "assistant");
    else await trips.linkTripCharges(ctx.viewer, target.tripId, [key], { stepId: target.stepId, source: "assistant" });
  },
};

export const ADAPTERS: Record<string, EntityAdapter> = Object.fromEntries(
  [transaction, merchantRule, upkeepTask, upkeepAsset, houseProject, shoppingItem, purchaseReturn, chore, tripCharge].map((a) => [a.entity, a]),
);

export function adapterFor(entity: string): EntityAdapter {
  const a = ADAPTERS[entity];
  if (!a) throw new Error(`Unknown kind of change: ${entity}`);
  return a;
}

/** Same values, ignoring key order, undefined vs null and number formatting. */
export function sameFields(current: Fields, expected: Fields): boolean {
  return Object.keys(expected).every((k) => norm(current[k]) === norm(expected[k]));
}

function norm(v: unknown): string {
  if (v === undefined || v === null || v === "") return "null";
  if (typeof v === "number") return String(Math.round(v * 100) / 100);
  return JSON.stringify(v);
}
