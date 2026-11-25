"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const monthLabel = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", year: "2-digit" }).format(new Date(`${iso}T00:00:00Z`));

/** Net worth at each month end, and today. History only: no trend line or projection. */
export function NetWorthChart({ history }: { history: { date: string; total: number }[] }) {
  if (history.length < 2) return <p className="text-sm opacity-70">History appears once there is more than one month of balances.</p>;
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={history}>
          <CartesianGrid vertical={false} strokeOpacity={0.2} />
          <XAxis dataKey="date" tickFormatter={monthLabel} tickLine={false} axisLine={false} fontSize={12} minTickGap={24} />
          <YAxis tickFormatter={money} width={90} tickLine={false} axisLine={false} fontSize={12} />
          <Tooltip formatter={(v) => money(Number(v))} labelFormatter={(l) => monthLabel(String(l))} />
          <Area type="monotone" dataKey="total" name="Net worth" stroke="var(--chart-1)" fill="var(--chart-1)" fillOpacity={0.15} strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
