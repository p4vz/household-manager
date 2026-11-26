"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeTabFor } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/** Main app navigation; the current section is highlighted. */
export function AppNav({ items, className }: { items: readonly { href: string; label: string }[]; className?: string }) {
  const pathname = usePathname();
  const active = activeTabFor(pathname, items.map((i) => i.href).filter((h) => h !== "/")) ?? (pathname === "/" ? "/" : null);
  return (
    <nav aria-label="Main" className={cn("overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}>
      <ul className="flex min-w-max items-center gap-1">
        {items.map((m) => {
          const on = m.href === active;
          return (
            <li key={m.href}>
              <Link
                href={m.href}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "block whitespace-nowrap rounded-full px-3 py-1.5 transition-colors",
                  on ? "bg-foreground font-medium text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {m.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
