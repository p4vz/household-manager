import "server-only";
import { alreadySent, getPrefs, hasDevices, markSent, pruneSent, sendToMember, type Member } from "@/core/push/push";
import { householdTimeZone, zonedParts } from "@/core/time/zoned";
import { houseQuestions, largePurchases, largeThreshold } from "@/modules/finance/api";
import { listReturnSuggestions, listReturns } from "@/modules/family/api";
import { listDueTasks, listProjects } from "@/modules/maintenance/api";
import { addDays, dueCandidate, groupMessages, inSendingHours, LEAD_DAYS, type Candidate } from "./plan";

/**
 * Hourly: works out what each member should hear about and sends what they
 * have not been told yet. No bills (they pay themselves, Pavel 2026-11-25).
 *
 * Who hears what:
 * - upkeep, registrations and inspections, and return deadlines on the shared
 *   list: both members;
 * - transactions to review: each member for joint accounts and their own,
 *   never the other's private accounts (finance applies the viewer rule);
 * - returns found in email: only the member whose mailbox it came from.
 */
const MEMBERS: Member[] = ["user1", "user2"];
const REGISTRATION = /\b(registration|inspection|emissions|renew(al)?|licen[cs]e|permit|tags?)\b/i;

async function sharedCandidates(today: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const horizon = addDays(today, Math.max(LEAD_DAYS.upkeep, LEAD_DAYS.registrations));
  for (const t of await listDueTasks(horizon, 200, { today, todos: false })) {
    const type = REGISTRATION.test(t.title) ? "registrations" : "upkeep";
    const c = dueCandidate(type, { id: t.id, title: t.title, due: t.dueDate }, today, "/maintenance#items");
    if (c) out.push(c);
  }
  for (const r of await listReturns()) {
    if (!r.returnDeadline) continue;
    const c = dueCandidate("returns", { id: r.id, title: `${r.itemName} (${r.store})`, due: r.returnDeadline }, today, "/family");
    if (c) out.push(c);
  }
  return out;
}

async function personalCandidates(member: Member): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const linked = (await listProjects()).map((p) => p.transactionId).filter((x): x is string => Boolean(x));
  const questions = await houseQuestions(member, { linkedIds: linked, limit: 100 });
  for (const q of questions.rows) {
    out.push({ type: "suggestions", key: `review:${q.id}`, line: q.kind === "cash" ? "A cash withdrawal to explain" : "A transaction to check against the house history", url: "/maintenance#questions" });
  }
  const large = await largePurchases(member, await largeThreshold(member), 100);
  for (const p of large.open) {
    out.push({ type: "suggestions", key: `review:${p.id}`, line: "A large purchase to review", url: "/finance/review" });
  }
  for (const s of await listReturnSuggestions(member)) {
    out.push({ type: "suggestions", key: `found:${s.id}`, line: `Return found in your email${s.store ? `: ${s.store}` : ""}`, url: "/family" });
  }
  // A transaction can be in both lists; tell once.
  return [...new Map(out.map((c) => [c.key, c])).values()];
}

export async function runNotifications(now = new Date()) {
  const local = zonedParts(now, householdTimeZone());
  if (!inSendingHours(local.hour)) return { status: "skipped" as const, reason: "Quiet hours" };
  await pruneSent(now);
  const shared = await sharedCandidates(local.date);
  const result: Record<string, { messages: number; sent: number; failed: number }> = {};
  for (const member of MEMBERS) {
    if (!(await hasDevices(member))) continue;
    const prefs = await getPrefs(member);
    const all = [...shared, ...(prefs.suggestions ? await personalCandidates(member) : [])].filter((c) => prefs[c.type]);
    const seen = await alreadySent(member, all.map((c) => c.key));
    const groups = groupMessages(all.filter((c) => !seen.has(c.key)), prefs);
    const r = { messages: groups.length, sent: 0, failed: 0 };
    for (const g of groups) {
      const s = await sendToMember(member, g.message, now);
      r.sent += s.sent;
      r.failed += s.failed;
      // Marked even if a device failed, so a broken phone doesn't get the same reminder every hour.
      if (s.sent > 0 || s.failed > 0) await markSent(member, g.keys, now);
    }
    result[member] = r;
  }
  return { status: "ok" as const, result };
}
