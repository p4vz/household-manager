import Link from "next/link";

const LINKS = [
  { href: "/trips", label: "Trips" },
  { href: "/trips/packing", label: "Packing lists" },
  { href: "/trips/documents", label: "Documents" },
  { href: "/trips/travelers", label: "Travellers" },
];

export default function TripsLayout({ children }: LayoutProps<"/trips">) {
  return (
    <div className="space-y-6">
      <nav className="flex gap-4 border-b pb-2 text-sm print:hidden">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="text-muted-foreground hover:text-foreground">{l.label}</Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
