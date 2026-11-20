import type { CardTerms } from "@/modules/finance/api";

type Terms = CardTerms;

const FIELD_LABELS: Record<string, string> = {
  terms: "Terms added",
  annualFee: "Annual fee",
  baseRate: "Base rate",
  pointValueCents: "Point value",
  rewardType: "Reward type",
  rewardCurrency: "Reward currency",
  foreignTransactionFee: "Foreign transaction fee",
  multipliers: "Bonus categories",
  rotating: "Rotating categories",
  signupOffer: "Sign-up offer",
  credits: "Credits",
  perks: "Perks",
};

export function rate(t: Pick<Terms, "rewardType">, r: number) {
  return t.rewardType === "cashback" ? `${r}%` : `${r}x`;
}

export function multipliersText(t: Terms) {
  return t.multipliers
    .map((m) => `${rate(t, m.rate)} ${m.on.replace("merchant:", "")}${m.capAmount ? ` (to $${m.capAmount.toLocaleString()}/${m.capPeriod})` : ""}`)
    .join(", ");
}

export function offerText(t: Pick<Terms, "rewardType" | "signupOffer">) {
  const o = t.signupOffer;
  if (!o) return "None on file";
  const bonus = t.rewardType === "cashback" ? `$${o.bonus.toLocaleString()}` : `${o.bonus.toLocaleString()} pts`;
  return `${bonus} after $${o.minSpend.toLocaleString()} in ${o.windowMonths} mo${o.extras ? `, ${o.extras}` : ""}${o.endDate ? ` (ends ${o.endDate})` : ""}`;
}

function value(field: string, v: unknown): string {
  if (v == null) return "none";
  if (field === "annualFee") return `$${v}`;
  if (field === "signupOffer") return offerText({ rewardType: "points", signupOffer: v as Terms["signupOffer"] });
  if (field === "multipliers") return (v as Terms["multipliers"]).map((m) => `${m.rate} on ${m.on}`).join(", ") || "none";
  if (field === "rotating") return (v as NonNullable<Terms["rotating"]>).quarters.map((q) => `${q.quarter}: ${q.description}`).join("; ") || "no quarters yet";
  if (field === "credits") return (v as Terms["credits"]).map((c) => `${c.label} $${c.amount}/${c.period}`).join(", ") || "none";
  if (field === "perks") return `${(v as string[]).length} perks`;
  if (typeof v === "object") return "updated";
  return String(v);
}

/** One line per changed field, e.g. "Annual fee: $95 → $150". */
export function changeLines(changes: { field: string; before: unknown; after: unknown }[]) {
  return changes.map((c) =>
    c.field === "terms" ? "Terms looked up for the first time" : `${FIELD_LABELS[c.field] ?? c.field}: ${value(c.field, c.before)} → ${value(c.field, c.after)}`,
  );
}

export function daysAgo(d: Date | null, now = new Date()) {
  if (!d) return null;
  const n = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  return n <= 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`;
}
