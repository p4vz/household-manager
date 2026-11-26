"use client";

import Link from "next/link";
import { useEffect, useRef, useTransition } from "react";
import type { OnboardingStep } from "@/assistant/onboarding";
import { runningAsApp } from "@/components/pwa/install-prompt";

type Actions = { tick: (input: { id: string; done: boolean }) => Promise<void> };

/**
 * A setup checklist. Steps the app checks itself show "Checked by the app";
 * the rest have a tick box. Opening the installed phone app ticks "Install
 * the app" on its own.
 */
export function OnboardingList({ steps, actions, compact = false }: { steps: OnboardingStep[]; actions: Actions; compact?: boolean }) {
  const [pending, start] = useTransition();
  const sent = useRef(false);
  const install = steps.find((s) => s.id === "install");
  useEffect(() => {
    if (install && !install.done && !sent.current && runningAsApp()) {
      sent.current = true;
      start(() => actions.tick({ id: "install", done: true }));
    }
  }, [install, actions]);

  return (
    <ol className="space-y-3">
      {steps.map((s) => {
        const external = s.href.startsWith("http");
        const linkText = s.action ?? "Open";
        return (
          <li key={s.id} className="flex gap-3">
            {s.doneBy === "checked" ? (
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-teal-600 text-xs text-white" aria-label="Done, checked by the app">
                ✓
              </span>
            ) : (
              <input
                type="checkbox"
                className="mt-0.5 h-5 w-5 shrink-0 accent-teal-600"
                checked={s.done}
                disabled={pending}
                aria-label={s.done ? `Untick ${s.title}` : `Tick ${s.title} as done`}
                onChange={(e) => start(() => actions.tick({ id: s.id, done: e.target.checked }))}
              />
            )}
            <div className="min-w-0 flex-1">
              <div className={`text-sm font-medium ${s.done ? "text-muted-foreground line-through" : ""}`}>{s.title}</div>
              {!compact || !s.done ? <p className="text-sm text-muted-foreground">{s.detail}</p> : null}
              <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                {!s.done && linkText ? (
                  external ? (
                    <a href={s.href} target="_blank" rel="noreferrer" className="text-primary underline">
                      {linkText}
                    </a>
                  ) : (
                    <Link href={s.href} className="text-primary underline">
                      {linkText}
                    </Link>
                  )
                ) : null}
                {s.doneBy === "checked" ? <span>Checked by the app</span> : s.auto && !s.done ? <span>Ticks itself when done</span> : null}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** "Hide from home" / "Show on home" for the setup card. */
export function OnboardingVisibilityButton({ hidden, setHidden }: { hidden: boolean; setHidden: (input: { hidden: boolean }) => Promise<void> }) {
  const [pending, start] = useTransition();
  return (
    <button type="button" disabled={pending} className="text-muted-foreground underline" onClick={() => start(() => setHidden({ hidden: !hidden }))}>
      {hidden ? "Show on the home page" : "Hide from home"}
    </button>
  );
}
