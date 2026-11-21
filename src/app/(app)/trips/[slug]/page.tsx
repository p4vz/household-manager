import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/utils";
import { expiringDocuments, getTrip, listItinerary, tripWeather } from "@/modules/trips/api";
import { ErrorBanner, Field, inputCls, textareaCls } from "@/modules/trips/ui/form";
import { BOOKING_LABELS, ITINERARY_ICONS, bookingVariant, daysUntil, formatDay, languageName, nightsBetween } from "@/modules/trips/ui/format";
import {
  addDestinationAction,
  archiveTripAction,
  cancelTripAction,
  deleteDestinationAction,
  setBookingCodeSharingAction,
  updateDestinationAction,
  updateTripAction,
} from "../actions";

function addMonths(iso: string, months: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export default async function TripOverview({ params, searchParams }: PageProps<"/trips/[slug]">) {
  const { slug } = await params;
  const { error } = await searchParams;
  const trip = await getTrip(slug);
  if (!trip) notFound();
  const back = `/trips/${slug}`;
  const [items, weather, expiring] = await Promise.all([
    listItinerary(trip.id),
    tripWeather(trip),
    // Many countries want six months' passport validity past the return date.
    expiringDocuments(addMonths(trip.endDate, 6)),
  ]);
  const open = items.filter((i) => i.bookingStatus === "idea" || i.bookingStatus === "needs_booking");
  const costed = items.filter((i) => i.cost != null && i.bookingStatus !== "cancelled");
  const total = costed.reduce((s, i) => s + i.cost!, 0);
  const days = daysUntil(trip.startDate);

  return (
    <div className="space-y-6">
      <ErrorBanner error={error} />
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>{days > 0 ? "Leaving in" : "Trip"}</CardDescription>
            <CardTitle className="text-3xl">{days > 0 ? `${days} days` : daysUntil(trip.endDate) >= 0 ? "Under way" : "Done"}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">{nightsBetween(trip.startDate, trip.endDate)} nights</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Booking costs entered</CardDescription>
            <CardTitle className="text-3xl">{formatMoney(total)}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {trip.budget != null ? `Budget ${formatMoney(trip.budget)}` : "No budget set, so finance uses this total."}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Still to book</CardDescription>
            <CardTitle className="text-3xl">{open.length}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">of {items.length} itinerary steps</CardContent>
        </Card>
      </div>

      {expiring.length ? (
        <Card className="border-warning">
          <CardHeader><CardTitle>Documents to renew</CardTitle><CardDescription>Expiring within six months of coming home.</CardDescription></CardHeader>
          <CardContent>
            <ul className="text-sm">{expiring.map((d) => <li key={d.id}>{d.title}: expires {d.expiresOn}</li>)}</ul>
          </CardContent>
        </Card>
      ) : null}

      {open.length ? (
        <Card>
          <CardHeader><CardTitle>Booking checklist</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {open.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-2">
                  <span>{ITINERARY_ICONS[i.kind]}</span>
                  <span>{i.title}</span>
                  <Badge variant={bookingVariant(i.bookingStatus)}>{BOOKING_LABELS[i.bookingStatus]}</Badge>
                  {i.bookingOpensOn ? <span className="text-muted-foreground">sales open {i.bookingOpensOn}</span> : null}
                  {i.bookingUrl ? <a className="underline" href={i.bookingUrl} target="_blank" rel="noreferrer noopener">book</a> : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>Places</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {trip.destinations.map((d) => {
            const w = weather.find((x) => x.destinationId === d.id);
            return (
              <div key={d.id} className="space-y-2 border-b pb-3 last:border-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  <strong>{d.name}</strong>
                  <span className="text-sm text-muted-foreground">{[d.country, d.timezone].filter(Boolean).join(" · ")}</span>
                  {d.languages.length ? <span className="text-sm text-muted-foreground">cards in {d.languages.map(languageName).join(", ")}</span> : null}
                </div>
                {w?.days.length ? (
                  <div className="flex flex-wrap gap-2 text-xs">
                    {w.days.map((x) => (
                      <span key={x.date} className="rounded border px-2 py-1">
                        {formatDay(x.date)}: {x.label}, {Math.round(x.minC)}–{Math.round(x.maxC)}°C
                      </span>
                    ))}
                  </div>
                ) : d.latitude != null ? (
                  <p className="text-xs text-muted-foreground">Forecast appears about two weeks before you arrive.</p>
                ) : (
                  <p className="text-xs text-muted-foreground">Place not found by the lookup, so no weather or nearby search.</p>
                )}
                <div className="flex flex-wrap items-end gap-2">
                  <form action={updateDestinationAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="id" value={d.id} />
                    <input type="hidden" name="back" value={back} />
                    <Field label="Arrive"><input name="arriveOn" type="date" defaultValue={d.arriveOn ?? ""} className={inputCls} /></Field>
                    <Field label="Leave"><input name="departOn" type="date" defaultValue={d.departOn ?? ""} className={inputCls} /></Field>
                    <Field label="Card languages (de, it…)"><input name="languages" defaultValue={d.languages.join(", ")} className={`${inputCls} w-36`} /></Field>
                    <Button size="sm" variant="outline">Save</Button>
                  </form>
                  <form action={deleteDestinationAction}>
                    <input type="hidden" name="id" value={d.id} />
                    <input type="hidden" name="back" value={back} />
                    <Button size="sm" variant="ghost">Remove</Button>
                  </form>
                </div>
              </div>
            );
          })}
          <form action={addDestinationAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="tripId" value={trip.id} />
            <input type="hidden" name="back" value={back} />
            <Field label="Add a place"><input name="name" required className={`${inputCls} w-48`} /></Field>
            <Field label="Arrive"><input name="arriveOn" type="date" className={inputCls} /></Field>
            <Field label="Leave"><input name="departOn" type="date" className={inputCls} /></Field>
            <Button size="sm" variant="outline">Add</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI assistants</CardTitle>
          <CardDescription>
            Booking codes for this trip are {trip.shareBookingCodes ? "shared" : "not shared"} with connected assistants.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            {trip.shareBookingCodes
              ? "Assistants that also have the Booking codes permission (Settings > AI assistants) can read this trip's confirmation codes."
              : "Assistants see each booking with a link to its step on the itinerary, where you can read the code yourself."}
          </p>
          <form action={setBookingCodeSharingAction}>
            <input type="hidden" name="tripId" value={trip.id} />
            <input type="hidden" name="back" value={back} />
            <input type="hidden" name="on" value={trip.shareBookingCodes ? "false" : "true"} />
            <Button size="sm" variant="outline">{trip.shareBookingCodes ? "Stop sharing booking codes" : "Share booking codes with assistants"}</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Trip details</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <form action={updateTripAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="tripId" value={trip.id} />
            <input type="hidden" name="back" value={back} />
            <Field label="Name"><input name="name" required defaultValue={trip.name} className={`${inputCls} w-56`} /></Field>
            <Field label="From"><input name="startDate" type="date" required defaultValue={trip.startDate} className={inputCls} /></Field>
            <Field label="To"><input name="endDate" type="date" required defaultValue={trip.endDate} className={inputCls} /></Field>
            <Field label="Budget ($)"><input name="budget" type="number" min="0" step="1" defaultValue={trip.budget ?? ""} className={`${inputCls} w-28`} /></Field>
            <Field label="Notes" className="basis-full"><textarea name="notes" defaultValue={trip.notes ?? ""} className={textareaCls} /></Field>
            <Button size="sm" variant="outline">Save</Button>
          </form>
          <div className="flex gap-2">
            {trip.status === "planned" ? (
              <form action={cancelTripAction}>
                <input type="hidden" name="tripId" value={trip.id} />
                <input type="hidden" name="back" value={back} />
                <Button size="sm" variant="ghost">Cancel trip</Button>
              </form>
            ) : null}
            <form action={archiveTripAction}>
              <input type="hidden" name="tripId" value={trip.id} />
              <Button size="sm" variant="ghost">Archive</Button>
            </form>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
