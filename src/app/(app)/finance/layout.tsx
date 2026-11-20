import Link from "next/link";

const LINKS = [
  { href: "/finance", label: "Overview" },
  { href: "/finance/budget", label: "Budget" },
  { href: "/finance/rewards", label: "Rewards" },
  { href: "/finance/transactions", label: "Transactions" },
  { href: "/finance/accounts", label: "Accounts" },
  { href: "/finance/import", label: "Import" },
];

export default function FinanceLayout({ children }: LayoutProps<"/finance">) {
  return (
    <div className="space-y-6">
      <nav className="flex gap-4 border-b pb-2 text-sm">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="text-muted-foreground hover:text-foreground">{l.label}</Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
