"use client";

import { useState, useTransition } from "react";

export type MailboxRow = {
  id: string;
  address: string;
  includeSpam: boolean;
  lastScanAt: string | null;
  lastScanOk: boolean | null;
  lastScanMessage: string | null;
};

type Actions = {
  connect: (input: Record<string, never>) => Promise<{ url: string | null; error: string | null }>;
  scanNow: (input: Record<string, never>) => Promise<{ message: string }>;
  setSpam: (input: { id: string; includeSpam: boolean }) => Promise<void>;
  disconnect: (input: { id: string }) => Promise<void>;
};

/** Settings → Email for returns. Each member sees and manages only their own mailboxes. */
export function MailSettings({ mailboxes, justConnected, actions }: { mailboxes: MailboxRow[]; justConnected: boolean; actions: Actions }) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(justConnected ? "Mailbox connected. The first scan is running; found returns appear on the Returns tab." : null);

  return (
    <div className="space-y-3">
      <p className="text-sm opacity-80">
        Connect the Gmail addresses you shop with, including spare ones. The app searches them for return emails (labels,
        drop-off deadlines, refunds) every 3 hours and suggests returns on the Family hub&apos;s Returns tab for you to add.
        Access is read-only. Only what it finds is kept, never the emails. Your mailboxes and what they find are private to
        you until you add a return to the shared list.
      </p>
      {mailboxes.length === 0 ? (
        <p className="text-sm opacity-60">No mailboxes connected.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {mailboxes.map((m) => (
            <li key={m.id} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{m.address}</div>
                  <div className={m.lastScanOk === false ? "text-red-700" : "opacity-60"}>
                    {m.lastScanAt ? `Last scanned ${new Date(m.lastScanAt).toLocaleString()}` : "Not scanned yet"}
                    {m.lastScanMessage ? `. ${m.lastScanMessage}` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={pending}
                  className="underline disabled:opacity-50"
                  onClick={() => start(() => actions.disconnect({ id: m.id }))}
                >
                  Disconnect
                </button>
              </div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  defaultChecked={m.includeSpam}
                  disabled={pending}
                  onChange={(e) => {
                    const includeSpam = e.currentTarget.checked;
                    start(() => actions.setSpam({ id: m.id, includeSpam }));
                  }}
                />
                Also search the Spam folder
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          className="rounded-lg bg-foreground px-4 py-2 text-background disabled:opacity-50"
          onClick={() =>
            start(async () => {
              const res = await actions.connect({});
              if (res.url) window.location.assign(res.url);
              else setNote(res.error);
            })
          }
        >
          Connect Gmail
        </button>
        {mailboxes.length > 0 ? (
          <button
            type="button"
            disabled={pending}
            className="rounded-lg border px-4 py-2 disabled:opacity-50"
            onClick={() =>
              start(async () => {
                setNote("Scanning…");
                setNote((await actions.scanNow({})).message);
              })
            }
          >
            Scan now
          </button>
        ) : null}
      </div>
      {note ? <p className="text-sm">{note}</p> : null}
      <p className="text-xs opacity-60">
        Google warns that the app is unverified, because reading Gmail is a restricted permission. Choose Advanced, then
        continue. You can remove access any time here or at myaccount.google.com/permissions.
      </p>
    </div>
  );
}
