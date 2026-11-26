import { RouteTabs } from "@/components/ui/route-tabs";

const LINKS = [
  { href: "/finance", label: "Overview" },
  { href: "/finance/transactions", label: "Transactions" },
  { href: "/finance/budget", label: "Budget" },
  { href: "/finance/accounts", label: "Accounts" },
  { href: "/finance/subscriptions", label: "Subscriptions" },
  { href: "/finance/net-worth", label: "Net worth" },
  { href: "/finance/rewards", label: "Rewards" },
  { href: "/finance/review", label: "Review" },
  { href: "/finance/import", label: "Import" },
];

export default function FinanceLayout({ children }: LayoutProps<"/finance">) {
  return (
    <div className="space-y-6">
      <RouteTabs items={LINKS} label="Finance" />
      {children}
    </div>
  );
}
