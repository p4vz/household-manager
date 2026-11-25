import "server-only";
import { z } from "zod";
import { runWebResearch } from "@/core/ai/run";
import { sanitizeReferencePayload } from "@/core/ai/sanitize";
import { forAssistant, ownerLabel, type ScrubMode } from "@/mcp/sanitize";
import { TOOLS as MCP_TOOLS, type ToolContext } from "@/mcp/tools";
import * as calendar from "@/modules/calendar/api";
import * as family from "@/modules/family/api";
import * as finance from "@/modules/finance/api";
import * as maintenance from "@/modules/maintenance/api";
import * as trips from "@/modules/trips/api";
import { DraftBook } from "./changesets";
import type { RefBook } from "./conversations";
import { kitchenRefusal } from "./changesets";
import {
  adapterFor,
  BinderFields,
  CalendarEventFields,
  ChoreFields,
  GoalFields,
  ReadingFields,
  KidFields,
  MerchantRuleFields,
  AssetFields,
  ProjectFields,
  ReturnFields,
  sameFields,
  ShoppingFields,
  ShoppingListFields,
  TemplateFields,
  TransactionPatch,
  TripChargeFields,
  UpkeepFields,
  type AssistantCtx,
  type Fields,
} from "./entities";
import { AUTO_APPLY_MAX } from "./policy";

/**
 * The in-app assistant's tools. They run inside this server process (the
 * Agent SDK's in-process MCP server, or AI SDK tools for the API-key path)
 * and are never reachable over HTTP.
 *
 * - Read tools call module api.ts functions as the signed-in member, so
 *   finance only shows joint accounts and that member's own.
 * - Answers carry short refs ("t12") instead of ids, and are scrubbed like
 *   every other LLM payload (src/mcp/sanitize.ts: no account, card or
 *   routing numbers, no legal names, no wallets, emails or booking codes).
 * - Edit tools only draft changes into a DraftBook. Nothing is written until
 *   the turn ends and changesets.ts records the batch (and applies it if it
 *   is small; see policy.ts).
 */

export type ToolEnv = { ctx: AssistantCtx; refs: RefBook; drafts: DraftBook };

export type AssistantTool = {
  name: string;
  description: string;
  input: z.ZodRawShape;
  kind: "read" | "edit";
  scrub: ScrubMode;
  run(args: Record<string, unknown>, env: ToolEnv): Promise<unknown>;
};

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (now: Date, n: number) => isoDay(new Date(now.getTime() - n * 86_400_000));
const refList = z.array(z.string().min(1).max(12)).min(1).max(200);

function mcpContext(ctx: AssistantCtx): ToolContext {
  // Trips through the reviewed MCP tools: itinerary and booking status, but
  // never booking codes (not needed in the app, where the page shows them).
  return { owner: ctx.owner, now: ctx.now, permissions: new Set(["travel.trips", "travel.itinerary", "travel.bookings"]), appUrl: null };
}

function cardContext(ctx: AssistantCtx): ToolContext {
  // Card advice on the member's own cards (joint and theirs), as in Finance.
  return {
    owner: ctx.owner,
    now: ctx.now,
    permissions: new Set(["travel.trips", "travel.bookings", "finance.card_advice", "finance.signup_bonuses"]),
    appUrl: null,
  };
}

async function tripBySlug(slug: string) {
  const trip = await trips.getTrip(slug);
  if (!trip) throw new Error(`No trip "${slug}". Call list_trips for the trip values.`);
  return trip;
}

function mcpTool(name: string) {
  const t = MCP_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`missing MCP tool ${name}`);
  return t;
}

function pick(obj: Fields, keys: string[]): Fields {
  return Object.fromEntries(keys.map((k) => [k, obj[k] ?? null]));
}

function definedKeys(o: Fields) {
  return Object.keys(o).filter((k) => o[k] !== undefined);
}

async function draftUpdate(env: ToolEnv, entity: string, key: string, patch: Fields): Promise<boolean> {
  const current = await adapterFor(entity).get(env.ctx, key);
  if (!current) throw new Error(`That ${entity.replace(/_/g, " ")} no longer exists or is not visible to you.`);
  const keys = definedKeys(patch);
  if (!keys.length) throw new Error("Nothing to change: give at least one field.");
  const before = pick(current.fields, keys);
  const after = pick(patch, keys);
  if (sameFields(before, after)) return false;
  env.drafts.add({ entity, op: "update", key, label: current.label, before, after });
  return true;
}

async function draftDelete(env: ToolEnv, entity: string, key: string) {
  const refused = kitchenRefusal(env.ctx, entity, "delete");
  if (refused) throw new Error(`${refused}.`);
  const current = await adapterFor(entity).get(env.ctx, key);
  if (!current) throw new Error(`That ${entity.replace(/_/g, " ")} no longer exists.`);
  env.drafts.add({ entity, op: "delete", key, label: current.label, before: current.fields, after: null });
}

function queued(env: ToolEnv, changed: number) {
  return {
    queued: changed,
    changesInThisReply: env.drafts.size,
    note:
      env.drafts.size > AUTO_APPLY_MAX
        ? "These will be shown to the member to approve after your reply."
        : "Small batches without deletes apply when your reply is sent; anything else waits for the member's approval. Either way the member can undo.",
  };
}

const ACTION = z.enum(["create", "update", "delete"]);
const kitchen = (env: ToolEnv) => env.ctx.surface === "kitchen";

function draftCreate(env: ToolEnv, entity: string, label: string, after: Fields) {
  env.drafts.add({ entity, op: "create", key: null, label, before: null, after });
  return queued(env, 1);
}

/** create / update / delete for one adapter, with the tool's parsed fields. */
async function crud(
  env: ToolEnv,
  entity: string,
  action: string,
  ref: string | undefined,
  rest: Fields,
  schema: { create: (f: Fields) => Fields; update: (f: Fields) => Fields; label: (f: Fields) => string },
) {
  if (action === "create") {
    const f = schema.create(rest);
    return draftCreate(env, entity, schema.label(f), f);
  }
  const key = env.refs.resolve(String(ref ?? ""), entity);
  if (action === "delete") {
    await draftDelete(env, entity, key);
    return queued(env, 1);
  }
  return queued(env, (await draftUpdate(env, entity, key, schema.update(rest))) ? 1 : 0);
}

/** Turns a `vehicleRef` argument into the record's assetId (null unlinks). */
function withAssetId<T extends Fields>(args: T, env: ToolEnv): T {
  if (args.vehicleRef === undefined) return args;
  const { vehicleRef, ...rest } = args;
  return { ...rest, assetId: vehicleRef == null ? null : env.refs.resolve(String(vehicleRef), "upkeep_asset") } as unknown as T;
}

const ResearchAnswer = z.object({
  answer: z.string(),
  recommendations: z.array(z.object({ item: z.string(), interval: z.string().nullable(), note: z.string().nullable() })),
});

export const TOOLS: AssistantTool[] = [
  // ------------------------------------------------------------ finance reads
  {
    name: "list_accounts",
    description: "Bank accounts and cards this member can see (joint and their own): ref, name, owner label, kind, active, balance.",
    input: {},
    kind: "read",
    scrub: "finance",
    async run(_args, { ctx, refs }) {
      return (await finance.assistantAccounts(ctx.viewer)).map((a) => ({
        ref: refs.ref("account", a.id),
        name: a.name,
        owner: ownerLabel(a.owner),
        kind: a.kind,
        active: a.active,
        balance: a.balance,
      }));
    },
  },
  {
    name: "search_transactions",
    description:
      "Find transactions (newest first). Amounts: negative = money out. Each row has a ref for edit_transactions. Transfers are left out unless includeTransfers. Returns at most 300 rows; `truncated` says there were more, so narrow the filter.",
    input: {
      from: z.iso.date().optional().describe("First date, YYYY-MM-DD"),
      to: z.iso.date().optional().describe("Last date, YYYY-MM-DD"),
      text: z.string().max(60).optional().describe("Part of the merchant or description"),
      category: z.string().max(60).optional(),
      uncategorizedOnly: z.boolean().optional(),
      accounts: z.array(z.string().max(12)).max(50).optional().describe("Account refs from list_accounts"),
      minAmount: z.number().optional(),
      maxAmount: z.number().optional(),
      includeTransfers: z.boolean().optional(),
      limit: z.number().int().min(1).max(finance.MAX_SEARCH_ROWS).optional().describe("Default 100"),
    },
    kind: "read",
    scrub: "finance",
    async run(args, { ctx, refs }) {
      const a = args as Record<string, never>;
      const accountIds = (args.accounts as string[] | undefined)?.map((r) => refs.resolve(r, "account"));
      const { rows, truncated } = await finance.searchTransactions(ctx.viewer, { ...a, accountIds });
      return {
        truncated,
        transactions: rows.map((r) => ({
          ref: refs.ref("transaction", r.id),
          date: r.date,
          merchant: r.merchant,
          amount: r.amount,
          category: r.category,
          subcategory: r.subcategory,
          isTransfer: r.isTransfer || undefined,
          pending: r.pending || undefined,
          notes: r.notes ?? undefined,
          account: r.account,
          accountRef: refs.ref("account", r.accountId),
          owner: ownerLabel(r.owner),
        })),
      };
    },
  },
  {
    name: "category_overview",
    description: "Every category/subcategory in use with transaction count and net total. Use it to spot near-duplicate or messy categories.",
    input: {},
    kind: "read",
    scrub: "finance",
    async run(_args, { ctx }) {
      return finance.categoryCounts(ctx.viewer);
    },
  },
  {
    name: "monthly_spending",
    description: "Spending per month and category (outflows net of refunds; transfers and income left out). Default: last 12 months.",
    input: { from: z.iso.date().optional(), to: z.iso.date().optional() },
    kind: "read",
    scrub: "finance",
    async run(args, { ctx }) {
      return finance.monthlySpendByCategory(ctx.viewer, (args.from as string) ?? daysAgo(ctx.now, 365), (args.to as string) ?? isoDay(ctx.now));
    },
  },
  {
    name: "expected_expenses",
    description: "Costs other parts of the app expect: trip budgets and upkeep estimates, from a date on (default today).",
    input: { from: z.iso.date().optional() },
    kind: "read",
    scrub: "finance",
    async run(args, { ctx }) {
      return finance.listExpectedExpenses((args.from as string) ?? isoDay(ctx.now));
    },
  },
  {
    name: "merchant_rule",
    description: "The category rule for a merchant (applied to newly synced transactions), or null.",
    input: { merchant: z.string().min(1).max(80) },
    kind: "read",
    scrub: "finance",
    async run(args) {
      return finance.getMerchantRule(String(args.merchant));
    },
  },

  // ---------------------------------------------------------- household reads
  {
    name: "upkeep_tasks",
    description:
      "House and car upkeep tasks: open ones, plus ones completed since a date if given. Each has a ref for edit_upkeep_task (update, complete, reopen, delete).",
    input: { completedSince: z.iso.date().optional() },
    kind: "read",
    scrub: "reference",
    async run(args, env) {
      const { refs } = env;
      const assets = kitchen(env) ? new Map((await maintenance.listAssets()).map((a) => [a.id, a.name])) : null;
      return (await maintenance.listTasks({ completedSince: (args.completedSince as string) ?? null })).map((t) => ({
        ref: refs.ref("upkeep_task", t.id),
        title: t.title,
        dueDate: t.dueDate,
        estimatedCost: t.estimatedCost,
        actualCost: t.actualCost,
        completedOn: t.completedOn,
        repeatsEveryDays: t.recurrenceDays,
        area: t.area,
        lastDoneOn: t.lastDoneOn,
        // The kitchen screen leaves out upkeep notes and parts, as it always has.
        ...(!assets && { parts: t.parts, notes: t.notes }),
        ...(t.assetId && (assets ? { for: assets.get(t.assetId) ?? null } : { vehicleOrEquipmentRef: refs.ref("upkeep_asset", t.assetId) })),
        ...((t.dueMileage || t.recurrenceMiles || t.lastDoneMileage) && {
          dueAtMiles: t.dueMileage,
          repeatsEveryMiles: t.recurrenceMiles,
          lastDoneAtMiles: t.lastDoneMileage,
        }),
      }));
    },
  },
  {
    name: "home_equipment",
    description:
      "The house's equipment and big-ticket parts (HVAC, roof, water heater, appliances) and the household's cars (kind vehicle, with make, model, year and last odometer reading): kind, location, installed or bought date, cost, notes. Each has a ref for edit_home_equipment, and a car's ref links upkeep tasks and history to it.",
    input: {},
    kind: "read",
    scrub: "reference",
    async run(_args, { refs }) {
      return (await maintenance.listAssets()).map((a) => ({
        ref: refs.ref("upkeep_asset", a.id),
        name: a.name,
        kind: a.kind,
        location: a.location,
        installedOn: a.installedOn,
        cost: a.cost,
        notes: a.notes,
        ...(a.kind === "vehicle" && { make: a.make, model: a.model, year: a.year, mileage: a.mileage, mileageOn: a.mileageOn }),
      }));
    },
  },
  {
    name: "house_projects",
    description:
      "House project and expense history (renovations, repairs, appliance purchases): date or period, title, vendor, description, amount, and whether a bank payment is linked. Each has a ref for edit_house_project. Use with search_transactions to cross-check the history against spending.",
    input: {},
    kind: "read",
    scrub: "reference",
    async run(_args, { refs }) {
      return (await maintenance.listProjects()).map((p) => ({
        ref: refs.ref("house_project", p.id),
        date: p.date,
        period: p.period,
        title: p.title,
        vendor: p.vendor,
        description: p.description,
        amount: p.amount,
        amountNote: p.amountNote,
        paymentLinked: Boolean(p.transactionId),
        ...(p.assetId && { vehicleOrEquipmentRef: refs.ref("upkeep_asset", p.assetId) }),
      }));
    },
  },
  {
    name: "questionable_transactions",
    description:
      "The house audit's open queue: cash withdrawals, uncategorized spending and likely house expenses the member hasn't explained yet, with the audit's guess if any. Refs work with edit_transactions.",
    input: { limit: z.number().int().min(1).max(100).optional() },
    kind: "read",
    scrub: "finance",
    async run(args, { ctx, refs }) {
      const linked = (await maintenance.listProjects()).map((p) => p.transactionId).filter((x): x is string => Boolean(x));
      const { rows, count } = await finance.houseQuestions(ctx.viewer, { linkedIds: linked, limit: (args.limit as number | undefined) ?? 50 });
      return {
        open: count,
        transactions: rows.map((r) => ({
          ref: refs.ref("transaction", r.id),
          kind: r.kind,
          date: r.date,
          merchant: r.merchant,
          amount: r.amount,
          category: r.category,
          notes: r.notes ?? undefined,
          guess: r.suggestion ?? undefined,
        })),
      };
    },
  },
  {
    name: "check_recalls",
    description:
      "Search U.S. CPSC product recalls for a product, e.g. 'GE refrigerator' or 'Sharp microwave'. Give brand and product type only, never serial or model registration numbers.",
    input: { product: z.string().min(3).max(60) },
    kind: "read",
    scrub: "reference",
    async run(args) {
      const hits = await maintenance.searchRecalls(String(args.product));
      return { source: "U.S. Consumer Product Safety Commission (saferproducts.gov)", recalls: hits };
    },
  },
  {
    name: "maintenance_research",
    description:
      "Look up maintenance recommendations on the web (manufacturer guidance, intervals, parts, known issues), e.g. 'APEC RO membrane replacement interval'. Returns findings with sources. Takes a while; use it when the member asks for recommendations.",
    input: { question: z.string().min(5).max(200) },
    kind: "read",
    scrub: "reference",
    async run(args) {
      const { output, sources } = await runWebResearch({
        tier: "flagship",
        system: "You research home maintenance: manufacturer recommendations, service intervals, parts, recalls and known problems. Prefer manufacturer and government sources.",
        task: "Answer the household's maintenance question with concrete intervals and parts where the sources give them.",
        payload: sanitizeReferencePayload({ question: String(args.question) }),
        schema: ResearchAnswer,
        maxSearches: 5,
      });
      return { ...output, sources: sources.slice(0, 8) };
    },
  },
  {
    name: "shopping_list",
    description:
      "Shopping items on every list, by list and store (checked = bought; ticking one item ticks the same item on the other active lists). Lists put off until a date show deferredUntil. Each item has a ref for edit_shopping_item.",
    input: {},
    kind: "read",
    scrub: "reference",
    async run(_args, { refs }) {
      return (await family.listShoppingItems()).map((i) => ({
        ref: refs.ref("shopping_item", i.id),
        list: i.list,
        ...(i.deferredUntil && { deferredUntil: i.deferredUntil }),
        store: i.store,
        name: i.name,
        quantity: i.quantity,
        checked: i.checked,
      }));
    },
  },
  {
    name: "purchase_returns",
    description: "Things to return to stores, with deadline and status. Each has a ref for edit_purchase_return.",
    input: { includeReturned: z.boolean().optional() },
    kind: "read",
    scrub: "reference",
    async run(args, env) {
      return (await family.listReturns({ includeReturned: Boolean(args.includeReturned) })).map((r) => ({
        ref: env.refs.ref("purchase_return", r.id),
        item: r.itemName,
        store: r.store,
        returnDeadline: r.returnDeadline,
        status: r.status,
        ...(!kitchen(env) && { notes: r.notes }),
      }));
    },
  },
  {
    name: "chores",
    description:
      "Kids' chore board for today: each kid (by name) with their chores (ref, title, icon, daily/weekly/once, stars, done for this period) and stats (streak, stars). Refs work with edit_chore.",
    input: {},
    kind: "read",
    scrub: "reference",
    async run(_args, { ctx, refs }) {
      return (await family.choreBoard(ctx.now)).map((k) => ({
        kid: k.name,
        kidRef: refs.ref("kid", k.id),
        emoji: k.emoji,
        stats: k.stats,
        chores: k.chores.map((c) => ({ ref: refs.ref("chore", c.id), title: c.title, icon: c.icon, recurrence: c.recurrence, stars: c.stars, done: c.done })),
      }));
    },
  },
  {
    name: "reading_log",
    description:
      "Kids' reading log: per kid, today's reading toward the day's goal (a day counts with 20 minutes in English or 15 in Russian), days in a row, reading days in all, milestone stars (10 for every 5 days in a row, 50 for every 30 days), entries from the last 30 days (ref, date, book, en/ru, minutes, pages), and the kid's book shelf (books being read; a new title logged goes on it by itself). Refs work with edit_reading_log.",
    input: {},
    kind: "read",
    scrub: "reference",
    async run(_args, { ctx, refs }) {
      const [kids, summaries] = await Promise.all([family.listKids(), family.readingSummaries(ctx.now)]);
      return kids.map((k) => {
        const r = summaries.get(k.id);
        return {
          kid: k.name,
          rule: family.READING_RULE,
          todayCounted: (r?.stats.todayShare ?? 0) >= 1,
          todayPercent: Math.round((r?.stats.todayShare ?? 0) * 100),
          daysInARow: r?.stats.streak ?? 0,
          readingDays: r?.stats.totalDays ?? 0,
          milestoneStars: r?.stats.stars ?? 0,
          milestones: (r?.stats.milestones ?? []).slice(-5).map((m) => `${m.label} (${m.day}, +${m.stars} stars)`),
          entries: (r?.recent ?? []).map((e) => ({ ref: refs.ref("reading_entry", e.id), date: e.day, book: e.book, language: e.language, minutes: e.minutes, pages: e.pages })),
          bookShelf: (r?.books ?? []).filter((b) => !b.finished).map((b) => ({ title: b.title, author: b.author, language: b.language })),
        };
      });
    },
  },
  {
    name: "chore_goals",
    description:
      "Kids' chore goals (e.g. read 10 days in a row for a prize): kid, chore, streak or count, target, progress, reached, reward and whether it was given. Includes reached and rewarded ones. Refs work with edit_chore_goal.",
    input: {},
    kind: "read",
    scrub: "reference",
    async run(_args, { ctx, refs }) {
      const kids = new Map((await family.listKids()).map((k) => [k.id, k.name]));
      return (await family.listGoals(ctx.now, { includeDone: true })).map((g) => ({
        ref: refs.ref("chore_goal", g.id),
        kid: kids.get(g.kidId) ?? null,
        chore: g.choreTitle,
        kind: g.kind,
        target: g.target,
        unit: g.unit,
        progress: g.progress,
        reached: g.reached,
        achievedOn: g.achievedOn,
        reward: g.reward,
        rewardEmoji: g.rewardEmoji,
        rewardGiven: Boolean(g.rewardGivenAt),
        startedOn: g.startedOn,
      }));
    },
  },
  {
    name: "shopping_lists",
    description:
      "The shopping lists themselves (ref, name, put off until, how many items left by store) and the saved list templates (ref, name, stores and items). Refs work with edit_shopping_list and edit_shopping_template; items are in shopping_list.",
    input: {},
    kind: "read",
    scrub: "reference",
    async run(_args, { ctx, refs }) {
      const [board, templates] = await Promise.all([family.shoppingBoard(ctx.now), family.listTemplates()]);
      return {
        lists: [...board.lists, ...board.deferred].map((l) => ({
          ref: refs.ref("shopping_list", l.id),
          name: l.name,
          deferredUntil: l.deferredUntil,
          stores: l.sections.map((sec) => ({ store: sec.store, left: sec.items.filter((i) => !i.checked).length, bought: sec.items.filter((i) => i.checked).length })),
        })),
        templates: templates.map((t) => ({ ref: refs.ref("shopping_template", t.id), name: t.name, stores: t.stores })),
      };
    },
  },
  {
    name: "home_binder",
    description:
      "The home binder: manuals, warranties, insurance policies, property tax bills, receipts. Category, title, provider, linked equipment or project, start and end dates, amount, link, notes, whether a file is attached. Refs work with edit_binder_entry.",
    input: {},
    kind: "read",
    scrub: "reference",
    async run(_args, { refs }) {
      return (await maintenance.listBinder()).map((d) => ({
        ref: refs.ref("binder_entry", d.id),
        category: d.category,
        title: d.title,
        provider: d.provider,
        startsOn: d.startsOn,
        expiresOn: d.expiresOn,
        amount: d.amount,
        url: d.url,
        notes: d.notes,
        hasFile: d.hasFile,
        ...(d.assetId && { equipmentRef: refs.ref("upkeep_asset", d.assetId) }),
        ...(d.projectId && { projectRef: refs.ref("house_project", d.projectId) }),
      }));
    },
  },
  {
    name: "calendar",
    description:
      "Family calendar from a date (default today) for up to 9 days (Google calendars plus trips and events typed in the app), and household reminders (upkeep, annual fees). Events on the family calendar carry a ref for edit_calendar_event; repeating ones say so and can only be changed in Google Calendar.",
    input: {
      from: z.iso.date().optional().describe("First day, YYYY-MM-DD (default today)"),
      days: z.number().int().min(1).max(9).optional().describe("Default 9"),
    },
    kind: "read",
    scrub: "reference",
    async run(args, { ctx, refs }) {
      const days = (args.days as number | undefined) ?? 9;
      const from = args.from ? new Date(`${String(args.from)}T12:00:00Z`) : ctx.now;
      const [agenda, reminders] = await Promise.all([calendar.kioskCalendar(days, from), calendar.listUpcoming(isoDay(from), 50)]);
      return {
        agenda: agenda.days.map((d) => ({
          date: d.date,
          items: d.items.map((i) => ({
            ...(i.edit && { ref: refs.ref("calendar_event", i.edit.id), ...(i.edit.recurring && { repeats: true }) }),
            title: i.title,
            time: i.timeLabel,
            location: i.location,
            who: i.who,
          })),
        })),
        reminders: reminders.map((e) => ({ title: e.title, startDate: e.startDate, endDate: e.endDate, from: e.sourceModule })),
      };
    },
  },
  {
    name: "list_trips",
    description: mcpTool("list_trips").description,
    input: mcpTool("list_trips").input,
    kind: "read",
    scrub: "reference",
    run: (args, { ctx }) => mcpTool("list_trips").run(args, mcpContext(ctx)),
  },
  {
    name: "get_trip",
    description: "One trip's places and itinerary with booking status and costs. Booking codes stay in the app.",
    input: mcpTool("get_trip").input,
    kind: "read",
    scrub: "reference",
    run: (args, { ctx }) => mcpTool("get_trip").run(args, mcpContext(ctx)),
  },

  {
    name: "trip_spending",
    description:
      "A trip's real spending from the bank: planned vs spent (only charges on accounts this member can see), spend by category, each itinerary step's planned cost vs its charges, flags (booked but no charge, charged but not marked booked, cost differs, travel charge with no itinerary step, over plan), the linked charges (transaction refs), suggested charges not linked yet (strong or possible, with the reason), and rewards earned on the charges vs the best household card.",
    input: { trip: z.string().min(1).max(120).describe("The trip value from list_trips") },
    kind: "read",
    scrub: "finance",
    async run(args, { ctx, refs }) {
      const trip = await tripBySlug(String(args.trip));
      const s = await trips.tripSpend(ctx.viewer, trip.id, ctx.now);
      const missed = s.rewards.rows.filter((r) => r.missedCents > 0);
      return {
        trip: { trip: s.trip.slug, name: s.trip.name, startDate: s.trip.startDate, endDate: s.trip.endDate, status: s.trip.status },
        planned: s.planned,
        spent: s.spent,
        remaining: s.remaining,
        spentBeforeTrip: s.spentBeforeTrip,
        byCategory: s.byCategory,
        steps: s.steps.map((x) => ({ step: x.title, kind: x.kind, provider: x.provider, planned: x.planned, actual: x.actual, bookingStatus: x.bookingStatus })),
        flags: s.flags.map((f) => f.message),
        charges: s.charges.map((c) => ({
          ref: refs.ref("transaction", c.id),
          date: c.date,
          merchant: c.merchant,
          amount: c.amount,
          category: c.category,
          account: c.account,
          owner: ownerLabel(c.owner),
          step: c.step ?? undefined,
          linkedBy: c.source ?? undefined,
        })),
        suggestions: s.suggestions.map((x) => ({
          ref: refs.ref("transaction", x.transactionId),
          date: x.date,
          merchant: x.merchant,
          amount: x.amount,
          category: x.category,
          account: x.account,
          confidence: x.confidence,
          reason: x.reason,
          step: s.steps.find((st) => st.id === x.stepId)?.title,
        })),
        rewards: {
          earned: s.rewards.earned,
          leftOnTheTable: s.rewards.missed,
          betterCard: missed.slice(0, 10).map((r) => ({ date: r.date, merchant: r.merchant, amount: r.amount, used: r.actualCard, best: r.bestCard, missed: r.missedCents / 100 })),
        },
      };
    },
  },
  {
    name: "trip_card_plan",
    description:
      "For a trip's bookings not yet paid: which of this member's cards to book each one with (open sign-up bonuses first, then the best multiplier), and bonus progress with the trip's spend. Steps with a bank charge linked count as paid.",
    input: mcpTool("trip_card_plan").input,
    kind: "read",
    scrub: "finance",
    run: (args, { ctx }) => mcpTool("trip_card_plan").run(args, cardContext(ctx)),
  },
  {
    name: "best_card_for_purchases",
    description: mcpTool("best_card_for_purchases").description,
    input: mcpTool("best_card_for_purchases").input,
    kind: "read",
    scrub: "finance",
    run: (args, { ctx }) => mcpTool("best_card_for_purchases").run(args, cardContext(ctx)),
  },

  // -------------------------------------------------------------------- edits
  {
    name: "link_trip_charges",
    description:
      "Tie bank charges (transaction refs from trip_spending or search_transactions) to a trip, optionally to one itinerary step by its title; or mark them 'not this trip' (dismiss: never suggested for it again); or unlink them from any trip. A charge belongs to one trip at a time.",
    input: {
      action: z.enum(["link", "dismiss", "unlink"]),
      refs: refList,
      trip: z.string().min(1).max(120).optional().describe("The trip value from list_trips; needed for link and dismiss"),
      step: z.string().max(200).optional().describe("Itinerary step title on that trip (link only)"),
    },
    kind: "edit",
    scrub: "finance",
    async run(args, env) {
      const action = String(args.action);
      const trip = args.trip ? (await tripBySlug(String(args.trip))).slug : null;
      if (action !== "unlink" && !trip) throw new Error("Give the trip to link to or dismiss from.");
      if (trip && args.step) await trips.resolveTripStep(trip, String(args.step));
      const patch = TripChargeFields.parse(
        action === "unlink"
          ? { trip: null, step: null, link: null }
          : { trip, step: action === "link" ? ((args.step as string | undefined) ?? null) : null, link: action === "link" ? "linked" : "dismissed" },
      );
      let n = 0;
      for (const r of args.refs as string[]) if (await draftUpdate(env, "trip_charge", env.refs.resolve(r, "transaction"), patch)) n++;
      return queued(env, n);
    },
  },
  {
    name: "edit_transactions",
    description:
      "Change category, subcategory, notes or the transfer flag on one or more transactions (refs from search_transactions). The same values go to every ref. Amounts, dates, merchants and accounts can't be changed.",
    input: {
      refs: refList,
      category: z.string().max(60).nullable().optional(),
      subcategory: z.string().max(60).nullable().optional(),
      notes: z.string().max(500).nullable().optional(),
      isTransfer: z.boolean().optional(),
    },
    kind: "edit",
    scrub: "finance",
    async run(args, env) {
      const { refs: list, ...rest } = args as { refs: string[] } & Fields;
      const patch = TransactionPatch.parse(rest);
      let n = 0;
      for (const r of list) if (await draftUpdate(env, "transaction", env.refs.resolve(r, "transaction"), patch)) n++;
      return queued(env, n);
    },
  },
  {
    name: "set_merchant_rule",
    description:
      "Set or remove the category rule for a merchant, used for transactions synced from now on. It does not touch existing transactions: use edit_transactions for those.",
    input: {
      merchant: z.string().min(1).max(80),
      remove: z.boolean().optional(),
      category: z.string().max(60).optional(),
      subcategory: z.string().max(60).nullable().optional(),
    },
    kind: "edit",
    scrub: "finance",
    async run(args, env) {
      const merchant = String(args.merchant).trim();
      const a = adapterFor("merchant_rule");
      const current = await a.get(env.ctx, merchant);
      if (args.remove) {
        if (!current) return queued(env, 0);
        await draftDelete(env, "merchant_rule", merchant);
        return queued(env, 1);
      }
      const rule = MerchantRuleFields.parse({ category: args.category, subcategory: args.subcategory ?? null });
      if (!current) {
        env.drafts.add({ entity: "merchant_rule", op: "create", key: null, label: `Rule for ${merchant}`, before: null, after: { merchant, ...rule } });
        return queued(env, 1);
      }
      return queued(env, (await draftUpdate(env, "merchant_rule", merchant, rule)) ? 1 : 0);
    },
  },
  {
    name: "edit_upkeep_task",
    description:
      "House or car upkeep tasks. create; update (ref from upkeep_tasks); complete (mark done on completedOn, default today, with the cost and the car's odometer reading if known; a repeating task then schedules its next one); reopen (undo a completion and drop the next one it scheduled); delete (open tasks only; completed ones are history).",
    input: {
      action: z.enum(["create", "update", "complete", "reopen", "delete"]),
      ref: z.string().max(12).optional(),
      title: z.string().max(120).optional(),
      dueDate: z.iso.date().optional(),
      estimatedCost: z.number().min(0).nullable().optional(),
      recurrenceDays: z.number().int().min(1).max(3650).nullable().optional().describe("Repeat this many days after done; null = one-off"),
      notes: z.string().max(1000).nullable().optional(),
      area: z.string().max(60).nullable().optional().describe("e.g. Water filtration, HVAC & heating, Exterior & stormwater"),
      parts: z.string().max(300).nullable().optional().describe("Parts or supplies needed"),
      lastDoneOn: z.iso.date().nullable().optional(),
      vehicleRef: z.string().max(12).nullable().optional().describe("Ref of the car (or equipment) from home_equipment this is for; null to unlink"),
      dueMileage: z.number().int().min(0).nullable().optional().describe("Cars: due at this odometer reading"),
      recurrenceMiles: z.number().int().min(1).max(200000).nullable().optional().describe("Cars: repeat every this many miles (with or instead of days)"),
      completedOn: z.iso.date().optional().describe("complete: the day it was done (default today)"),
      actualCost: z.number().min(0).max(1_000_000).nullable().optional().describe("complete: what it cost"),
      mileage: z.number().int().min(0).max(2_000_000).nullable().optional().describe("complete, cars: odometer reading when done"),
    },
    kind: "edit",
    scrub: "reference",
    async run(args, env) {
      if (kitchen(env) && args.vehicleRef !== undefined) throw new Error("Linking a car is done in the phone app.");
      const { action, ref, completedOn, actualCost, mileage, ...rest } = withAssetId(args as { action: string; ref?: string } & Fields, env);
      if (action === "complete" || action === "reopen") {
        const key = env.refs.resolve(String(ref ?? ""), "upkeep_task");
        const patch: Fields =
          action === "reopen"
            ? { completedOn: null }
            : {
                completedOn: (completedOn as string | undefined) ?? env.ctx.now.toISOString().slice(0, 10),
                ...(actualCost != null && { actualCost }),
                ...(mileage != null && { lastDoneMileage: mileage }),
              };
        const current = await adapterFor("upkeep_task").get(env.ctx, key);
        if (action === "complete" && current?.fields.completedOn) throw new Error("That task is already done. Reopen it first to change the completion.");
        if (action === "reopen" && current && !current.fields.completedOn) return queued(env, 0);
        // Reopening also clears the cost, and puts back the odometer reading it had before.
        if (action === "reopen") patch.actualCost = null;
        return queued(env, (await draftUpdate(env, "upkeep_task", key, patch)) ? 1 : 0);
      }
      return crud(env, "upkeep_task", action, ref, rest, {
        create: (f) => UpkeepFields.parse({ estimatedCost: null, recurrenceDays: null, notes: null, ...f }),
        update: (f) => UpkeepFields.partial().parse(f),
        label: (f) => `${f.title} (due ${f.dueDate})`,
      });
    },
  },
  {
    name: "edit_home_equipment",
    description:
      "Add, update or delete a piece of home equipment (furnace, roof, fridge) or a car (kind vehicle). update/delete need the ref from home_equipment. Never put serial, VIN, plate, model-registration or account numbers anywhere.",
    input: {
      action: ACTION,
      ref: z.string().max(12).optional(),
      name: z.string().max(80).optional(),
      kind: z.enum(maintenance.ASSET_KINDS).optional(),
      location: z.string().max(60).nullable().optional(),
      installedOn: z.iso.date().nullable().optional(),
      cost: z.number().min(0).nullable().optional(),
      notes: z.string().max(500).nullable().optional(),
      make: z.string().max(40).nullable().optional().describe("Cars only"),
      model: z.string().max(60).nullable().optional().describe("Cars only"),
      year: z.number().int().min(1950).max(2100).nullable().optional().describe("Cars only: model year"),
      mileage: z.number().int().min(0).nullable().optional().describe("Cars only: odometer reading"),
      mileageOn: z.iso.date().nullable().optional(),
    },
    kind: "edit",
    scrub: "reference",
    async run(args, env) {
      const { action, ref, ...rest } = args as { action: string; ref?: string } & Fields;
      if (action === "create") {
        const f = AssetFields.parse({ kind: "other", location: null, installedOn: null, cost: null, notes: null, ...rest });
        env.drafts.add({ entity: "upkeep_asset", op: "create", key: null, label: f.name, before: null, after: f });
        return queued(env, 1);
      }
      const key = env.refs.resolve(String(ref ?? ""), "upkeep_asset");
      if (action === "delete") {
        await draftDelete(env, "upkeep_asset", key);
        return queued(env, 1);
      }
      return queued(env, (await draftUpdate(env, "upkeep_asset", key, AssetFields.partial().parse(rest))) ? 1 : 0);
    },
  },
  {
    name: "edit_house_project",
    description: "Add, update or delete an entry in the house project and expense history. update/delete need the ref from house_projects. Leave out invoice, order and account numbers and people's full names.",
    input: {
      action: ACTION,
      ref: z.string().max(12).optional(),
      date: z.iso.date().nullable().optional(),
      period: z.string().max(40).nullable().optional().describe("When only a period is known, e.g. '2022 – 2023'"),
      title: z.string().max(120).optional(),
      vendor: z.string().max(120).nullable().optional(),
      description: z.string().max(1000).nullable().optional(),
      amount: z.number().min(0).nullable().optional(),
      amountNote: z.string().max(60).nullable().optional(),
      vehicleRef: z.string().max(12).nullable().optional().describe("Ref of the car (or equipment) from home_equipment this is for; null to unlink"),
    },
    kind: "edit",
    scrub: "reference",
    async run(args, env) {
      const { action, ref, ...rest } = withAssetId(args as { action: string; ref?: string } & Fields, env);
      if (action === "create") {
        const f = ProjectFields.parse({ date: null, period: null, vendor: null, description: null, amount: null, amountNote: null, ...rest });
        env.drafts.add({ entity: "house_project", op: "create", key: null, label: f.title, before: null, after: f });
        return queued(env, 1);
      }
      const key = env.refs.resolve(String(ref ?? ""), "house_project");
      if (action === "delete") {
        await draftDelete(env, "house_project", key);
        return queued(env, 1);
      }
      return queued(env, (await draftUpdate(env, "house_project", key, ProjectFields.partial().parse(rest))) ? 1 : 0);
    },
  },
  {
    name: "edit_shopping_item",
    description:
      "Add, update (rename, move to another store on its list, quantity, checked) or delete a shopping item. create takes an optional list name (default: the first active list). update/delete need the ref from shopping_list.",
    input: {
      action: ACTION,
      ref: z.string().max(12).optional(),
      name: z.string().max(80).optional(),
      store: z.string().max(40).optional(),
      quantity: z.string().max(20).nullable().optional(),
      checked: z.boolean().optional(),
      list: z.string().max(60).optional(),
    },
    kind: "edit",
    scrub: "reference",
    async run(args, env) {
      const { action, ref, ...rest } = args as { action: string; ref?: string } & Fields;
      if (action === "create") {
        const f = ShoppingFields.parse({ quantity: null, checked: false, list: null, ...rest });
        env.drafts.add({ entity: "shopping_item", op: "create", key: null, label: `${f.name} (${f.store})`, before: null, after: f });
        return queued(env, 1);
      }
      const key = env.refs.resolve(String(ref ?? ""), "shopping_item");
      if (action === "delete") {
        await draftDelete(env, "shopping_item", key);
        return queued(env, 1);
      }
      return queued(env, (await draftUpdate(env, "shopping_item", key, ShoppingFields.partial().parse(rest))) ? 1 : 0);
    },
  },
  {
    name: "edit_purchase_return",
    description: "Add, update (item, store, deadline, notes, status) or delete a store return. update/delete need the ref from purchase_returns. Never put card or order numbers in notes.",
    input: {
      action: ACTION,
      ref: z.string().max(12).optional(),
      itemName: z.string().max(80).optional(),
      store: z.string().max(40).optional(),
      returnDeadline: z.iso.date().nullable().optional(),
      notes: z.string().max(300).nullable().optional(),
      status: z.enum(family.RETURN_STATUSES).optional(),
    },
    kind: "edit",
    scrub: "reference",
    async run(args, env) {
      const { action, ref, ...rest } = args as { action: string; ref?: string } & Fields;
      if (action === "create") {
        const f = ReturnFields.parse({ returnDeadline: null, notes: null, status: "pending", ...rest });
        env.drafts.add({ entity: "purchase_return", op: "create", key: null, label: `${f.itemName} (${f.store})`, before: null, after: f });
        return queued(env, 1);
      }
      const key = env.refs.resolve(String(ref ?? ""), "purchase_return");
      if (action === "delete") {
        await draftDelete(env, "purchase_return", key);
        return queued(env, 1);
      }
      return queued(env, (await draftUpdate(env, "purchase_return", key, ReturnFields.partial().parse(rest))) ? 1 : 0);
    },
  },
  {
    name: "edit_kid",
    description:
      "Kids on the chore board, by first name only (never a surname). create (name, optional emoji); update (kidRef from chores: name, emoji); remove (hides the kid from the board; chores and history stay, undo brings them back). Add their chores with edit_chore in the same reply.",
    input: {
      action: z.enum(["create", "update", "remove"]),
      ref: z.string().max(12).optional().describe("kidRef from chores"),
      name: z.string().max(30).optional(),
      emoji: z.string().max(8).optional(),
    },
    kind: "edit",
    scrub: "reference",
    async run(args, env) {
      const { action, ref, ...rest } = args as { action: string; ref?: string } & Fields;
      return crud(env, "kid", action === "remove" ? "delete" : action, ref, rest, {
        create: (f) => KidFields.parse({ emoji: "⭐", ...f }),
        update: (f) => KidFields.partial().parse(f),
        label: (f) => String(f.name),
      });
    },
  },
  {
    name: "edit_chore",
    description:
      "Kids' chores. create (kid's name, title, optional icon emoji, daily/weekly/once, stars 1 to 5); update (ref from chores: title, icon, recurrence, stars); mark_done / mark_not_done for the current period; archive (history stays, undo brings it back).",
    input: {
      action: z.enum(["create", "update", "mark_done", "mark_not_done", "archive"]),
      ref: z.string().max(12).optional(),
      kid: z.string().max(40).optional().describe("create: the kid's name as on the chore board"),
      title: z.string().max(60).optional(),
      icon: z.string().max(8).optional().describe("One emoji"),
      recurrence: z.enum(["daily", "weekly", "once"]).optional().describe("Default daily"),
      stars: z.number().int().min(1).max(5).optional().describe("Default 1"),
    },
    kind: "edit",
    scrub: "reference",
    async run(args, env) {
      const { action, ref, ...rest } = args as { action: string; ref?: string } & Fields;
      if (action === "create") {
        const f = ChoreFields.parse({ icon: "✅", recurrence: "daily", stars: 1, done: false, ...rest });
        return draftCreate(env, "chore", `${f.kid}: ${f.title} (${f.recurrence})`, f);
      }
      const key = env.refs.resolve(String(ref ?? ""), "chore");
      if (action === "archive") {
        await draftDelete(env, "chore", key);
        return queued(env, 1);
      }
      if (action === "update") {
        const patch = ChoreFields.omit({ kid: true, done: true }).partial().parse(rest);
        return queued(env, (await draftUpdate(env, "chore", key, patch)) ? 1 : 0);
      }
      return queued(env, (await draftUpdate(env, "chore", key, { done: action === "mark_done" })) ? 1 : 0);
    },
  },
  {
    name: "edit_reading_log",
    description:
      "Kids' reading log. create (kid's name, book, language en or ru, minutes, optional pages, optional date (on the kitchen screen the last 14 days; in the app up to a year back, e.g. copying a paper log), default today); update (ref from reading_log: book, language, minutes, pages, date); delete. A day counts with 20 minutes in English or 15 in Russian; milestone stars follow automatically.",
    input: {
      action: ACTION,
      ref: z.string().max(12).optional(),
      kid: z.string().max(40).optional(),
      day: z.iso.date().optional(),
      book: z.string().max(80).optional(),
      language: z.enum(["en", "ru"]).optional(),
      minutes: z.number().int().min(1).max(600).optional(),
      pages: z.number().int().min(0).max(2000).nullable().optional(),
    },
    kind: "edit",
    scrub: "reference",
    async run(args, env) {
      const { action, ref, ...rest } = args as { action: string; ref?: string } & Fields;
      return crud(env, "reading_entry", action, ref, rest, {
        create: (f) => ReadingFields.partial({ day: true, pages: true }).parse({ pages: null, ...f }),
        update: (f) => ReadingFields.omit({ kid: true }).partial().parse(f),
        label: (f) => `${f.kid}: ${f.book}, ${f.minutes} min ${f.language === "ru" ? "Russian" : "English"}${f.day ? ` (${f.day})` : ""}`,
      });
    },
  },
  {
    name: "edit_chore_goal",
    description:
      "Kids' chore goals with a reward, e.g. read 10 days in a row -> a prize. create (kid's name, the chore's title on their board, which must be daily or weekly, streak or count, target 2 to 365, reward, optional emoji; a chore added in the same reply works); update (ref from chore_goals: target, reward, emoji, rewardGiven); archive.",
    input: {
      action: z.enum(["create", "update", "archive"]),
      ref: z.string().max(12).optional(),
      kid: z.string().max(40).optional(),
      chore: z.string().max(60).optional().describe("create: the chore's title"),
      kind: z.enum(["streak", "count"]).optional().describe("streak = N in a row (days for daily chores, weeks for weekly); count = N times in all"),
      target: z.number().int().min(2).max(365).optional(),
      reward: z.string().max(80).optional(),
      rewardEmoji: z.string().max(8).optional(),
      rewardGiven: z.boolean().optional().describe("update: the reward was handed over"),
    },
    kind: "edit",
    scrub: "reference",
    async run(args, env) {
      const { action, ref, ...rest } = args as { action: string; ref?: string } & Fields;
      return crud(env, "chore_goal", action === "archive" ? "delete" : action, ref, rest, {
        create: (f) => GoalFields.parse({ kind: "streak", rewardEmoji: "🎁", rewardGiven: false, ...f }),
        update: (f) => GoalFields.pick({ target: true, reward: true, rewardEmoji: true, rewardGiven: true }).partial().parse(f),
        label: (f) => `${f.kid}: ${f.chore} ${f.target} ${f.kind === "streak" ? "in a row" : "times"} for ${f.reward}`,
      });
    },
  },
  {
    name: "edit_shopping_list",
    description:
      "Whole shopping lists. create (name, optionally from a template by name, optionally put off until a date); update (ref from shopping_lists: rename, or deferredUntil to put it off, null to bring it back); delete (removes its items too; undo rebuilds it). Add items with edit_shopping_item and the list's name.",
    input: {
      action: ACTION,
      ref: z.string().max(12).optional(),
      name: z.string().max(60).optional(),
      template: z.string().max(60).optional().describe("create: template name from shopping_lists"),
      deferredUntil: z.iso.date().nullable().optional(),
    },
    kind: "edit",
    scrub: "reference",
    async run(args, env) {
      const { action, ref, ...rest } = args as { action: string; ref?: string } & Fields;
      return crud(env, "shopping_list", action, ref, rest, {
        create: (f) => ShoppingListFields.parse({ deferredUntil: null, template: null, ...f }),
        update: (f) => ShoppingListFields.omit({ template: true }).partial().parse(f),
        label: (f) => String(f.name),
      });
    },
  },
  {
    name: "edit_shopping_template",
    description:
      "Shopping list templates (stores with their usual items) to start lists from. create (name plus stores, or fromListRef to copy a list's stores and items); update (ref from shopping_lists: name, or stores to replace all its stores and items); delete.",
    input: {
      action: ACTION,
      ref: z.string().max(12).optional(),
      name: z.string().max(60).optional(),
      stores: z
        .array(z.object({ store: z.string().min(1).max(40), items: z.array(z.object({ name: z.string().min(1).max(80), quantity: z.string().max(20).nullable().optional() })).max(200) }))
        .max(30)
        .optional(),
      fromListRef: z.string().max(12).optional().describe("create: copy this list's stores and items"),
    },
    kind: "edit",
    scrub: "reference",
    async run(args, env) {
      const { action, ref, fromListRef, ...rest } = args as { action: string; ref?: string; fromListRef?: string } & Fields;
      if (action === "create" && fromListRef) {
        const list = await family.getList(env.refs.resolve(fromListRef, "shopping_list"), env.ctx.now);
        if (!list) throw new Error("That list is gone.");
        rest.stores = list.sections.map((sec) => ({ store: sec.store, items: sec.items.map((i) => ({ name: i.name, quantity: i.quantity })) }));
      }
      const withQty = (f: Fields) =>
        f.stores === undefined
          ? f
          : { ...f, stores: (f.stores as { store: string; items: { name: string; quantity?: string | null }[] }[]).map((x) => ({ ...x, items: x.items.map((i) => ({ name: i.name, quantity: i.quantity ?? null })) })) };
      return crud(env, "shopping_template", action, ref, rest, {
        create: (f) => TemplateFields.parse(withQty(f)),
        update: (f) => TemplateFields.partial().parse(withQty(f)),
        label: (f) => String(f.name),
      });
    },
  },
  {
    name: "edit_calendar_event",
    description:
      "Events on the family Google calendar. create (title, startDate, and either allDay or startTime and endTime in 24-hour HH:MM household time; endDate for multi-day events; location, notes); update (ref from calendar); delete. Repeating events can't be changed here. Never put account, card or confirmation numbers in notes.",
    input: {
      action: ACTION,
      ref: z.string().max(12).optional(),
      title: z.string().max(200).optional(),
      location: z.string().max(200).nullable().optional(),
      notes: z.string().max(2000).nullable().optional(),
      allDay: z.boolean().optional(),
      startDate: z.iso.date().optional(),
      endDate: z.iso.date().optional().describe("Last day, inclusive (default startDate)"),
      startTime: z.string().max(5).nullable().optional().describe("HH:MM"),
      endTime: z.string().max(5).nullable().optional().describe("HH:MM"),
    },
    kind: "edit",
    scrub: "reference",
    async run(args, env) {
      const { action, ref, ...rest } = args as { action: string; ref?: string } & Fields;
      if (action !== "create") {
        const e = await calendar.familyEventForEdit(env.refs.resolve(String(ref ?? ""), "calendar_event"));
        if (e?.recurring) throw new Error("That event repeats. Repeating events are changed in Google Calendar itself.");
      }
      return crud(env, "calendar_event", action, ref, rest, {
        create: (f) => {
          const allDay = f.allDay ?? !(f.startTime && f.endTime);
          return CalendarEventFields.parse({ location: null, notes: null, startTime: null, endTime: null, ...f, allDay, endDate: f.endDate ?? f.startDate });
        },
        update: (f) => CalendarEventFields.partial().parse(f),
        label: (f) => `${f.title} (${f.startDate}${f.allDay ? "" : ` ${f.startTime}`})`,
      });
    },
  },
  {
    name: "edit_binder_entry",
    description:
      "Home binder entries: manuals, warranties, insurance, property tax, receipts. create (category, title, provider, equipmentRef or projectRef to link, startsOn, expiresOn (warranty end, renewal or due date; a reminder is set automatically), amount, url, notes); update (ref from home_binder); delete (only entries without a file). Files are added in the binder page. Never store policy, account or serial numbers.",
    input: {
      action: ACTION,
      ref: z.string().max(12).optional(),
      category: z.enum(maintenance.BINDER_CATEGORIES).optional(),
      title: z.string().max(120).optional(),
      provider: z.string().max(120).nullable().optional(),
      equipmentRef: z.string().max(12).nullable().optional().describe("Ref from home_equipment; null to unlink"),
      projectRef: z.string().max(12).nullable().optional().describe("Ref from house_projects; null to unlink"),
      startsOn: z.iso.date().nullable().optional(),
      expiresOn: z.iso.date().nullable().optional(),
      amount: z.number().min(0).nullable().optional(),
      url: z.string().max(500).nullable().optional(),
      notes: z.string().max(1000).nullable().optional(),
    },
    kind: "edit",
    scrub: "reference",
    async run(args, env) {
      const { action, ref, equipmentRef, projectRef, ...rest } = args as { action: string; ref?: string; equipmentRef?: string | null; projectRef?: string | null } & Fields;
      if (equipmentRef !== undefined) rest.assetId = equipmentRef == null ? null : env.refs.resolve(equipmentRef, "upkeep_asset");
      if (projectRef !== undefined) rest.projectId = projectRef == null ? null : env.refs.resolve(projectRef, "house_project");
      return crud(env, "binder_entry", action, ref, rest, {
        create: (f) => BinderFields.parse({ category: "other", provider: null, assetId: null, projectId: null, startsOn: null, expiresOn: null, amount: null, url: null, notes: null, ...f }),
        update: (f) => BinderFields.partial().parse(f),
        label: (f) => String(f.title),
      });
    },
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

/**
 * The kitchen screen's tools: its own modules only (calendar, chores and
 * goals, shopping, returns, upkeep). No money, trips, equipment, binder,
 * research or anything else; KITCHEN_ENTITIES and kitchenRefusal() back
 * this up when changes are applied.
 */
export const KITCHEN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "calendar",
  "chores",
  "chore_goals",
  "reading_log",
  "shopping_list",
  "shopping_lists",
  "purchase_returns",
  "upkeep_tasks",
  "edit_calendar_event",
  "edit_chore",
  "edit_chore_goal",
  "edit_reading_log",
  "edit_shopping_item",
  "edit_shopping_list",
  "edit_shopping_template",
  "edit_purchase_return",
  "edit_upkeep_task",
]);

export const KITCHEN_TOOLS = TOOLS.filter((t) => KITCHEN_TOOL_NAMES.has(t.name));

/** Runs a tool and returns what the model may see: scrubbed JSON, or an error message. */
export async function runTool(tool: AssistantTool, rawArgs: unknown, env: ToolEnv): Promise<string> {
  try {
    const args = z.object(tool.input).parse(rawArgs ?? {});
    const result = await tool.run(args, env);
    return JSON.stringify(forAssistant(result ?? null, tool.scrub));
  } catch (e) {
    const msg = e instanceof z.ZodError ? z.prettifyError(e) : e instanceof Error ? e.message : "failed";
    return JSON.stringify({ error: forAssistant(msg.slice(0, 400), "reference") });
  }
}
