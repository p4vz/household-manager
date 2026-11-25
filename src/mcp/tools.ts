import "server-only";
import { z } from "zod";
import type { OwnerLabel } from "@/core/auth/allowlist";
import { householdNicknames } from "@/core/ai/sanitize";
import { THE_RULE, type PermissionKey } from "@/core/oauth/permissions";
import * as calendar from "@/modules/calendar/api";
import * as finance from "@/modules/finance/api";
import * as maintenance from "@/modules/maintenance/api";
import * as trips from "@/modules/trips/api";
import { AppLink, SharedBookingCode, ownerLabel, type ScrubMode } from "./sanitize";

/**
 * The assistant's tools. Every one is read-only and calls module APIs only
 * (never tables), the same way pages do. Answers are built field by field
 * and scrubbed by the server (see ./sanitize.ts) before they leave.
 *
 * Each tool lists the permissions it needs (`requires`, all of them); the
 * server only registers tools the connection was granted. Fields that need
 * a further permission (`can(...)`) are left out unless it was granted too.
 */

export type ToolContext = {
  owner: OwnerLabel;
  now: Date;
  permissions: ReadonlySet<PermissionKey>;
  /** This app's origin, for links back to its pages. */
  appUrl: string | null;
  /** The connection, for tools that make changes (src/assistant/connector.ts). */
  caller?: { grantId: string; email: string };
};

/**
 * Finance answers cover what the member this assistant acts for can see in
 * the app: joint accounts and their own, never the other member's.
 */
const viewerOf = (ctx: ToolContext) => finance.viewerFromLabel(ctx.owner);

export type AssistantTool = {
  name: string;
  title: string;
  description: string;
  input: z.ZodRawShape;
  requires: PermissionKey[];
  scrub: ScrubMode;
  /** Changes household data (only the "Make changes" tools, as changesets with Undo). */
  writes?: boolean;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const dollars = (cents: number) => r2(cents / 100);
/** Copy of `obj` without internal keys (account ids and the like). */
function without<T extends object, K extends keyof T>(obj: T, ...keys: K[]): Omit<T, K> {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}
const dayOf = (v: Date | string | null | undefined) => (v == null ? null : typeof v === "string" ? v.slice(0, 10) : isoDay(v));

function capText(amount: number | null, period: string | null) {
  return amount == null ? null : `first $${amount.toLocaleString("en-US")} per ${period ?? "year"}`;
}

function quarterOf(day: string) {
  const [y, m] = day.split("-").map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

/** Terms of held cards by account id, for FX fees, credits and perks. */
async function termsByAccount(viewer: finance.Viewer) {
  return new Map((await finance.heldCardTerms(viewer)).map((t) => [t.accountId, t]));
}

/**
 * Link to one booking on the trip's itinerary page, where the person sees
 * its confirmation code. Lets an assistant point to the code without
 * reading it.
 */
function bookingLink(appUrl: string | null, tripSlug: string, stepId: string) {
  return appUrl ? new AppLink(`${appUrl}/trips/${tripSlug}/itinerary#step-${stepId}`) : undefined;
}

async function findTrip(slug: string) {
  const trip = await trips.getTrip(slug);
  if (!trip) throw new Error(`No trip "${slug}". Call list_trips for the trip ids.`);
  return trip;
}

const purchaseInput = z.object({
  description: z.string().min(1).max(80).describe('What it is, e.g. "Marriott Rome, 3 nights" or "United PHL-ZRH"'),
  amount: z.number().positive().max(100_000).describe("Expected charge in US dollars"),
  kind: z.enum(finance.PURCHASE_KINDS).describe("Spend category the charge will code to"),
  merchant: z.string().max(60).optional().describe('Who charges the card, e.g. "Marriott", "Delta", "Amazon"'),
  chargeDate: z.iso.date().optional().describe("When the charge posts (YYYY-MM-DD). Default today. For prepaid bookings this is the booking date, not the travel date."),
  international: z.boolean().optional().describe("True when charged in a foreign currency or by a foreign merchant"),
});

export const TOOLS: AssistantTool[] = [
  {
    name: "list_my_cards",
    title: "List household cards and benefits",
    description:
      "The household's active credit cards with owner label, annual fee, base earn rate, point value, bonus categories with caps, this quarter's rotating categories, statement credits, perks, foreign transaction fee, and any open sign-up bonus with progress. Start here for any question about card benefits.",
    input: {
      owner: z.enum(["all", "User 1", "User 2", "Joint"]).optional().describe("Only cards held by this person (default all)"),
    },
    requires: ["finance.cards"],
    scrub: "finance",
    async run(args, ctx) {
      const { now, permissions } = ctx;
      const today = isoDay(now);
      const [cards, terms, bonuses] = await Promise.all([finance.listCardsWithProfiles(viewerOf(ctx)), termsByAccount(viewerOf(ctx)), finance.signupBonusOverview(viewerOf(ctx), now)]);
      const quarter = quarterOf(today);
      const bonusBy = new Map(bonuses.map((b) => [b.accountId, b]));
      return cards
        .map((c) => {
          const t = terms.get(c.accountId);
          const p = c.profile;
          const rotating = t?.terms.rotating;
          const thisQuarter = rotating?.quarters.find((q) => q.quarter === quarter);
          const b = bonusBy.get(c.accountId);
          return {
            card: c.name,
            owner: ownerLabel(c.owner),
            product: t?.product ?? null,
            rewardsSetUp: Boolean(p),
            rewardType: p?.rewardType ?? t?.terms.rewardType ?? null,
            rewardCurrency: t?.terms.rewardCurrency ?? null,
            annualFee: p?.annualFee ?? t?.terms.annualFee ?? null,
            annualFeeMonth: p?.annualFeeMonth ?? null,
            baseRate: p?.baseRate ?? null,
            pointValueCents: p?.centsPerUnit ?? null,
            bonusCategories: c.rules
              .filter((r) => !r.validTo || r.validTo >= today)
              .map((r) => ({
                on: r.label ?? `${r.matchType} ${r.match}`,
                rate: r.rate,
                cap: capText(r.capAmount, r.capPeriod),
                validFrom: r.validFrom,
                validTo: r.validTo,
              })),
            rotatingThisQuarter: rotating
              ? {
                  quarter,
                  categories: thisQuarter?.description ?? "not announced or not on file yet",
                  rate: rotating.rate,
                  cap: capText(rotating.capAmount, "quarter"),
                  activationRequired: rotating.activationRequired,
                }
              : null,
            foreignTransactionFee: t?.terms.foreignTransactionFee ?? null,
            credits: t?.terms.credits ?? [],
            perks: t?.terms.perks ?? [],
            signupBonus: b && permissions.has("finance.signup_bonuses")
              ? { minSpend: b.minSpend, spent: b.spent, remaining: b.remaining, deadline: b.deadline, daysLeft: b.daysLeft, bonusValue: b.bonusValue }
              : null,
            termsVerifiedDate: dayOf(t?.verifiedAt),
          };
        })
        .filter((c) => !args.owner || args.owner === "all" || c.owner === args.owner);
    },
  },
  {
    name: "best_card_for_purchases",
    title: "Best card for a purchase or booking",
    description:
      "Which household card to put one or more planned purchases on (flights, hotels, dinners, anything). Uses each card's real multipliers, caps already used this year, rotating categories and open sign-up bonuses: when a welcome bonus still needs spend before its deadline, purchases are routed there first if that actually completes it. Returns the recommendation, why, the value earned on each card, and bonus progress including the planned spend. Plans only; nothing is booked or charged.",
    input: { purchases: z.array(purchaseInput).min(1).max(20) },
    requires: ["finance.card_advice"],
    scrub: "finance",
    async run(args, ctx) {
      const { now, permissions } = ctx;
      const items = z.array(purchaseInput).parse(args.purchases);
      const today = isoDay(now);
      const planned = items.map((p, i) => ({
        ref: `p${i + 1}`,
        date: p.chargeDate && p.chargeDate > today ? p.chargeDate : today,
        amount: p.amount,
        merchant: p.merchant ?? p.description,
        ...finance.PURCHASE_CATEGORY[p.kind],
      }));
      const [plan, terms] = await Promise.all([finance.planCardsForPurchases(viewerOf(ctx), planned, now), termsByAccount(viewerOf(ctx))]);
      if (plan.cards.length === 0) {
        return { note: "No card has a rewards profile yet. Set them up under Finance > Rewards in the app first." };
      }
      const hasFxFee = (accountId: string) => terms.get(accountId)?.terms.foreignTransactionFee ?? null;
      const byRef = new Map(plan.purchases.map((p) => [p.ref, p]));
      return {
        purchases: items.map((item, i) => {
          const p = byRef.get(`p${i + 1}`);
          if (!p) return { description: item.description, note: "Nothing to plan for this amount" };
          const fx = item.international ? hasFxFee(p.recommended.accountId) : null;
          const noFee = item.international ? p.options.find((o) => hasFxFee(o.accountId) === false) : undefined;
          return {
            description: item.description,
            amount: item.amount,
            useCard: p.recommended.card,
            reason: p.reason === "bonus" ? "completes an open sign-up bonus" : "highest earn on this purchase",
            rewardValue: dollars(p.recommended.cents),
            bestOnMultiplierAlone: p.reason === "bonus" ? { card: p.bestMultiplier.card, rewardValue: dollars(p.bestMultiplier.cents) } : null,
            foreignTransactionFeeWarning:
              fx === true ? `${p.recommended.card} charges a foreign transaction fee (about 3%).${noFee ? ` ${noFee.card} does not.` : ""}` : null,
            allCards: p.options.map((o) => ({ card: o.card, rewardValue: dollars(o.cents), foreignTransactionFee: hasFxFee(o.accountId) })),
          };
        }),
        signupBonuses: permissions.has("finance.signup_bonuses") ? plan.bonuses.map((b) => without(b, "accountId")) : undefined,
        note: "Reward values are in dollars at each card's stored point value. Statement credits and perks are in list_my_cards.",
      };
    },
  },
  {
    name: "signup_bonus_progress",
    title: "Sign-up bonus progress",
    description: "Open welcome offers on household cards: minimum spend, spent so far (purchases net of refunds), what is left, deadline and the bonus value.",
    input: {},
    requires: ["finance.signup_bonuses"],
    scrub: "finance",
    async run(_args, ctx) {
      const { now } = ctx;
      return (await finance.signupBonusOverview(viewerOf(ctx), now)).map((b) => without(b, "accountId", "planned", "metWithPlan"));
    },
  },
  {
    name: "points_left_on_the_table",
    title: "Points left on the table",
    description:
      "Audit of actual card use: rewards earned vs what the best household card would have earned on the same purchases, by category, by card (earned minus annual fee) and the biggest single misses. Use it to suggest which card to use for what.",
    input: { range: z.enum(["3M", "6M", "12M", "YTD"]).optional().describe("Period to audit (default 12M)") },
    requires: ["finance.rewards_audit"],
    scrub: "finance",
    async run(args, ctx) {
      const { now, permissions } = ctx;
      const { cards, audit } = await finance.rewardsAudit(viewerOf(ctx), (args.range as "3M" | "6M" | "12M" | "YTD" | undefined) ?? "12M", now);
      if (!audit) return { note: "No card has a rewards profile yet.", cards: cards.length };
      return {
        totalEarned: audit.totalEarned,
        totalMissed: audit.totalMissed,
        perCard: audit.perCard,
        missedByCategory: audit.byCategory.slice(0, 12),
        // Individual purchases only with the transactions permission.
        biggestMisses: !permissions.has("finance.transactions") ? undefined : audit.topMisses.slice(0, 10).map((m) => ({
          date: m.date,
          merchant: m.merchant,
          category: [m.category, m.subcategory].filter(Boolean).join(" / ") || null,
          amount: m.amount,
          usedCard: m.actualCard,
          bestCard: m.bestCard,
          missed: dollars(m.missedCents),
        })),
      };
    },
  },
  {
    name: "cards_worth_getting",
    title: "Cards worth adding",
    description:
      "Cards from the stored catalog the household does not hold, priced against the last 12 months of real spending: yearly rewards added on top of current cards, minus the fee, with the current sign-up offer and credits listed separately.",
    input: { limit: z.number().int().min(1).max(15).optional().describe("How many to return (default 5)") },
    requires: ["finance.card_catalog"],
    scrub: "finance",
    async run(args, ctx) {
      const { now } = ctx;
      const rows = await finance.catalogComparison(viewerOf(ctx), "12M", now);
      return rows.slice(0, (args.limit as number | undefined) ?? 5).map((r) => ({
        ...without(r, "id", "verifiedAt"),
        termsVerifiedDate: dayOf(r.verifiedAt),
      }));
    },
  },
  {
    name: "lookup_card_terms",
    title: "Look up a card's published terms",
    description:
      "Stored, regularly refreshed terms of a card product by name (held or not): fee, earn rates, rotating categories, sign-up offer, credits, perks, the date they were last verified against the issuer, and sources.",
    input: { query: z.string().min(2).max(60).describe('e.g. "Sapphire Reserve", "Amex Gold", "Freedom Flex"') },
    requires: ["finance.card_catalog"],
    scrub: "reference",
    async run(args) {
      const words = String(args.query).toLowerCase().split(/\s+/).filter(Boolean);
      const all = await finance.cardCatalog();
      const hits = all.filter((p) => {
        const hay = `${p.issuer} ${p.name}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      if (hits.length === 0) return { note: "Not in the catalog.", available: all.map((p) => `${p.issuer} ${p.name}`) };
      return hits.slice(0, 5).map((p) => ({
        card: `${p.issuer} ${p.name}`,
        householdHoldsIt: p.held,
        terms: p.terms,
        termsVerifiedDate: dayOf(p.verifiedAt),
        sources: p.sourceUrls,
      }));
    },
  },
  {
    name: "list_trips",
    title: "List trips",
    description: "Household trips with dates, places, budget and status. The `trip` value is the id other trip tools take.",
    input: { includePast: z.boolean().optional().describe("Include trips that have ended (default false)") },
    requires: ["travel.trips"],
    scrub: "reference",
    async run(args, { now }) {
      const today = isoDay(now);
      return (await trips.listTrips())
        .filter((t) => args.includePast || t.endDate >= today)
        .map((t) => ({ trip: t.slug, name: t.name, places: t.destination, startDate: t.startDate, endDate: t.endDate, budget: t.budget, status: t.status }));
    },
  },
  {
    name: "get_trip",
    title: "Trip itinerary",
    description:
      "One trip's places and itinerary: each step's kind, times (UTC, with departure and arrival time zones), place, provider, booking status, when booking opens, re-check date, cost, which card paid, and a link to the step's page in the household app. Booking codes are included only where the household shared them (`bookingCode`); otherwise `codeInApp` says the code is on that page. Documents and traveller names are not available.",
    input: { trip: z.string().min(1).max(120).describe("Trip id from list_trips") },
    requires: ["travel.trips", "travel.itinerary"],
    scrub: "reference",
    async run(args, { permissions, appUrl }) {
      const trip = await findTrip(String(args.trip));
      const bookings = permissions.has("travel.bookings");
      // Codes need both switches: this connection's permission and the trip's own.
      const codes = bookings && permissions.has("travel.booking_codes") && trip.shareBookingCodes;
      const [items, cards] = await Promise.all([trips.listItinerary(trip.id), trips.listCreditCards()]);
      const cardName = new Map(cards.map((c) => [c.accountId, c.name]));
      return {
        trip: trip.slug,
        name: trip.name,
        startDate: trip.startDate,
        endDate: trip.endDate,
        budget: trip.budget,
        status: trip.status,
        ...(bookings
          ? {
              bookingCodes: codes
                ? "shared for this trip"
                : "kept in the app: send the person the step's link, where the code is shown. Never ask for or guess a code.",
            }
          : {}),
        places: trip.destinations.map((d) => ({ name: d.name, country: d.country, arriveOn: d.arriveOn, departOn: d.departOn })),
        itinerary: items.map((i) => ({
          kind: i.kind,
          title: i.title,
          startsAt: i.startsAt,
          endsAt: i.endsAt,
          timezone: i.timezone,
          endTimezone: i.endTimezone,
          location: i.location,
          provider: i.provider,
          notes: i.notes,
          link: bookingLink(appUrl, trip.slug, i.id),
          ...(bookings
            ? {
                bookingStatus: i.bookingStatus,
                bookingCode: codes && i.confirmation ? new SharedBookingCode(i.confirmation) : undefined,
                codeInApp: !codes && Boolean(i.confirmation?.trim()) ? true : undefined,
                bookingOpensOn: i.bookingOpensOn,
                verifyBy: i.verifyBy,
                cost: i.cost,
                paidWith: i.paidWithAccountId ? (cardName.get(i.paidWithAccountId) ?? "an inactive card") : null,
              }
            : {}),
        })),
      };
    },
  },
  {
    name: "trip_card_plan",
    title: "Which card for each trip booking",
    description:
      "For a trip's unpaid bookings with a cost: the card to book each one with (open sign-up bonuses first, then the best multiplier) and how the trip's spend moves each bonus toward its minimum.",
    input: { trip: z.string().min(1).max(120).describe("Trip id from list_trips") },
    requires: ["travel.trips", "travel.bookings", "finance.card_advice"],
    scrub: "finance",
    async run(args, ctx) {
      const { now, permissions, appUrl } = ctx;
      const trip = await findTrip(String(args.trip));
      const plan = await trips.tripCardPlan(viewerOf(ctx), trip.id, now);
      if (!plan.hasProfiles) return { note: "No card has a rewards profile yet." };
      return {
        trip: trip.name,
        steps: plan.steps.map((s) => ({
          kind: s.kind,
          title: s.title,
          provider: s.provider,
          cost: s.cost,
          chargeDate: s.chargeDate,
          bookingStatus: s.bookingStatus,
          alreadyPaidWith: s.paidWith,
          useCard: s.plan?.recommended.card ?? null,
          reason: s.plan ? (s.plan.reason === "bonus" ? "completes an open sign-up bonus" : "highest earn") : null,
          rewardValue: s.plan ? dollars(s.plan.recommended.cents) : null,
          link: bookingLink(appUrl, trip.slug, s.id),
        })),
        signupBonuses: permissions.has("finance.signup_bonuses") ? plan.bonuses.map((b) => without(b, "accountId")) : undefined,
      };
    },
  },
  {
    name: "booking_checklist",
    title: "Bookings still to do",
    description: "Across upcoming trips: steps still to book, and booked steps with a re-check date, soonest deadline first. Each has a link to its page in the household app.",
    input: {},
    requires: ["travel.bookings"],
    scrub: "reference",
    async run(_args, { now, appUrl }) {
      return (await trips.outstandingBookings(isoDay(now))).map((r) => ({
        trip: r.tripSlug,
        ...without(r, "id", "tripSlug"),
        link: bookingLink(appUrl, r.tripSlug, r.id),
      }));
    },
  },
  {
    name: "spending_summary",
    title: "Spending by category",
    description: "Aggregate spending (net of refunds, excluding transfers) by category with subcategories, by month, and the top merchants, for a period. Totals only, no individual transactions.",
    input: {
      range: z.enum(["3M", "6M", "12M", "YTD"]).optional().describe("Period (default 3M)"),
      owner: z.enum(["all", "User 1", "User 2", "Joint"]).optional().describe("Whose accounts (default all)"),
    },
    requires: ["finance.spending"],
    scrub: "finance",
    async run(args, ctx) {
      const { now } = ctx;
      return finance.spendingSummary(viewerOf(ctx), (args.range as finance.RangeKey | undefined) ?? "3M", ownerFilter(args.owner), now);
    },
  },
  {
    name: "income_and_savings",
    title: "Income and savings rate",
    description: "Income vs spending per month, totals, and the savings rate for a period. Historical actuals only.",
    input: {
      range: z.enum(["3M", "6M", "12M", "YTD"]).optional().describe("Period (default 12M)"),
      owner: z.enum(["all", "User 1", "User 2", "Joint"]).optional().describe("Whose accounts (default all)"),
    },
    requires: ["finance.income"],
    scrub: "finance",
    async run(args, ctx) {
      const { now } = ctx;
      return finance.cashFlowSummary(viewerOf(ctx), (args.range as finance.RangeKey | undefined) ?? "12M", ownerFilter(args.owner), now);
    },
  },
  {
    name: "list_transactions",
    title: "Recent transactions",
    description: "Individual transactions, newest first: date, merchant, category, amount (negative = spend), card or account nickname and owner label. Optional filters by date, category or merchant text.",
    input: {
      since: z.iso.date().optional().describe("Only on or after this date"),
      category: z.string().max(60).optional().describe('Category or subcategory, e.g. "Travel", "Restaurants"'),
      merchant: z.string().max(60).optional().describe("Text the merchant name contains"),
      limit: z.number().int().min(1).max(100).optional().describe("Default 50"),
    },
    requires: ["finance.transactions"],
    scrub: "finance",
    async run(args, ctx) {
      const cat = typeof args.category === "string" ? args.category.toLowerCase() : null;
      const merch = typeof args.merchant === "string" ? args.merchant.toLowerCase() : null;
      const since = typeof args.since === "string" ? args.since : null;
      return (await finance.listRecentTransactions(viewerOf(ctx), 500))
        .filter((t) => !since || t.date >= since)
        .filter((t) => !cat || t.category?.toLowerCase() === cat || t.subcategory?.toLowerCase() === cat)
        .filter((t) => !merch || t.merchant.toLowerCase().includes(merch))
        .slice(0, (args.limit as number | undefined) ?? 50)
        .map((t) => ({
          date: t.date,
          merchant: t.merchant,
          category: [t.category, t.subcategory].filter(Boolean).join(" / ") || null,
          amount: t.amount,
          pending: t.pending,
          transfer: t.isTransfer,
          account: t.account ?? "Unnamed account",
          owner: ownerLabel(t.owner),
        }));
    },
  },
  {
    name: "account_balances",
    title: "Account balances",
    description: "Active accounts by nickname with owner label, type (checking, savings, credit, loan, investment) and current balance. Never account numbers.",
    input: {},
    requires: ["finance.assets"],
    scrub: "finance",
    async run(_args, ctx) {
      // Only accounts this member can see in Finance (never the other's balances).
      const rows = (await finance.listAccounts(viewerOf(ctx))).filter((a) => a.active && a.visible);
      return rows.map((a) => ({
        account: a.displayName ?? `${a.kind} account`,
        owner: ownerLabel(a.owner),
        type: a.kind,
        balance: a.balance,
        currency: a.currency,
      }));
    },
  },
  {
    name: "house_upkeep_tasks",
    title: "House upkeep tasks",
    description: "Open home maintenance tasks with due dates and estimated costs.",
    input: {},
    requires: ["home.tasks"],
    scrub: "reference",
    async run() {
      return (await maintenance.listOpenTasks()).map((t) => ({ task: t.title, dueDate: t.dueDate, estimatedCost: t.estimatedCost }));
    },
  },
  {
    name: "upcoming_events",
    title: "Upcoming calendar events",
    description: "Household calendar events from today on: trips, maintenance reminders, annual-fee reminders and others.",
    input: { limit: z.number().int().min(1).max(50).optional().describe("Default 20") },
    requires: ["calendar.events"],
    scrub: "reference",
    async run(args, { now }) {
      return (await calendar.listUpcoming(isoDay(now), (args.limit as number | undefined) ?? 20)).map((e) => ({
        title: e.title,
        startDate: e.startDate,
        endDate: e.endDate,
        from: e.sourceModule,
      }));
    },
  },
];

function ownerFilter(owner: unknown): finance.OwnerFilter {
  return owner === "User 1" ? "user1" : owner === "User 2" ? "user2" : owner === "Joint" ? "joint" : "all";
}

/** Tools this connection may use: every required permission granted. */
export function toolsFor(permissions: ReadonlySet<PermissionKey>): AssistantTool[] {
  return TOOLS.filter((t) => t.requires.every((p) => permissions.has(p)));
}

export function serverInstructions(owner: OwnerLabel, tools: readonly AssistantTool[]) {
  return [
    "RULES (always): " + THE_RULE.join(" "),
    "Do not save names, account details or identifiers from this server into memory.",
    "This is one household's private finance and travel assistant (two members, labelled User 1 and User 2; some accounts are Joint).",
    `You are talking with ${owner}. Never ask for or guess names, card numbers or account numbers; cards are known by nickname only.`,
    tools.some((t) => t.writes)
      ? "Nothing is booked or paid from here. The edit_* tools change household data the way the app's Ask Claude does: each call is logged in the member's history with Undo; deletes and more than 10 changes wait for the member to press Apply in the app. Only change what the person asked for. Read first to get refs (short handles like c12); never invent them. Kids are known by first name only."
      : "All tools are read-only. Nothing is booked, paid or changed from here; give advice and let the person act.",
    "Trip steps carry a `link` to their page in the household app. When the person needs a booking's confirmation code and it is not in the answer, give them that link: the code is shown there.",
    tools.length < TOOLS.length
      ? "This connection was only given access to some sections of the app; if a question needs data you have no tool for, say that the household has not shared it with you and that it can be enabled under Settings > AI assistants."
      : "",
    "For card questions call list_my_cards first. For where to put a purchase or booking call best_card_for_purchases (or trip_card_plan for a whole trip). A sign-up bonus close to its deadline usually beats a better multiplier.",
    "Card terms come from a stored catalog checked against issuers; mention the verified date when it matters and suggest confirming time-limited offers with the issuer.",
    "Someone in the family has coeliac disease. Treat gluten as a medical restriction, never a preference.",
    householdNicknames().length ? `People in the household go by: ${householdNicknames().join(", ")}. Use these first names; never surnames.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
