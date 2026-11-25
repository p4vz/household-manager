"use client";

import { useState, useTransition } from "react";

type Provider = "claude_subscription" | "anthropic" | "gemini";
type Result = { ok: boolean; message: string };

export type KeyRowStatus = {
  provider: Provider;
  label: string;
  source: "app" | "env" | null;
  hint: string | null;
  savedAt: string | null;
  envAlsoSet: boolean;
  placeholder: string;
  help?: string;
  getKeyUrl?: string;
};

type Actions = {
  save: (input: { provider: Provider; key: string }) => Promise<Result>;
  test: (input: { provider: Provider; key: string }) => Promise<Result>;
  remove: (input: { provider: Provider }) => Promise<Result>;
};

/**
 * Paste, test, replace or remove a provider API key. The saved key never
 * comes back to the browser: only its masked hint does.
 */
export function AiApiKeys({ rows, actions }: { rows: KeyRowStatus[]; actions: Actions }) {
  return (
    <div className="space-y-4">
      {rows.map((r) => (
        <KeyRow key={r.provider} row={r} actions={actions} />
      ))}
    </div>
  );
}

function KeyRow({ row, actions }: { row: KeyRowStatus; actions: Actions }) {
  const [key, setKey] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<Result>, clear = false) =>
    start(async () => {
      try {
        const r = await fn();
        setResult(r);
        if (clear && r.ok) setKey("");
      } catch {
        setResult({ ok: false, message: "Something went wrong. Try again." });
      }
    });

  const inputId = `api-key-${row.provider}`;
  return (
    <div className="space-y-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <label htmlFor={inputId} className="font-medium">{row.label}</label>
        <span className="text-sm opacity-70">
          {row.source === "app" ? (
            <>
              Saved <code>{row.hint}</code>
              {row.savedAt ? ` on ${row.savedAt.slice(0, 10)}` : ""}
            </>
          ) : row.source === "env" ? (
            <>
              From server environment <code>{row.hint}</code>
            </>
          ) : (
            <span className="text-amber-600">Not set</span>
          )}
        </span>
      </div>
      {row.help ? <p className="text-xs opacity-70">{row.help}</p> : null}
      <input
        id={inputId}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={row.source ? "Paste a new key to replace it" : row.placeholder}
        className="w-full rounded border bg-transparent px-2 py-1 font-mono text-sm"
      />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button
          type="button"
          disabled={pending || !key.trim()}
          onClick={() => run(() => actions.save({ provider: row.provider, key }), true)}
          className="rounded-lg bg-foreground px-3 py-1.5 text-background disabled:opacity-50"
        >
          {row.source === "app" ? "Replace" : "Save"}
        </button>
        <button
          type="button"
          disabled={pending || (!key.trim() && !row.source)}
          onClick={() => run(() => actions.test({ provider: row.provider, key }))}
          className="rounded-lg border px-3 py-1.5 disabled:opacity-50"
        >
          {key.trim() ? "Test this one" : "Test saved"}
        </button>
        {row.source === "app" ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => actions.remove({ provider: row.provider }))}
            className="underline disabled:opacity-50"
          >
            Remove
          </button>
        ) : null}
        {row.getKeyUrl ? (
          <a href={row.getKeyUrl} target="_blank" rel="noreferrer noopener" className="underline opacity-70">
            Get a key
          </a>
        ) : null}
      </div>
      {pending ? <p className="text-sm opacity-70">Working…</p> : null}
      {!pending && result ? (
        <p role="status" className={`text-sm ${result.ok ? "text-green-700 dark:text-green-400" : "text-red-600"}`}>
          {result.message}
        </p>
      ) : null}
      {row.source === "app" && row.envAlsoSet ? (
        <p className="text-xs opacity-60">The key saved here is used. Removing it falls back to the server environment key.</p>
      ) : null}
    </div>
  );
}
