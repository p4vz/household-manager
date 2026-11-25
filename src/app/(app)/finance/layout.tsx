import Link from "next/link";

const LINKS = [
  { href: "/finance", label: "Overview" },
  { href: "/finance/budget", label: "Budget" },
  { href: "/finance/rewards", label: "Rewards" },
  { href: "/finance/transactions", label: "Transactions" },
  { href: "/finance/accounts", label: "Accounts" },
  { href: "/finance/subscriptions", label: "Subscriptions" },
  { href: "/finance/net-worth", label: "Net worth" },
  { href: "/finance/import", label: "Import" },
  { href: "/finance/review", label: "Review" },
];

export default function FinanceLayout({ children }: LayoutProps<"/finance">) {
  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-x-4 gap-y-1 border-b pb-2 text-sm">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="text-muted-foreground hover:text-foreground">{l.label}</Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
