import type { AccountKind, NetWorthItemKind, Owner } from "./schema";

/**
 * Net worth from account balances and hand-entered assets and liabilities,
 * now and at past month ends. History only, never a forecast (finance spec).
 * Pure, so it is tested without a database.
 */
export const LIABILITY_KINDS: readonly NetWorthItemKind[] = ["mortgage", "loan", "other_liability"];

export const NET_WORTH_KIND_LABELS: Record<NetWorthItemKind, string> = {
  home: "Home",
  vehicle: "Car",
  property: "Other property",
  investment: "Investment (not synced)",
  other_asset: "Other asset",
  mortgage: "Mortgage",
  loan: "Loan",
  other_liability: "Other debt",
};

export type NwAccount = {
  id: string;
  owner: Owner;
  kind: AccountKind;
  name: string;
  /** Signed as the bank reports it: cards and loans owed are negative. */
  balance: number;
  /** Household date of that balance. */
  balanceOn: string;
};
export type NwSnapshot = { accountId: string; date: string; balance: number };
export type NwTxn = { accountId: string; date: string; amount: number };
export type NwItem = { id: string; owner: Owner; kind: NetWorthItemKind; name: string; acquiredOn: string | null; closedOn: string | null };
export type NwValue = { itemId: string; asOf: string; value: number };

export type NetWorthGroup = "cash" | "investments" | "property" | "cards" | "loans" | "other";
export const GROUP_LABELS: Record<NetWorthGroup, string> = {
  cash: "Cash",
  investments: "Investments",
  property: "Home, cars and property",
  cards: "Credit cards",
  loans: "Loans and mortgage",
  other: "Other",
};

export function accountGroup(kind: AccountKind): NetWorthGroup {
  if (kind === "checking" || kind === "savings" || kind === "business_checking") return "cash";
  if (kind === "investment") return "investments";
  if (kind === "credit" || kind === "business_credit") return "cards";
  if (kind === "loan") return "loans";
  return "other";
}

export function itemGroup(kind: NetWorthItemKind): NetWorthGroup {
  if (kind === "home" || kind === "vehicle" || kind === "property") return "property";
  if (kind === "investment") return "investments";
  if (kind === "mortgage" || kind === "loan") return "loans";
  return "other";
}

/** Signed contribution of a hand-entered item: liabilities count against. */
export const itemSign = (kind: NetWorthItemKind) => (LIABILITY_KINDS.includes(kind) ? -1 : 1);

/**
 * An account's balance at the end of `date`: start from the first daily
 * snapshot on or after it (else today's balance) and undo the transactions
 * posted after `date`. Null before the account's first known data.
 */
export function balanceAt(a: NwAccount, date: string, snapshots: NwSnapshot[], txns: NwTxn[], firstSeen: string | null): number | null {
  if (date >= a.balanceOn) return a.balance;
  if (!firstSeen || date < firstSeen) return null;
  const ref = snapshots.filter((s) => s.date >= date && s.date <= a.balanceOn).sort((x, y) => x.date.localeCompare(y.date))[0];
  const refDate = ref?.date ?? a.balanceOn;
  const refBalance = ref?.balance ?? a.balance;
  const after = txns.filter((t) => t.date > date && t.date <= refDate).reduce((s, t) => s + t.amount, 0);
  return Math.round((refBalance - after) * 100) / 100;
}

/** A hand-entered item's value on a date: the latest value on or before it, else its first value. */
export function itemValueAt(item: NwItem, date: string, values: NwValue[]): number | null {
  if (item.acquiredOn && date < item.acquiredOn) return null;
  if (item.closedOn && date >= item.closedOn) return null;
  const mine = values.filter((v) => v.itemId === item.id).sort((a, b) => a.asOf.localeCompare(b.asOf));
  if (!mine.length) return null;
  const before = mine.filter((v) => v.asOf <= date);
  return (before.length ? before[before.length - 1] : mine[0]).value;
}

/** Month ends from `months` months back up to today, then today. */
export function historyDates(today: string, months: number): string[] {
  const [y, m] = today.split("-").map(Number);
  const out: string[] = [];
  for (let i = months; i >= 1; i--) {
    const end = new Date(Date.UTC(y, m - 1 - i + 1, 0));
    out.push(end.toISOString().slice(0, 10));
  }
  out.push(today);
  return out;
}

export type NetWorthLine = { key: string; name: string; group: NetWorthGroup; owner: Owner; value: number; source: "account" | "manual"; asOf: string | null };

export type NetWorth = {
  total: number;
  assets: number;
  liabilities: number;
  lines: NetWorthLine[];
  groups: { group: NetWorthGroup; total: number }[];
  history: { date: string; total: number }[];
};

export function computeNetWorth(input: {
  owners: Owner[];
  accounts: NwAccount[];
  snapshots: NwSnapshot[];
  txns: NwTxn[];
  items: NwItem[];
  values: NwValue[];
  today: string;
  months?: number;
}): NetWorth {
  const accounts = input.accounts.filter((a) => input.owners.includes(a.owner));
  const items = input.items.filter((i) => input.owners.includes(i.owner));

  const lines: NetWorthLine[] = [
    ...accounts.map((a) => ({ key: `a:${a.id}`, name: a.name, group: accountGroup(a.kind), owner: a.owner, value: a.balance, source: "account" as const, asOf: a.balanceOn })),
    ...items.flatMap((i) => {
      const v = itemValueAt(i, input.today, input.values);
      if (v == null) return [];
      const latest = input.values.filter((x) => x.itemId === i.id).sort((a, b) => b.asOf.localeCompare(a.asOf))[0];
      return [{ key: `i:${i.id}`, name: i.name, group: itemGroup(i.kind), owner: i.owner, value: itemSign(i.kind) * v, source: "manual" as const, asOf: latest?.asOf ?? null }];
    }),
  ];
  const assets = lines.filter((l) => l.value > 0).reduce((s, l) => s + l.value, 0);
  const liabilities = lines.filter((l) => l.value < 0).reduce((s, l) => s + l.value, 0);
  const groupTotals = new Map<NetWorthGroup, number>();
  for (const l of lines) groupTotals.set(l.group, (groupTotals.get(l.group) ?? 0) + l.value);

  const txnsBy = new Map<string, NwTxn[]>();
  for (const t of input.txns) {
    if (!txnsBy.has(t.accountId)) txnsBy.set(t.accountId, []);
    txnsBy.get(t.accountId)!.push(t);
  }
  const snapsBy = new Map<string, NwSnapshot[]>();
  for (const s of input.snapshots) {
    if (!snapsBy.has(s.accountId)) snapsBy.set(s.accountId, []);
    snapsBy.get(s.accountId)!.push(s);
  }
  const firstSeen = new Map<string, string | null>();
  for (const a of accounts) {
    const dates = [...(txnsBy.get(a.id) ?? []).map((t) => t.date), ...(snapsBy.get(a.id) ?? []).map((s) => s.date)];
    firstSeen.set(a.id, dates.length ? dates.reduce((m, d) => (d < m ? d : m)) : null);
  }

  const history = historyDates(input.today, input.months ?? 24).map((date) => {
    let total = 0;
    for (const a of accounts) total += balanceAt(a, date, snapsBy.get(a.id) ?? [], txnsBy.get(a.id) ?? [], firstSeen.get(a.id) ?? null) ?? 0;
    for (const i of items) total += itemSign(i.kind) * (itemValueAt(i, date, input.values) ?? 0);
    return { date, total: Math.round(total * 100) / 100 };
  });
  // Drop leading months with nothing known yet.
  while (history.length > 1 && history[0].total === 0) history.shift();

  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    total: r2(assets + liabilities),
    assets: r2(assets),
    liabilities: r2(liabilities),
    lines: lines.sort((a, b) => Math.abs(b.value) - Math.abs(a.value)),
    groups: [...groupTotals.entries()].map(([group, total]) => ({ group, total: r2(total) })).sort((a, b) => b.total - a.total),
    history,
  };
}
