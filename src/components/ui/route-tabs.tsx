"use client";

import { usePathname } from "next/navigation";
import { TabBar, activeTabFor, type TabItem } from "./tabs";

/** A TabBar that highlights the tab matching the current route. */
export function RouteTabs({ items, className, label }: { items: readonly TabItem[]; className?: string; label?: string }) {
  const pathname = usePathname();
  const active = activeTabFor(pathname, items.map((i) => i.href));
  return <TabBar items={items} active={active} className={className} label={label} />;
}
