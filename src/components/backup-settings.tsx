"use client";

import { useState, useTransition } from "react";

export type BackupView = {
  keySet: boolean;
  driveConnected: boolean;
  connectedBy: string | null;
  connectedAt: string | null;
  lastRunAt: string | null;
  lastOk: boolean | null;
  lastMessage: string | null;
  lastOkAt: string | null;
  kept: number | null;
  timeZone: string;
};

type Actions = {
  connect: (input: Record<string, never>) => Promise<{ url: string | null; error: string | null }>;
  backupNow: (input: Record<string, never>) => Promise<{ ok: boolean; message: string }>;
  disconnect: (input: Record<string, never>) => Promise<void>;
};

/** Settings → Backups: off-site copies in Google Drive. */
export function BackupSettings({ view, justConnected, actions }: { view: BackupView; justConnected: boolean; actions: Actions }) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(justConnected ? "Google Drive connected. Tap Back up now to make the first copy." : null);

  return (
    <div className="space-y-3 text-sm">
      <p className="opacity-80">
        Every night at 3 AM ({view.timeZone}) the whole database is encrypted with the server&apos;s BACKUP_KEY and saved to a
        &quot;Household manager backups&quot; folder in Google Drive. Copies older than 30 days are deleted (the newest 7 always
        stay). The app can see only the files it made in that Drive, nothing else. Google can&apos;t read the copies. Railway&apos;s
        own database backups are the first line; this is the copy that survives losing the Railway account.
      </p>
      {!view.keySet ? (
        <p className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3">
          BACKUP_KEY is not set on the server, so no backup can be made. Set it in Railway (32 random bytes, base64) and save
          a copy in your password manager: without it a backup can&apos;t be opened.
        </p>
      ) : null}
      {view.driveConnected ? (
        <div className="space-y-1">
          <div>
            Google Drive connected{view.connectedBy ? ` by ${view.connectedBy}` : ""}
            {view.connectedAt ? ` on ${view.connectedAt.slice(0, 10)}` : ""}.
          </div>
          <div className={view.lastOk === false ? "text-red-700" : "opacity-70"}>
            {view.lastRunAt ? `Last run ${new Date(view.lastRunAt).toLocaleString()}: ${view.lastMessage ?? ""}` : "No backup yet."}
          </div>
          {view.lastOk === false && view.lastOkAt ? <div className="opacity-70">Last good copy {new Date(view.lastOkAt).toLocaleString()}.</div> : null}
          {view.kept !== null ? <div className="opacity-70">{view.kept} copies in Drive.</div> : null}
        </div>
      ) : (
        <p className="opacity-60">Google Drive is not connected, so no nightly copies are made.</p>
      )}
      <div className="flex flex-wrap gap-2">
        {view.driveConnected ? (
          <>
            <button
              type="button"
              disabled={pending || !view.keySet}
              className="rounded-lg bg-foreground px-4 py-2 text-background disabled:opacity-50"
              onClick={() =>
                start(async () => {
                  setNote("Backing up…");
                  const r = await actions.backupNow({});
                  setNote(r.message);
                })
              }
            >
              Back up now
            </button>
            <button type="button" disabled={pending} className="underline disabled:opacity-50" onClick={() => start(() => actions.disconnect({}))}>
              Disconnect Drive
            </button>
          </>
        ) : (
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
            Connect Google Drive
          </button>
        )}
      </div>
      {note ? <p role="status" className="opacity-80">{note}</p> : null}
    </div>
  );
}
