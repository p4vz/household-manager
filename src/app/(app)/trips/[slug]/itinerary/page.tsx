import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/utils";
import { BOOKING_STATUSES, ITINERARY_KINDS, getTrip, listCreditCards, listItinerary } from "@/modules/trips/api";
import { ErrorBanner, Field, inputCls, textareaCls } from "@/modules/trips/ui/form";
import {
  BOOKING_LABELS,
  ITINERARY_ICONS,
  ITINERARY_LABELS,
  bookingVariant,
  formatDay,
  formatLeg,
  localDay,
  tripDays,
} from "@/modules/trips/ui/format";
import { addItineraryItemAction, deleteItineraryItemAction, updateBookingAction } from "../../actions";

export default async function ItineraryPage({ params, searchParams }: PageProps<"/trips/[slug]/itinerary">) {
  const { slug } = await params;
  const { error } = await searchParams;
  const trip = await getTrip(slug);
  if (!trip) notFound();
  const back = `/trips/${slug}/itinerary`;
  const [items, cards] = await Promise.all([listItinerary(trip.id), listCreditCards()]);
  const cardName = new Map(cards.map((c) => [c.accountId, c.name]));
  const destTz = new Map(trip.destinations.map((d) => [d.id, d.timezone]));
  const defaultTz = trip.destinations[0]?.timezone ?? null;

  // Group by the local day the step starts on, in its own zone.
  const byDay = new Map<string, typeof items>();
  for (const i of items) {
    const day = localDay(i.startsAt, i.timezone);
    byDay.set(day, [...(byDay.get(day) ?? []), i]);
  }
  const days = [...new Set([...tripDays(trip.startDate, trip.endDate), ...byDay.keys()])].sort();
  const zones = [...new Set(trip.destinations.map((d) => d.timezone).filter(Boolean) as string[])];

  return (
    <div className="space-y-6">
      <ErrorBanner error={error} />
      {days.map((day) => {
        const list = byDay.get(day) ?? [];
        return (
          <div key={day} className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground">{formatDay(day)}</h2>
            {list.length === 0 ? <p className="text-sm text-muted-foreground">Nothing planned.</p> : null}
            {list.map((i) => (
              <Card key={i.id} id={`step-${i.id}`} className="scroll-mt-20 gap-2 py-3 target:ring-2 target:ring-primary">
                <CardContent className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span>{ITINERARY_ICONS[i.kind]}</span>
                    <strong>{i.title}</strong>
                    <span className="text-sm text-muted-foreground">
                      {i.allDay ? "all day" : formatLeg(i.startsAt, i.endsAt, i.timezone ?? destTz.get(i.destinationId ?? "") ?? null, i.endTimezone)}
                    </span>
                    <Badge variant={bookingVariant(i.bookingStatus)}>{BOOKING_LABELS[i.bookingStatus]}</Badge>
                    {i.cost != null ? <span className="text-sm tabular-nums">{formatMoney(i.cost)}</span> : null}
                    {i.paidWithAccountId ? <span className="text-sm text-muted-foreground">paid with {cardName.get(i.paidWithAccountId) ?? "an inactive card"}</span> : null}
                    {i.gfVetted ? <Badge variant="secondary">GF vetted</Badge> : null}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {[i.provider, i.location, i.confirmation ? `ref ${i.confirmation}` : null, i.seatNote].filter(Boolean).join(" · ")}
                    {i.verifiedNote ? ` · ${i.verifiedNote}` : ""}
                  </div>
                  {i.notes ? <p className="whitespace-pre-line text-sm">{i.notes}</p> : null}
                  <details className="text-sm print:hidden">
                    <summary className="cursor-pointer text-muted-foreground">Booking and payment</summary>
                    <form action={updateBookingAction} className="mt-2 flex flex-wrap items-end gap-2">
                      <input type="hidden" name="id" value={i.id} />
                      <input type="hidden" name="back" value={back} />
                      <Field label="Status">
                        <select name="bookingStatus" defaultValue={i.bookingStatus} className={inputCls}>
                          {BOOKING_STATUSES.map((s) => <option key={s} value={s}>{BOOKING_LABELS[s]}</option>)}
                        </select>
                      </Field>
                      <Field label="Booked with"><input name="provider" defaultValue={i.provider ?? ""} className={`${inputCls} w-36`} /></Field>
                      <Field label="Confirmation"><input name="confirmation" defaultValue={i.confirmation ?? ""} className={`${inputCls} w-28`} /></Field>
                      <Field label="Booking page"><input name="bookingUrl" type="url" defaultValue={i.bookingUrl ?? ""} className={`${inputCls} w-48`} /></Field>
                      <Field label="Seats"><input name="seatNote" defaultValue={i.seatNote ?? ""} className={`${inputCls} w-40`} /></Field>
                      <Field label="Re-check by"><input name="verifyBy" type="date" defaultValue={i.verifyBy ?? ""} className={inputCls} /></Field>
                      <Field label="Cost ($)"><input name="cost" type="number" min="0" step="0.01" defaultValue={i.cost ?? ""} className={`${inputCls} w-24`} /></Field>
                      <Field label="Paid with">
                        <select name="paidWithAccountId" defaultValue={i.paidWithAccountId ?? ""} className={inputCls}>
                          <option value="">Not paid yet</option>
                          {cards.map((c) => <option key={c.accountId} value={c.accountId}>{c.name}</option>)}
                        </select>
                      </Field>
                      <Field label="Charge date"><input name="chargeDate" type="date" defaultValue={i.chargeDate ?? ""} className={inputCls} /></Field>
                      <Button size="sm" variant="outline">Save</Button>
                    </form>
                    <form action={deleteItineraryItemAction} className="mt-2">
                      <input type="hidden" name="id" value={i.id} />
                      <input type="hidden" name="back" value={back} />
                      <Button size="sm" variant="ghost">Delete step</Button>
                    </form>
                  </details>
                </CardContent>
              </Card>
            ))}
          </div>
        );
      })}

      <Card className="print:hidden">
        <CardHeader><CardTitle>Add a step</CardTitle></CardHeader>
        <CardContent>
          <form action={addItineraryItemAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="tripId" value={trip.id} />
            <input type="hidden" name="back" value={back} />
            <Field label="Kind">
              <select name="kind" className={inputCls}>
                {ITINERARY_KINDS.map((k) => <option key={k} value={k}>{ITINERARY_LABELS[k]}</option>)}
              </select>
            </Field>
            <Field label="Title"><input name="title" required className={`${inputCls} w-56`} placeholder="PHL → ZRH, AA 0746" /></Field>
            <Field label="Place">
              <select name="destinationId" className={inputCls}>
                <option value="">None</option>
                {trip.destinations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Starts (local time)"><input name="startsAt" type="datetime-local" required className={inputCls} /></Field>
            <Field label="Start zone">
              <input name="timezone" list="zones" defaultValue={defaultTz ?? ""} placeholder="America/New_York" className={`${inputCls} w-40`} />
            </Field>
            <Field label="Ends (local time)"><input name="endsAt" type="datetime-local" className={inputCls} /></Field>
            <Field label="End zone (arrival)"><input name="endTimezone" list="zones" placeholder="same as start" className={`${inputCls} w-40`} /></Field>
            <datalist id="zones">
              {["America/New_York", ...zones].map((z) => <option key={z} value={z} />)}
            </datalist>
            <Field label="Booked with"><input name="provider" className={`${inputCls} w-36`} placeholder="United, Marriott…" /></Field>
            <Field label="Cost ($)"><input name="cost" type="number" min="0" step="0.01" className={`${inputCls} w-24`} /></Field>
            <Field label="Sales open on"><input name="bookingOpensOn" type="date" className={inputCls} /></Field>
            <Field label="Booking page"><input name="bookingUrl" type="url" className={`${inputCls} w-48`} /></Field>
            <Field label="Location"><input name="location" className={`${inputCls} w-40`} /></Field>
            <Field label="Confirmation"><input name="confirmation" className={`${inputCls} w-28`} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="gfVetted" /> Gluten-free vetted</label>
            <Field label="Notes" className="basis-full"><textarea name="notes" className={textareaCls} /></Field>
            <Button size="sm">Add</Button>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">Times are entered as they appear on the ticket, in each end&apos;s own zone. &quot;Booked with&quot; is also matched against card bonus rules.</p>
        </CardContent>
      </Card>
    </div>
  );
}
