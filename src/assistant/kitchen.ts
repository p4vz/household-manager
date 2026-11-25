import "server-only";
import { z } from "zod";
import { runStructured } from "@/core/ai/run";
import { legalNamesFromEnv, sanitizeReferencePayload, scrubReferenceText } from "@/core/ai/sanitize";
import { householdTimeZone } from "@/core/time/zoned";
import * as calendar from "@/modules/calendar/api";
import * as family from "@/modules/family/api";
import * as maintenance from "@/modules/maintenance/api";

/**
 * Ask Claude on the kitchen screen (adult mode only, Pavel 2026-11-25). It
 * knows only what the kitchen screen shows: the family calendar, chores and
 * goals, shopping lists, returns and upkeep due soon. It gets that as one
 * sanitized snapshot and has no tools at all, so it cannot reach money,
 * trips, accounts, email, documents or anything else, and it changes nothing.
 *
 * Left out even of the snapshot: event notes and pictures, return order
 * numbers and notes, upkeep notes and parts. Nothing is stored; the
 * conversation lives only on the screen until it is closed or locked.
 */
export const KITCHEN_MAX_QUESTION = 500;
export const KITCHEN_MAX_TURNS = 10;
export type KitchenTurn = { role: "user" | "assistant"; text: string };

const SYSTEM = [
  "You are the family's helper on the kitchen wall screen of their private household app. An adult unlocked you with the adult PIN; kids may be listening.",
  "You only know what is on the kitchen screen: the family calendar for the next two weeks, the kids' chores, streaks and goals, the shopping lists, store returns to make, and house upkeep due soon. All of it is in DATA.",
  "Answer only about those things: what's coming up, who has what, what to buy, what to return, what upkeep is due, how the kids' chores and goals are going, and simple planning from that.",
  "If asked about anything else (money, bank or card accounts, spending, bills, trips and bookings, passwords, email, documents, the rest of the app, or general topics), say kindly that on the kitchen screen you can only help with the calendar, chores, shopping, returns and upkeep, and that the phone app has the rest.",
  "Never reveal or guess account, card or ID numbers, addresses beyond what an event shows, or full names. You cannot change anything: if asked to add or change something, say which button on the screen does it.",
  "Be short and friendly: one to four sentences or a short list. Use the household's local times as given. Today is in DATA.today.",
  "Someone in the family has coeliac disease. Treat gluten as a medical restriction.",
].join("\n");

const Answer = z.object({ answer: z.string().max(2000) });

/** Exactly what the kitchen screen shows, minus notes, pictures and order numbers. */
export async function kitchenSnapshot(now = new Date()) {
  const tz = householdTimeZone();
  const today = family.today(now);
  const twoWeeks = new Date(`${today}T00:00:00Z`);
  twoWeeks.setUTCDate(twoWeeks.getUTCDate() + 14);
  const [cal, kids, progress, shopping, returns, upkeep] = await Promise.all([
    calendar.kioskCalendar(14, now),
    family.choreBoard(now),
    family.kidProgress(now),
    family.shoppingBoard(now),
    family.listReturns(),
    maintenance.listDueTasks(twoWeeks.toISOString().slice(0, 10)),
  ]);
  return {
    today,
    timeZone: tz,
    calendar: cal.days.map((d) => ({
      date: d.date,
      day: d.heading,
      events: d.items.map((i) => ({ title: i.title, time: i.timeLabel, place: i.location, calendar: i.who })),
    })),
    kids: kids.map((k) => {
      const p = progress.find((x) => x.kidId === k.id);
      return {
        kid: k.name,
        today: `${k.stats.todayDone} of ${k.stats.todayTotal} chores done`,
        streakDays: k.stats.streak,
        starsThisWeek: k.stats.starsWeek,
        starsTotal: k.stats.starsTotal,
        weekPercent: k.stats.weekPercent,
        chores: k.chores.map((c) => ({ chore: c.title, how: c.recurrence, done: c.done })),
        goals: (p?.goals ?? []).map((g) => ({
          goal: g.kind === "streak" ? `${g.choreTitle} ${g.target} ${g.unit} in a row` : `${g.choreTitle} ${g.target} times`,
          progress: `${g.progress}/${g.target}`,
          reached: g.reached,
          reward: g.reward,
        })),
        badges: (p?.badges ?? []).map((b) => b.label),
      };
    }),
    shopping: shopping.lists.map((l) => ({
      list: l.name,
      stores: l.sections.map((s) => ({ store: s.store, toBuy: s.items.filter((i) => !i.checked).map((i) => (i.quantity ? `${i.name} (${i.quantity})` : i.name)) })),
    })),
    returns: returns.map((r) => ({ item: r.itemName, store: r.store, returnBy: r.returnDeadline, status: r.status })),
    upkeepDue: upkeep.map((t) => ({ task: t.title, due: t.dueDate })),
  };
}

export async function askKitchen(history: KitchenTurn[], question: string, now = new Date()): Promise<string> {
  const legal = legalNamesFromEnv();
  const q = scrubReferenceText(question.trim().slice(0, KITCHEN_MAX_QUESTION), legal);
  if (!q) throw new Error("Ask a question first.");
  const earlier = history
    .slice(-KITCHEN_MAX_TURNS)
    .map((t) => `${t.role === "user" ? "ADULT" : "YOU"}: ${scrubReferenceText(t.text.slice(0, 1200), legal)}`)
    .join("\n");
  const payload = sanitizeReferencePayload(await kitchenSnapshot(now), legal);
  const { answer } = await runStructured({
    tier: "fast",
    system: SYSTEM,
    task: `${earlier ? `Conversation so far:\n${earlier}\n\n` : ""}Question from the adult at the kitchen screen:\n${q}\n\nAnswer it from DATA, following the rules.`,
    payload,
    schema: Answer,
  });
  return answer.trim() || "I'm not sure. Try asking about the calendar, chores, shopping, returns or upkeep.";
}
