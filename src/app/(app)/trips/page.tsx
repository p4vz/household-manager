import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/utils";
import { listTrips, outstandingBookings } from "@/modules/trips/api";
import { ErrorBanner, Field, inputCls } from "@/modules/trips/ui/form";
import { BOOKING_LABELS, ITINERARY_ICONS, bookingVariant, daysUntil, formatDateRange } from "@/modules/trips/ui/format";
import { createTripAction } from "./actions";

export default async function TripsPage({ searchParams }: PageProps<"/trips">) {
  const { error } = await searchParams;
  const [trips, outstanding] = await Promise.all([listTrips(), outstandingBookings()]);
  const upcoming = trips.filter((t) => t.status === "planned");

  return (
    <section className="max-w-5xl space-y-8">
      <h1 className="text-2xl font-semibold">Trips</h1>
      <ErrorBanner error={error} />

      <div className="grid gap-4 md:grid-cols-2">
        {upcoming.map((t) => {
          const days = daysUntil(t.startDate);
          return (
            <Link key={t.id} href={`/trips/${t.slug}`}>
              <Card className="h-full hover:border-foreground/30">
                <CardHeader>
                  <CardTitle>{t.name}</CardTitle>
                  <CardDescription>{t.destination} · {formatDateRange(t.startDate, t.endDate)}</CardDescription>
                </CardHeader>
                <CardContent className="flex gap-3 text-sm text-muted-foreground">
                  <span>{days > 0 ? `in ${days} days` : days >= -30 && daysUntil(t.endDate) >= 0 ? "under way" : "past"}</span>
                  {t.budget != null ? <span>budget {formatMoney(t.budget)}</span> : null}
                </CardContent>
              </Card>
            </Link>
          );
        })}
        {upcoming.length === 0 ? <p className="text-muted-foreground">No trips yet. Plan one below.</p> : null}
      </div>

      {outstanding.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Still to book or re-check</CardTitle>
            <CardDescription>Soonest deadline first.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {outstanding.slice(0, 15).map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-2">
                  <span>{ITINERARY_ICONS[o.kind]}</span>
                  <Link className="underline" href={`/trips/${o.tripSlug}/itinerary`}>{o.title}</Link>
                  <span className="text-muted-foreground">{o.tripName}</span>
                  <Badge variant={bookingVariant(o.bookingStatus)}>{BOOKING_LABELS[o.bookingStatus]}</Badge>
                  {o.bookingOpensOn ? <span className="text-muted-foreground">sales open {o.bookingOpensOn}</span> : null}
                  {o.verifyBy ? <span className="text-muted-foreground">re-check by {o.verifyBy}</span> : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>Plan a trip</CardTitle></CardHeader>
        <CardContent>
          <form action={createTripAction} className="flex flex-wrap items-end gap-3">
            <Field label="Name"><input name="name" required className={`${inputCls} w-56`} placeholder="Thanksgiving in the Alps" /></Field>
            <Field label="From"><input name="startDate" type="date" required className={inputCls} /></Field>
            <Field label="To"><input name="endDate" type="date" required className={inputCls} /></Field>
            <Field label="Places, comma separated"><input name="places" className={`${inputCls} w-72`} placeholder="Zurich, Innsbruck, Bolzano" /></Field>
            <Field label="Budget ($, optional)"><input name="budget" type="number" min="0" step="1" className={`${inputCls} w-28`} /></Field>
            <Button size="sm">Create</Button>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">Places are looked up for weather, time zones and nearby gluten-free food. The trip and its budget (or the sum of booking costs) appear on the calendar and in finance.</p>
        </CardContent>
      </Card>
    </section>
  );
}
