"use client";

import { useActionState } from "react";

type State = null | { ok: true; message: string } | { ok: false; error: string };

export type BankSyncView = {
  connected: boolean;
  via: "env" | "setup" | null;
  linkedAt: string | null;
  lastRun: { status: string; at: string; messages: string[] } | null;
  lastOk: { at: string; inserted: number } | null;
  accounts: number;
  transactions: number;
  timeZone: string;
};

function when(iso: string, timeZone: string) {
  return new Date(iso).toLocaleString("en-US", { timeZone, dateStyle: "medium", timeStyle: "short" });
}

function Result({ state }: { state: State }) {
  if (!state) return null;
  return state.ok ? <p className="text-sm">{state.message}</p> : <p className="text-sm text-red-600">{state.error}</p>;
}

export function BankSyncSettings({
  view,
  connect,
  syncNow,
  disconnect,
}: {
  view: BankSyncView;
  connect: (prev: State, form: FormData) => Promise<State>;
  syncNow: (prev: State) => Promise<State>;
  disconnect: () => Promise<void>;
}) {
  const [connectState, connectAction, connecting] = useActionState(connect, null);
  const [syncState, syncAction, syncing] = useActionState(syncNow, null);
  const tz = view.timeZone;

  if (!view.connected) {
    return (
      <div className="space-y-3">
        <p className="text-sm opacity-80">Not connected.</p>
        <ol className="list-decimal space-y-1 pl-5 text-sm opacity-80">
          <li>In SimpleFIN Bridge, link your banks, then create a new setup token for this app.</li>
          <li>
            Paste it below. It works once: the app swaps it for a permanent key that is kept encrypted on the server and
            never shown again.
          </li>
          <li>The first sync pulls about 90 days. After that the app syncs at 7 AM and 7 PM.</li>
        </ol>
        <form action={connectAction} className="space-y-3">
          <textarea
            name="token"
            required
            rows={3}
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste the SimpleFIN setup token"
            className="w-full rounded border bg-transparent p-2 font-mono text-xs"
          />
          <button disabled={connecting} className="rounded-lg bg-foreground px-4 py-2 text-background disabled:opacity-50">
            {connecting ? "Connecting…" : "Connect"}
          </button>
        </form>
        <Result state={connectState} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="opacity-60">Status</dt>
        <dd className="text-green-700 dark:text-green-400">
          Connected{view.via === "env" ? " (set on the server)" : view.linkedAt ? ` since ${when(view.linkedAt, tz)}` : ""}
        </dd>
        <dt className="opacity-60">Last sync</dt>
        <dd>
          {view.lastRun ? (
            <>
              {when(view.lastRun.at, tz)}{" "}
              <span className={view.lastRun.status === "error" ? "text-red-600" : "opacity-60"}>({view.lastRun.status})</span>
            </>
          ) : (
            "Never"
          )}
        </dd>
        {view.lastRun?.status !== "ok" && view.lastOk ? (
          <>
            <dt className="opacity-60">Last good sync</dt>
            <dd>{when(view.lastOk.at, tz)}</dd>
          </>
        ) : null}
        <dt className="opacity-60">Accounts</dt>
        <dd>
          {view.accounts} from SimpleFIN, {view.transactions} transactions in total
        </dd>
        <dt className="opacity-60">Schedule</dt>
        <dd>7 AM and 7 PM</dd>
      </dl>
      {view.lastRun?.messages.length ? (
        <ul className="rounded-md bg-warning/10 p-3 text-sm text-warning">
          {view.lastRun.messages.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      ) : null}
      <form action={syncAction}>
        <button disabled={syncing} className="rounded-lg bg-foreground px-4 py-2 text-background disabled:opacity-50">
          {syncing ? "Syncing…" : "Sync now"}
        </button>
      </form>
      <Result state={syncState} />
      {view.via === "env" ? (
        <p className="text-sm opacity-70">
          This connection comes from SIMPLEFIN_ACCESS_URL on the server. Remove that variable there to disconnect.
        </p>
      ) : (
        <details className="text-sm">
          <summary className="cursor-pointer underline">Disconnect</summary>
          <div className="mt-2 space-y-2 rounded-lg border p-3">
            <p className="opacity-80">
              The app forgets its SimpleFIN key and stops syncing. Accounts and transactions already here stay. To cut off
              access completely, also revoke this app in SimpleFIN Bridge.
            </p>
            <form action={disconnect}>
              <button type="submit" className="rounded-lg border border-red-600 px-3 py-1.5 text-red-600">
                Disconnect SimpleFIN
              </button>
            </form>
          </div>
        </details>
      )}
    </div>
  );
}
