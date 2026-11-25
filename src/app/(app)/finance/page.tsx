import Link from "next/link";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { dashboardData, syncStatus, viewerFromLabel } from "@/modules/finance/api";
import { FinanceDashboard } from "@/modules/finance/ui/dashboard";
import { drillDownAction } from "./actions";

export default async function FinancePage() {
  const user = await requireUserOrRedirect();
  const viewer = viewerFromLabel(user.owner);
  const [{ connection, runs }, data] = await Promise.all([syncStatus(), dashboardData(viewer)]);
  const last = runs[0];
  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <h1 className="text-2xl font-semibold">Finance</h1>
        <span className="text-sm text-muted-foreground">
          {connection.connected ? "Bank sync on" : "Bank sync not connected"}
          {last ? ` · last ${last.status} ${last.startedAt.toLocaleString()}` : ""}
        </span>
        {!connection.connected ? (
          <Link href="/settings#bank-sync" className="text-sm underline">Connect SimpleFIN</Link>
        ) : null}
      </div>
      {last?.messages?.length ? (
        <ul className="rounded-md bg-warning/10 p-3 text-sm text-warning">
          {last.messages.map((m, i) => <li key={i}>{m}</li>)}
        </ul>
      ) : null}
      <FinanceDashboard {...data} viewer={viewer} drillDown={drillDownAction} />
    </section>
  );
}
