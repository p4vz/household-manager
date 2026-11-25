"use client";

import { useState, type ReactNode } from "react";

/** Right side of the kiosk: Chores / Shopping / Returns / Upkeep as big tabs, each with a count of open items. */
export function HubTabs({ tabs }: { tabs: { key: string; label: string; badge?: number; alert?: boolean; content: ReactNode }[] }) {
  const [active, setActive] = useState(tabs[0]?.key);
  const current = tabs.find((t) => t.key === active) ?? tabs[0];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex gap-2" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === current?.key}
            onClick={() => setActive(t.key)}
            className={`min-h-12 min-w-0 flex-1 whitespace-nowrap rounded-xl px-1 text-base font-semibold xl:text-lg ${
              t.key === current?.key ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900" : "bg-white dark:bg-slate-800"
            }`}
          >
            {t.label}
            {t.badge ? (
              <span className={`ml-1.5 rounded-full px-2 py-0.5 text-sm ${t.alert ? "bg-red-600 text-white" : "bg-slate-300 text-slate-900"}`}>{t.badge}</span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">{current?.content}</div>
    </div>
  );
}
