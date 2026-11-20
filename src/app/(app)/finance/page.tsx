import Link from "next/link";
import { syncStatus } from "@/modules/finance/api";

export default async function FinancePage() {
  const { connection, runs, totals } = await syncStatus();
  const last = runs[0];
  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold">Finance</h1>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border p-4">
          <h2 className="text-sm opacity-70">Bank sync</h2>
          <p className="mt-1 font-medium">{connection.connected ? "Connected" : "Not connected"}</p>
          {last ? (
            <p className="text-sm opacity-70">
              Last run {last.startedAt.toLocaleString()}: {last.status}
              {last.status === "ok" ? `, ${last.inserted} new` : ""}
            </p>
          ) : null}
          {last?.messages?.length ? (
            <ul className="mt-2 list-disc pl-4 text-sm text-amber-600">
              {last.messages.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          ) : null}
          {connection.via !== "env" ? (
            <Link href="/finance/connect" className="mt-2 inline-block text-sm underline">
              {connection.connected ? "Reconnect" : "Connect SimpleFIN"}
            </Link>
          ) : null}
        </div>
        <div className="rounded-xl border p-4">
          <h2 className="text-sm opacity-70">Transactions</h2>
          <p className="mt-1 font-medium">{totals?.n ?? 0}</p>
          {totals?.first ? (
            <p className="text-sm opacity-70">
              {totals.first} to {totals.last}
            </p>
          ) : null}
          <Link href="/finance/transactions" className="mt-2 inline-block text-sm underline">View</Link>
        </div>
        <div className="rounded-xl border p-4">
          <h2 className="text-sm opacity-70">Setup</h2>
          <ul className="mt-1 space-y-1 text-sm">
            <li><Link href="/finance/accounts" className="underline">Accounts and owners</Link></li>
            <li><Link href="/finance/import" className="underline">Import Simplifi history</Link></li>
          </ul>
        </div>
      </div>
    </section>
  );
}
