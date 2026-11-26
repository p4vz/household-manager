"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { TabBadge, tabClass, tabStripClass } from "./tabs";
import { cn } from "@/lib/utils";

export type HashTab = {
  /** Section id; the tab is selected by #id in the address. */
  id: string;
  label: ReactNode;
  badge?: ReactNode;
  alert?: boolean;
  /** A tab that opens another page instead of a section here. */
  href?: string;
  /** Anchors inside this tab: #alias opens the tab and scrolls to it. */
  aliases?: readonly string[];
};

/**
 * Splits one long page into tabs. The open tab follows the #hash, so links,
 * reminders and form redirects that point at /page#section keep landing on
 * the right tab, and Back steps between tabs.
 */
export function HashTabs({
  tabs,
  panels,
  className,
  label = "Sections",
}: {
  tabs: readonly HashTab[];
  panels: Record<string, ReactNode>;
  className?: string;
  label?: string;
}) {
  const first = tabs.find((t) => !t.href)?.id ?? "";
  const [active, setActive] = useState(first);

  useEffect(() => {
    const owner = new Map<string, string>();
    for (const t of tabs) {
      if (t.href) continue;
      owner.set(t.id, t.id);
      for (const a of t.aliases ?? []) owner.set(a, t.id);
    }
    const sync = () => {
      const h = decodeURIComponent(window.location.hash.slice(1));
      const tab = owner.get(h);
      setActive(tab ?? first);
      // An anchor inside a tab: scroll to it once the tab is showing.
      if (tab && tab !== h) requestAnimationFrame(() => document.getElementById(h)?.scrollIntoView({ block: "start" }));
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [tabs, first]);

  return (
    <div className={cn("space-y-6", className)}>
      <nav aria-label={label} className={tabStripClass}>
        <ul className="flex min-w-max gap-1" role="tablist">
          {tabs.map((t) => {
            const on = !t.href && t.id === active;
            const inner = (
              <>
                {t.label}
                <TabBadge alert={t.alert}>{t.badge}</TabBadge>
              </>
            );
            return (
              <li key={t.id}>
                {t.href ? (
                  <Link href={t.href} className={tabClass(false)}>
                    {inner}
                    <span aria-hidden className="text-xs">↗</span>
                  </Link>
                ) : (
                  <a
                    href={`#${t.id}`}
                    role="tab"
                    aria-selected={on}
                    className={tabClass(on)}
                    onClick={(e) => {
                      // Switch without jumping the page down to the anchor.
                      e.preventDefault();
                      history.pushState(null, "", `${window.location.pathname}${window.location.search}#${t.id}`);
                      setActive(t.id);
                    }}
                  >
                    {inner}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
      {tabs
        .filter((t) => !t.href)
        .map((t) => (
          <div key={t.id} role="tabpanel" hidden={t.id !== active}>
            {panels[t.id]}
          </div>
        ))}
    </div>
  );
}
