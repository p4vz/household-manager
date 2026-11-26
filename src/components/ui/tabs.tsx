import Link from "next/link";
import type * as React from "react";
import { cn } from "@/lib/utils";

export type TabItem = {
  href: string;
  label: React.ReactNode;
  /** Small count or note shown after the label. */
  badge?: React.ReactNode;
  /** Draws attention to the badge (overdue, needs review). */
  alert?: boolean;
};

export const tabStripClass =
  "-mx-4 overflow-x-auto border-b px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 print:hidden [&::-webkit-scrollbar]:hidden";

export function tabClass(on: boolean) {
  return cn(
    "-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors",
    on ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
  );
}

export function TabBadge({ children, alert }: { children: React.ReactNode; alert?: boolean }) {
  if (children === undefined || children === null || children === false) return null;
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-px text-xs tabular-nums leading-4",
        alert ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/**
 * Underlined tab strip for switching between the sections of a page or a
 * module. One line on every screen: it scrolls sideways on a phone instead of
 * wrapping into a ragged block of links.
 */
export function TabBar({
  items,
  active,
  className,
  label = "Sections",
}: {
  items: readonly TabItem[];
  /** The href of the selected tab. */
  active: string | null;
  className?: string;
  label?: string;
}) {
  return (
    <nav
      aria-label={label}
      className={cn(tabStripClass, className)}
    >
      <ul className="flex min-w-max gap-1">
        {items.map((t) => {
          const on = t.href === active;
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={on ? "page" : undefined}
                className={tabClass(on)}
              >
                {t.label}
                <TabBadge alert={t.alert}>{t.badge}</TabBadge>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Picks the tab whose href is the longest prefix of the current path. */
export function activeTabFor(pathname: string, hrefs: readonly string[]): string | null {
  let best: string | null = null;
  for (const h of hrefs) {
    const exact = pathname === h;
    const prefix = pathname.startsWith(h.endsWith("/") ? h : `${h}/`);
    if ((exact || prefix) && (best === null || h.length > best.length)) best = h;
  }
  return best;
}
