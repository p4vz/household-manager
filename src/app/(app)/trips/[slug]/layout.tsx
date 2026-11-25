import Link from "next/link";
import { notFound } from "next/navigation";
import { getTrip } from "@/modules/trips/api";
import { formatDateRange } from "@/modules/trips/ui/format";

const TABS = [
  ["", "Overview"],
  ["/itinerary", "Itinerary"],
  ["/spend", "Spend"],
  ["/cards", "Which card"],
  ["/packing", "Packing"],
  ["/dining", "Gluten-free dining"],
  ["/trivia", "Trivia"],
  ["/kids", "Kids"],
  ["/emergency", "Emergency"],
] as const;

export default async function TripLayout({ children, params }: LayoutProps<"/trips/[slug]">) {
  const { slug } = await params;
  const trip = await getTrip(slug);
  if (!trip) notFound();
  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">
          {trip.name} {trip.status === "cancelled" ? <span className="text-base text-destructive">(cancelled)</span> : null}
        </h1>
        <p className="text-sm text-muted-foreground">{trip.destination} · {formatDateRange(trip.startDate, trip.endDate)}</p>
      </div>
      <nav className="flex flex-wrap gap-4 text-sm print:hidden">
        {TABS.map(([href, label]) => (
          <Link key={href} href={`/trips/${slug}${href}`} className="text-muted-foreground hover:text-foreground">{label}</Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
