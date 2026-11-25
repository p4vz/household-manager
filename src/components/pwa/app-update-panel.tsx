"use client";

import { useState } from "react";
import { CURRENT_VERSION, applyUpdate, fetchLatestVersion, isNewer } from "./app-version";

type Result = { kind: "latest" } | { kind: "newer"; version: string } | { kind: "error" };

/** Settings: shows this app's version and a manual "Check for updates". */
export function AppUpdatePanel() {
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function check() {
    setChecking(true);
    const latest = await fetchLatestVersion();
    setResult(latest === null ? { kind: "error" } : isNewer(latest) ? { kind: "newer", version: latest } : { kind: "latest" });
    setChecking(false);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm opacity-80">
        Version <code>{CURRENT_VERSION}</code>
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={checking || updating}
          onClick={check}
          className="min-h-12 rounded-lg border px-4 disabled:opacity-50"
        >
          {checking ? "Checking…" : "Check for updates"}
        </button>
        {result?.kind === "newer" ? (
          <button
            type="button"
            disabled={updating}
            onClick={() => {
              setUpdating(true);
              void applyUpdate();
            }}
            className="min-h-12 rounded-lg bg-teal-600 px-4 font-medium text-white disabled:opacity-60"
          >
            {updating ? "Updating…" : "Update app"}
          </button>
        ) : null}
      </div>
      {result?.kind === "latest" ? <p className="text-sm text-teal-800">You have the latest version.</p> : null}
      {result?.kind === "newer" ? <p className="text-sm">Version {result.version} is ready.</p> : null}
      {result?.kind === "error" ? <p className="text-sm text-red-600">Couldn&apos;t reach the server. Check the connection and try again.</p> : null}
    </div>
  );
}
