"use client";

import { useMemo, useState, useTransition } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatMoney } from "@/lib/utils";
import {
  RANGES,
  applyFilters,
  cashFlow,
  categoryBreakdown,
  rangeMonths,
  topMerchants,
  type CategoryFact,
  type MerchantFact,
  type OwnerFilter,
  type RangeKey,
} from "../analytics/compute";

const COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
];
const OWNERS: { key: OwnerFilter; label: string }[] = [
  { key: "all", label: "All Household" },
  { key: "user1", label: "Me" },
  { key: "user2", label: "Wife" },
  { key: "joint", label: "Joint" },
];

type Txn = {
  id: string;
  date: string;
  merchant: string;
  category: string | null;
  subcategory: string | null;
  amount: number;
  account: string;
};
type DrillQuery = {
  range: RangeKey;
  owner: OwnerFilter;
  accountIds: string[] | null;
  category?: string;
  subcategory?: string | null;
  merchant?: string;
};

export function FinanceDashboard(props: {
  today: string;
  categoryFacts: CategoryFact[];
  merchantFacts: MerchantFact[];
  accounts: { id: string; name: string; owner: string }[];
  drillDown: (q: DrillQuery) => Promise<Txn[]>;
}) {
  const [owner, setOwner] = useState<OwnerFilter>("all");
  const [range, setRange] = useState<RangeKey>("3M");
  const [accountIds, setAccountIds] = useState<string[] | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [drill, setDrill] = useState<{ title: string; rows: Txn[] } | null>(null);
  const [pending, start] = useTransition();

  const today = useMemo(() => new Date(`${props.today}T12:00:00Z`), [props.today]);
  const months = useMemo(() => rangeMonths(range, today), [range, today]);
  const filter = { owner, accountIds, months };

  const cats = useMemo(
    () => categoryBreakdown(applyFilters(props.categoryFacts, filter)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.categoryFacts, owner, accountIds, months],
  );
  const flow = useMemo(
    () => cashFlow(applyFilters(props.categoryFacts, filter), months),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.categoryFacts, owner, accountIds, months],
  );
  const merchants = useMemo(
    () => topMerchants(applyFilters(props.merchantFacts, filter), 10),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.merchantFacts, owner, accountIds, months],
  );
  const selected = cats.find((c) => c.category === category) ?? null;
  const totalSpend = cats.reduce((s, c) => s + c.spend, 0);

  function openDrill(title: string, q: Omit<DrillQuery, "range" | "owner" | "accountIds">) {
    start(async () => {
      const rows = await props.drillDown({ range, owner, accountIds, ...q });
      setDrill({ title, rows });
    });
  }

  const visibleAccounts = props.accounts.filter((a) => owner === "all" || a.owner === owner);

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Segmented options={OWNERS} value={owner} onChange={(v) => { setOwner(v); setAccountIds(null); setDrill(null); }} />
        <Segmented options={RANGES.map((r) => ({ key: r, label: r }))} value={range} onChange={(v) => { setRange(v); setDrill(null); }} />
        <select
          className="h-9 rounded-md border bg-background px-2 text-sm"
          value={accountIds?.[0] ?? ""}
          onChange={(e) => {
            setAccountIds(e.target.value ? [e.target.value] : null);
            setDrill(null);
          }}
        >
          <option value="">All cards and accounts</option>
          {visibleAccounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </div>

      {/* Cash flow */}
      <Card>
        <CardHeader>
          <CardTitle>Income vs. spending</CardTitle>
          <CardDescription>
            In {formatMoney(flow.totals.income)} · Out {formatMoney(flow.totals.spend)} · Net {formatMoney(flow.totals.net)}
            {flow.savingsRate != null ? ` · Savings rate ${(flow.savingsRate * 100).toFixed(1)}%` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={flow.series}>
              <CartesianGrid vertical={false} strokeOpacity={0.2} />
              <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis tickFormatter={(v) => formatMoney(v)} width={80} tickLine={false} axisLine={false} fontSize={12} />
              <Tooltip formatter={(v) => formatMoney(Number(v))} />
              <Legend />
              <Bar dataKey="income" name="Income" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="spend" name="Spending" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Category donut */}
        <Card>
          <CardHeader>
            <CardTitle>Spending by category</CardTitle>
            <CardDescription>{formatMoney(totalSpend)} · click a slice or bar to drill in</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={cats}
                  dataKey="spend"
                  nameKey="category"
                  innerRadius="55%"
                  outerRadius="85%"
                  onClick={(d) => setCategory((d as unknown as { category: string }).category)}
                  className="cursor-pointer"
                >
                  {cats.map((c, i) => (
                    <Cell key={c.category} fill={COLORS[i % COLORS.length]} opacity={category && category !== c.category ? 0.35 : 1} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => formatMoney(Number(v))} />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Horizontal bars: categories, or subcategories of the selected one */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {selected ? (
                <>
                  <button className="text-muted-foreground hover:underline" onClick={() => setCategory(null)}>All</button>
                  <span>/ {selected.category}</span>
                </>
              ) : (
                "Categories"
              )}
            </CardTitle>
            {selected ? (
              <CardDescription>
                <button className="underline" onClick={() => openDrill(selected.category, { category: selected.category })}>
                  Show {selected.count} transactions
                </button>
              </CardDescription>
            ) : null}
          </CardHeader>
          <CardContent>
            <HBars
              rows={(selected ? selected.subcategories.map((s) => ({ name: s.name, value: s.spend })) : cats.map((c) => ({ name: c.category, value: c.spend })))}
              onClick={(name) =>
                selected
                  ? openDrill(`${selected.category} / ${name}`, { category: selected.category, subcategory: name })
                  : setCategory(name)
              }
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Top merchants</CardTitle>
        </CardHeader>
        <CardContent>
          <HBars rows={merchants.map((m) => ({ name: m.merchant, value: m.spend }))} onClick={(name) => openDrill(name, { merchant: name })} />
        </CardContent>
      </Card>

      {pending ? <p className="text-sm text-muted-foreground">Loading transactions…</p> : null}
      {drill ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>{drill.title}</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setDrill(null)}>Close</Button>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <tbody>
                {drill.rows.map((t) => (
                  <tr key={t.id} className="border-t">
                    <td className="py-1.5 pr-3 text-muted-foreground">{t.date}</td>
                    <td className="pr-3">{t.merchant}</td>
                    <td className="pr-3 text-muted-foreground">{[t.category, t.subcategory].filter(Boolean).join(" / ")}</td>
                    <td className="pr-3 text-muted-foreground">{t.account}</td>
                    <td className="text-right tabular-nums">{formatMoney(t.amount, { cents: true })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Segmented<T extends string>(props: { options: { key: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-md border p-0.5">
      {props.options.map((o) => (
        <button
          key={o.key}
          onClick={() => props.onChange(o.key)}
          className={cn(
            "rounded px-3 py-1 text-sm",
            props.value === o.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function HBars({ rows, onClick }: { rows: { name: string; value: number }[]; onClick: (name: string) => void }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No spending in this view.</p>;
  return (
    <ul className="space-y-2">
      {rows.map((r, i) => (
        <li key={r.name}>
          <button onClick={() => onClick(r.name)} className="w-full text-left">
            <div className="flex justify-between text-sm">
              <span>{r.name}</span>
              <span className="tabular-nums">{formatMoney(r.value)}</span>
            </div>
            <div className="mt-1 h-2 rounded-full bg-muted">
              <div className="h-2 rounded-full" style={{ width: `${(r.value / max) * 100}%`, background: COLORS[i % COLORS.length] }} />
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
