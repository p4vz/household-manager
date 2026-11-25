import "server-only";
import { z } from "zod";
import type { OwnerLabel } from "@/core/auth/allowlist";
import * as calendar from "@/modules/calendar/api";
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
  /** The member's email, or KITCHEN_OWNER for the kitchen screen. Changesets are owned by it. */
  email: string;
  owner: OwnerLabel;
  /** Whose finance view applies. The kitchen screen has none: reading it throws. */
  viewer: finance.Viewer;
  now: Date;
  /** "kitchen": Ask Claude on the kitchen screen (adult mode), limited to KITCHEN_ENTITIES. */
  surface?: "app" | "kitchen";
};

/** Owner of changesets made on the kitchen screen. Members see and can undo them too. */
export const KITCHEN_OWNER = "kitchen-screen";

/** What Ask Claude on the kitchen screen may change (the kiosk's own modules). */
export const KITCHEN_ENTITIES: ReadonlySet<string> = new Set([
  "chore",
  "chore_goal",
  "reading_entry",
  "shopping_item",
  "shopping_list",
  "shopping_template",
  "purchase_return",
  "calendar_event",
  "upkeep_task",
]);

/** On the kitchen screen only calendar events can be deleted (adult mode), as with the screen's own buttons. */
export const KITCHEN_DELETABLE: ReadonlySet<string> = new Set(["calendar_event"]);

export function kitchenContext(now = new Date()): AssistantCtx {
  const ctx = { email: KITCHEN_OWNER, owner: "User 1" as OwnerLabel, now, surface: "kitchen" as const };
  return Object.defineProperty(ctx, "viewer", {
    enumerable: false,
    get() {
      throw new Error("Money and accounts are not available on the kitchen screen.");
    },
  }) as AssistantCtx;
}

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
        completedOn: t.completedOn,
        actualCost: t.actualCost,
      },
      label: `${t.title} (due ${t.dueDate}${t.completedOn ? `, done ${t.completedOn}` : ""})`,
    };
  },
  /**
   * completedOn set: marks it done (with actualCost and lastDoneMileage as the
   * cost and odometer reading), which schedules the next one if it repeats.
   * completedOn null on a done task: reopens it and removes that next one.
   */
  async update(_ctx, key, patch) {
    const rest = { ...patch };
    const completedOn = rest.completedOn as string | null | undefined;
    const actualCost = rest.actualCost as number | null | undefined;
    delete rest.completedOn;
    delete rest.actualCost;
    const t = await maintenance.getTask(key);
    if (!t) throw new Error("Task not found");
    if (completedOn && !t.completedOn) {
      const mileage = rest.lastDoneMileage as number | null | undefined;
      delete rest.lastDoneMileage;
      await maintenance.completeTask(key, { date: day.parse(completedOn), actualCost: actualCost ?? null, mileage: mileage ?? null });
    } else if (completedOn === null && t.completedOn) {
      await maintenance.reopenTask(key);
    }
    if (Object.keys(rest).length) await maintenance.updateTask(key, UpkeepFields.partial().parse(rest));
  },
  async create(_ctx, fields) {
    return maintenance.scheduleTask(UpkeepFields.parse(withoutDone(fields)));
  },
  async remove(_ctx, key) {
    const t = await maintenance.getTask(key);
    if (t?.completedOn) throw new Error("Completed tasks are kept as history and can't be deleted");
    await maintenance.deleteTask(key);
  },
  async restore(_ctx, _key, snapshot) {
    return maintenance.scheduleTask(UpkeepFields.parse(withoutDone(snapshot)));
  },
};

function withoutDone(fields: Fields): Fields {
  const f = { ...fields };
  delete f.completedOn;
  delete f.actualCost;
  return f;
}

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

export const BinderFields = z
  .object({
    category: z.enum(maintenance.BINDER_CATEGORIES),
    title: text(120),
    provider: optText(120),
    assetId: z.uuid().nullable(),
    projectId: z.uuid().nullable(),
    startsOn: day.nullable(),
    expiresOn: day.nullable(),
    amount: z.number().min(0).max(10_000_000).nullable(),
    url: z.url({ protocol: /^https?$/ }).max(500).nullable(),
    notes: optText(1000),
  })
  .strict();

/** Home binder entries (manuals, warranties, insurance, property tax). Files are added in the app, never here. */
const binderEntry: EntityAdapter = {
  entity: "binder_entry",
  title: "Home binder",
  async get(_ctx, key) {
    const d = await maintenance.getBinderEntry(key);
    if (!d) return null;
    return {
      fields: {
        category: d.category,
        title: d.title,
        provider: d.provider,
        assetId: d.assetId,
        projectId: d.projectId,
        startsOn: d.startsOn,
        expiresOn: d.expiresOn,
        amount: d.amount,
        url: d.url,
        notes: d.notes,
      },
      label: d.title,
    };
  },
  async update(_ctx, key, patch) {
    await maintenance.updateBinderEntry(key, BinderFields.partial().parse(patch));
  },
  async create(ctx, fields) {
    const f = BinderFields.parse({ provider: null, assetId: null, projectId: null, startsOn: null, expiresOn: null, amount: null, url: null, notes: null, ...fields });
    return maintenance.addBinderEntry(f, null, ctx.surface === "kitchen" ? null : ctx.viewer);
  },
  async remove(_ctx, key) {
    const d = await maintenance.getBinderEntry(key);
    if (d?.hasFile) throw new Error("Entries with a file attached are deleted in the binder itself, so the file isn't lost");
    await maintenance.deleteBinderEntry(key);
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

export const KidFields = z
  .object({
    /** First name only, as on the chore board. */
    name: z.string().trim().min(1).max(30).regex(/^[\p{L}][\p{L}' -]*$/u, "A first name, letters only"),
    emoji: z.string().max(8),
  })
  .strict();

/** Kids on the chore board. "delete" hides the kid (chores and history stay); undo brings them back. */
const kid: EntityAdapter = {
  entity: "kid",
  title: "Kid",
  async get(_ctx, key) {
    const k = await family.getKid(key);
    return k ? { fields: { name: k.name, emoji: k.emoji }, label: k.name } : null;
  },
  async update(_ctx, key, patch) {
    const f = KidFields.partial().parse(patch);
    if (f.name && (await family.listKids()).some((k) => k.id !== key && k.name.toLowerCase() === f.name!.toLowerCase())) {
      throw new Error(`There is already a kid called ${f.name}`);
    }
    await family.updateKid(key, f);
  },
  async create(_ctx, fields) {
    const f = KidFields.parse({ emoji: "⭐", ...fields });
    if ((await family.listKids()).some((k) => k.name.toLowerCase() === f.name.toLowerCase())) throw new Error(`There is already a kid called ${f.name}`);
    return family.addKid(f);
  },
  async remove(_ctx, key) {
    await family.removeKid(key);
  },
  async restore(_ctx, key) {
    await family.restoreKid(key);
    return key;
  },
};

export const ChoreFields = z
  .object({
    /** The kid's first name as on the chore board. */
    kid: text(40),
    title: text(60),
    icon: z.string().max(8),
    recurrence: z.enum(["daily", "weekly", "once"]),
    stars: z.number().int().min(1).max(5),
    /** Done for the current period (today, this week, or ever for a one-time chore). */
    done: z.boolean(),
  })
  .strict();

async function kidIdByName(name: string): Promise<string> {
  const kids = await family.listKids();
  const n = name.trim().toLowerCase();
  const kid = kids.find((k) => k.name.toLowerCase() === n) ?? kids.find((k) => k.name.toLowerCase().startsWith(n));
  if (!kid) throw new Error(`No kid called "${name}" on the chore board. Kids: ${kids.map((k) => k.name).join(", ") || "none yet"}.`);
  return kid.id;
}

/** Chores: add, rename, change how often, tick or untick; "delete" archives (history stays). */
const chore: EntityAdapter = {
  entity: "chore",
  title: "Chore",
  async get(ctx, key) {
    const c = await family.getChore(key, ctx.now);
    if (!c || c.archived) return null;
    return {
      fields: { kid: c.kidName, title: c.title, icon: c.icon, recurrence: c.recurrence, stars: c.stars, done: c.done },
      label: `${c.kidName}: ${c.title}`,
    };
  },
  async update(ctx, key, patch) {
    const f = ChoreFields.partial().parse(patch);
    const current = await family.getChore(key, ctx.now);
    if (!current) throw new Error("Chore not found");
    if (f.kid !== undefined && f.kid.toLowerCase() !== current.kidName.toLowerCase()) {
      throw new Error("A chore can't move to another kid. Add it for that kid and archive this one.");
    }
    const { done, kid: _kid, ...meta } = f;
    void _kid;
    if (Object.keys(meta).length) await family.updateChore(key, meta);
    if (done === true) await family.completeChore(key, ctx.now);
    else if (done === false) await family.undoChore(key, ctx.now);
  },
  async create(ctx, fields) {
    const f = ChoreFields.parse({ icon: "✅", recurrence: "daily", stars: 1, done: false, ...fields });
    const id = await family.addChore({ kidId: await kidIdByName(f.kid), title: f.title, icon: f.icon, recurrence: f.recurrence, stars: f.stars }, ctx.now);
    if (f.done) await family.completeChore(id, ctx.now);
    return id;
  },
  async remove(ctx, key) {
    await family.archiveChore(key, ctx.now);
  },
  async restore(_ctx, key) {
    await family.unarchiveChore(key);
    return key;
  },
};

export const ReadingFields = z
  .object({
    /** The kid's first name as on the chore board. */
    kid: text(40),
    /** YYYY-MM-DD, household day; defaults to today. */
    day,
    book: text(80),
    language: z.enum(["en", "ru"]),
    minutes: z.number().int().min(1).max(600),
    pages: z.number().int().min(0).max(2000).nullable(),
  })
  .strict();

/** Reading log entries. Milestone stars follow the log, so undo takes them back too. */
const readingEntry: EntityAdapter = {
  entity: "reading_entry",
  title: "Reading",
  async get(_ctx, key) {
    const r = await family.getReading(key);
    if (!r) return null;
    const kid = (await family.listKids()).find((k) => k.id === r.kidId)?.name ?? "Kid";
    return {
      fields: { kid, day: r.day, book: r.book, language: r.language, minutes: r.minutes, pages: r.pages },
      label: `${kid}: ${r.book}, ${r.minutes} min (${r.day})`,
    };
  },
  async update(ctx, key, patch) {
    const { kid, ...rest } = ReadingFields.partial().parse(patch);
    const current = await family.getReading(key);
    if (!current) throw new Error("That reading entry is gone");
    if (kid && (await kidIdByName(kid)) !== current.kidId) throw new Error("An entry can't move to another kid. Add it for that kid and delete this one.");
    await family.updateReading(key, rest, ctx.now);
  },
  async create(ctx, fields) {
    const f = ReadingFields.partial({ day: true, pages: true }).parse(fields);
    return family.addReading({ kidId: await kidIdByName(f.kid), day: f.day, book: f.book, language: f.language, minutes: f.minutes, pages: f.pages ?? null }, ctx.now);
  },
  async remove(_ctx, key) {
    await family.deleteReading(key);
  },
  async restore(_ctx, _key, snapshot) {
    const f = ReadingFields.parse(snapshot);
    return family.restoreReading({ kidId: await kidIdByName(f.kid), day: f.day, book: f.book, language: f.language, minutes: f.minutes, pages: f.pages });
  },
};

export const GoalFields = z
  .object({
    kid: text(40),
    /** The chore's title on that kid's board (a daily or weekly chore). */
    chore: text(60),
    /** "streak": the chore N days (or weeks) in a row; "count": N times in all. */
    kind: z.enum(["streak", "count"]),
    target: z.number().int().min(2).max(365),
    reward: text(80),
    rewardEmoji: z.string().max(8),
    rewardGiven: z.boolean(),
  })
  .strict();

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Kids' chore goals and their rewards. "delete" archives; undo brings it back. */
const choreGoal: EntityAdapter = {
  entity: "chore_goal",
  title: "Chore goal",
  async get(ctx, key) {
    const g = await family.getGoal(key, ctx.now);
    if (!g) return null;
    const kid = (await family.listKids()).find((k) => k.id === g.kidId)?.name ?? "Kid";
    return {
      fields: { kid, chore: g.choreTitle, kind: g.kind, target: g.target, reward: g.reward, rewardEmoji: g.rewardEmoji, rewardGiven: Boolean(g.rewardGivenAt) },
      label: `${kid}: ${g.choreTitle} ${g.target} ${g.kind === "streak" ? `${g.unit} in a row` : "times"} for ${g.reward}`,
    };
  },
  async update(ctx, key, patch) {
    const { kid, chore: choreTitle, kind, rewardGiven, ...rest } = GoalFields.partial().parse(patch);
    const current = await this.get(ctx, key);
    if (!current) throw new Error("Goal not found");
    const f = current.fields as z.infer<typeof GoalFields>;
    if ((kid && !same(kid, f.kid)) || (choreTitle && !same(choreTitle, f.chore)) || (kind && kind !== f.kind)) {
      throw new Error("A goal's kid, chore and kind can't change. Archive it and add a new one.");
    }
    if (Object.keys(rest).length) await family.updateGoal(key, rest);
    if (rewardGiven === true && !f.rewardGiven) await family.markRewardGiven(key, ctx.now);
    if (rewardGiven === false && f.rewardGiven) await family.unmarkRewardGiven(key);
  },
  async create(ctx, fields) {
    const f = GoalFields.parse({ rewardEmoji: "🎁", rewardGiven: false, ...fields });
    const kidId = await kidIdByName(f.kid);
    const board = (await family.choreBoard(ctx.now)).find((k) => k.id === kidId);
    const c = board?.chores.find((x) => same(x.title, f.chore));
    if (!c) throw new Error(`${f.kid} has no chore called "${f.chore}"`);
    return family.createGoal(
      { kidId, choreId: c.id, kind: f.kind, target: f.target, reward: f.reward, rewardEmoji: f.rewardEmoji },
      ctx.surface === "kitchen" ? "Kitchen screen" : ctx.owner,
      ctx.now,
    );
  },
  async remove(ctx, key) {
    await family.archiveGoal(key, ctx.now);
  },
  async restore(_ctx, key) {
    await family.unarchiveGoal(key);
    return key;
  },
};

const StoreItems = z
  .array(
    z.object({
      store: text(40),
      items: z.array(z.object({ name: text(80), quantity: optText(20) })).max(200),
    }),
  )
  .max(30);

export const ShoppingListFields = z
  .object({
    name: text(60),
    /** Put off until this date (hidden from the kitchen screen until then); null = active. */
    deferredUntil: day.nullable(),
    /** Create only: start from this template's stores and items. */
    template: optText(60),
  })
  .strict();

function listContent(l: family.ShoppingList) {
  return {
    stores: l.sections.map((s) => ({ store: s.store, items: s.items.map((i) => ({ name: i.name, quantity: i.quantity })) })),
    checked: l.sections.flatMap((s) => s.items.filter((i) => i.checked).map((i) => i.name)),
  };
}

/** Whole shopping lists. Deleting one deletes its items; undo rebuilds it from the snapshot. */
const shoppingList: EntityAdapter = {
  entity: "shopping_list",
  title: "Shopping list",
  async get(ctx, key) {
    const l = await family.getList(key, ctx.now);
    if (!l) return null;
    // Stores and items ride along so a delete can be undone; edits only touch name and date.
    return { fields: { name: l.name, deferredUntil: l.deferredUntil, ...listContent(l) }, label: l.name };
  },
  async update(_ctx, key, patch) {
    const f = ShoppingListFields.omit({ template: true }).partial().parse({ name: patch.name, deferredUntil: patch.deferredUntil });
    if (f.name !== undefined) await family.renameList(key, f.name);
    if (f.deferredUntil !== undefined) await family.deferList(key, f.deferredUntil);
  },
  async create(_ctx, fields) {
    const f = ShoppingListFields.parse({ deferredUntil: null, template: null, ...fields });
    let templateId: string | undefined;
    if (f.template) {
      const t = (await family.listTemplates()).find((x) => x.name.toLowerCase() === f.template!.toLowerCase());
      if (!t) throw new Error(`No template called "${f.template}"`);
      templateId = t.id;
    }
    const id = await family.createList({ name: f.name, templateId });
    if (f.deferredUntil) await family.deferList(id, f.deferredUntil);
    return id;
  },
  async remove(_ctx, key) {
    await family.deleteList(key);
  },
  async restore(_ctx, _key, snapshot) {
    const name = text(60).parse(snapshot.name);
    const stores = StoreItems.parse(snapshot.stores ?? []);
    const checked = z.array(z.string()).parse(snapshot.checked ?? []);
    return family.restoreList({ name, deferredUntil: (snapshot.deferredUntil as string | null) ?? null, stores, checked });
  },
};

export const TemplateFields = z.object({ name: text(60), stores: StoreItems }).strict();

/** Shopping list templates ("Weekly Costco run"): stores and items to start a list from. */
const shoppingTemplate: EntityAdapter = {
  entity: "shopping_template",
  title: "List template",
  async get(_ctx, key) {
    const t = (await family.listTemplates()).find((x) => x.id === key);
    if (!t) return null;
    return { fields: { name: t.name, stores: t.stores }, label: t.name };
  },
  async update(_ctx, key, patch) {
    await family.updateTemplate(key, TemplateFields.partial().parse(patch));
  },
  async create(_ctx, fields) {
    const f = TemplateFields.parse(fields);
    if ((await family.listTemplates()).some((t) => t.name.toLowerCase() === f.name.toLowerCase())) {
      throw new Error(`A template called "${f.name}" already exists`);
    }
    return family.saveTemplate(f.name, f.stores);
  },
  async remove(_ctx, key) {
    await family.deleteTemplate(key);
  },
  async restore(ctx, _key, snapshot) {
    return this.create!(ctx, snapshot);
  },
};

// ---------------------------------------------------------- calendar ----

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time as HH:MM (24-hour)");

export const CalendarEventFields = z
  .object({
    title: text(200),
    location: optText(200),
    notes: optText(2000),
    allDay: z.boolean(),
    startDate: day,
    /** Last day of the event (inclusive), same as startDate for one day. */
    endDate: day,
    startTime: hhmm.nullable(),
    endTime: hhmm.nullable(),
  })
  .strict();

function checkEvent(e: z.infer<typeof CalendarEventFields>) {
  if (e.endDate < e.startDate) throw new Error("The event ends before it starts");
  if (!e.allDay && (!e.startTime || !e.endTime)) throw new Error("A timed event needs a start and end time (or make it all day)");
  if (!e.allDay && e.endDate === e.startDate && e.endTime! <= e.startTime!) throw new Error("The event ends before it starts");
  return e.allDay ? { ...e, startTime: null, endTime: null } : e;
}

/** Events on the family Google calendar. Repeating events are changed in Google Calendar itself. */
const calendarEvent: EntityAdapter = {
  entity: "calendar_event",
  title: "Calendar event",
  async get(_ctx, key) {
    const e = await calendar.familyEventForEdit(key);
    if (!e) return null;
    const { id: _id, recurring, ...fields } = e;
    void _id;
    return {
      fields: { ...fields, location: fields.location ?? null, notes: fields.notes ?? null, startTime: fields.startTime ?? null, endTime: fields.endTime ?? null },
      label: `${e.title} (${e.startDate}${e.allDay ? "" : ` ${e.startTime}`})${recurring ? " (repeats)" : ""}`,
    };
  },
  async update(_ctx, key, patch) {
    const e = await calendar.familyEventForEdit(key);
    if (!e) throw new Error("Event not found");
    if (e.recurring) throw new Error("Repeating events are changed in Google Calendar itself");
    const { id: _id, recurring: _r, ...current } = e;
    void _id;
    void _r;
    const next = checkEvent(CalendarEventFields.parse({ ...current, location: current.location ?? null, notes: current.notes ?? null, startTime: current.startTime ?? null, endTime: current.endTime ?? null, ...patch }));
    await calendar.updateGoogleEvent(key, next);
  },
  async create(_ctx, fields) {
    const e = checkEvent(CalendarEventFields.parse({ location: null, notes: null, allDay: false, startTime: null, endTime: null, ...fields, endDate: fields.endDate ?? fields.startDate }));
    const id = await calendar.createGoogleEvent(e);
    if (!id) throw new Error("Google added the event but it couldn't be read back; it shows after the next sync");
    return id;
  },
  async remove(_ctx, key) {
    const e = await calendar.familyEventForEdit(key);
    if (e?.recurring) throw new Error("Repeating events are deleted in Google Calendar itself");
    await calendar.deleteGoogleEvent(key);
  },
  async restore(ctx, _key, snapshot) {
    return this.create!(ctx, snapshot);
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
  [
    transaction,
    merchantRule,
    upkeepTask,
    upkeepAsset,
    houseProject,
    binderEntry,
    shoppingItem,
    shoppingList,
    shoppingTemplate,
    purchaseReturn,
    kid,
    chore,
    choreGoal,
    readingEntry,
    calendarEvent,
    tripCharge,
  ].map((a) => [a.entity, a]),
);

export function adapterFor(entity: string): EntityAdapter {
  const a = ADAPTERS[entity];
  if (!a) throw new Error(`Unknown kind of change: ${entity}`);
  return a;
}

/** Same values, ignoring key order, undefined vs null, number formatting, and case and spacing of text. */
export function sameFields(current: Fields, expected: Fields): boolean {
  return Object.keys(expected).every((k) => norm(current[k]) === norm(expected[k]));
}

function norm(v: unknown): string {
  if (v === undefined || v === null || v === "") return "null";
  if (typeof v === "number") return String(Math.round(v * 100) / 100);
  // "leo" typed to Claude is the kid "Leo" on the board.
  if (typeof v === "string") return JSON.stringify(v.trim().toLowerCase());
  return JSON.stringify(canonical(v));
}

/** Objects with sorted keys: snapshots come back from jsonb with their keys reordered. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k] ?? null)]),
    );
  }
  return typeof v === "string" ? v.trim().toLowerCase() : v;
}
