import { RouteTabs } from "@/components/ui/route-tabs";

const LINKS = [
  { href: "/trips", label: "Trips" },
  { href: "/trips/packing", label: "Packing lists" },
  { href: "/trips/documents", label: "Documents" },
  { href: "/trips/travelers", label: "Travellers" },
];

export default function TripsLayout({ children }: LayoutProps<"/trips">) {
  return (
    <div className="space-y-6">
      <RouteTabs items={LINKS} label="Trips" />
      {children}
    </div>
  );
}
