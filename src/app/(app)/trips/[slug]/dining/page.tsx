import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { GF_STATUSES, aiConfigured, allergyCardsForTrip, diningForTrip, getTrip, listTravelers } from "@/modules/trips/api";
import { ErrorBanner, Field, inputCls, textareaCls } from "@/modules/trips/ui/form";
import { GF_LABELS, gfVariant } from "@/modules/trips/ui/format";
import { PrintButton } from "@/modules/trips/ui/print-button";
import {
  addDiningPlaceAction,
  deleteDiningPlaceAction,
  discoverNearbyAction,
  generateCardsAction,
  importPastedPlacesAction,
  toggleCardVerifiedAction,
  updateDiningPlaceAction,
} from "../../actions";

export default async function DiningPage({ params, searchParams }: PageProps<"/trips/[slug]/dining">) {
  const { slug } = await params;
  const { error } = await searchParams;
  const trip = await getTrip(slug);
  if (!trip) notFound();
  const back = `/trips/${slug}/dining`;
  const [places, cards, travelers] = await Promise.all([diningForTrip(trip.id), allergyCardsForTrip(trip.id), listTravelers()]);
  const needsGf = travelers.some((t) => t.celiac || t.glutenFree);
  const ai = aiConfigured();

  return (
    <div className="space-y-6">
      <ErrorBanner error={error} />
      <p className="text-sm text-muted-foreground print:hidden">
        Ratings describe what a source or you recorded, not a guarantee. For coeliac disease, call ahead and use the cards below.
      </p>

      <section className="space-y-3">
        <div className="flex items-center justify-between print:hidden">
          <h2 className="text-lg font-semibold">Allergy cards</h2>
          {cards.length ? <PrintButton label="Print cards" /> : null}
        </div>
        {!needsGf ? <p className="text-sm text-muted-foreground print:hidden">Mark someone as coeliac or gluten-free under Travellers to write cards.</p> : null}
        <div className="grid gap-3 md:grid-cols-2">
          {cards.map(({ card, destination, traveler }) => (
            <Card key={card.id} className="break-inside-avoid">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {card.languageName} <span className="text-sm font-normal text-muted-foreground">{destination} · {traveler}</span>
                  {card.verified ? <Badge>checked by a person</Badge> : <Badge variant="warning">not yet checked</Badge>}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="whitespace-pre-line text-base" lang={card.language}>{card.body}</p>
                <details className="text-sm text-muted-foreground print:hidden">
                  <summary className="cursor-pointer">What it says in English</summary>
                  <p className="mt-1 whitespace-pre-line">{card.englishBody}</p>
                </details>
                <form action={toggleCardVerifiedAction} className="print:hidden">
                  <input type="hidden" name="id" value={card.id} />
                  <input type="hidden" name="back" value={back} />
                  <Button size="sm" variant="ghost">{card.verified ? "Mark unchecked" : "Mark checked by a person"}</Button>
                </form>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {trip.destinations.map((d) => {
        const here = places.filter((p) => p.destinationId === d.id);
        return (
          <Card key={d.id} className="print:hidden">
            <CardHeader>
              <CardTitle>{d.name}</CardTitle>
              <CardDescription>{here.length} places</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {d.latitude != null ? (
                  <form action={discoverNearbyAction} className="flex items-end gap-2">
                    <input type="hidden" name="destinationId" value={d.id} />
                    <input type="hidden" name="back" value={back} />
                    <Field label="Search OpenStreetMap within">
                      <select name="radius" defaultValue="5000" className={inputCls}>
                        <option value="1500">1.5 km</option>
                        <option value="5000">5 km</option>
                        <option value="15000">15 km</option>
                      </select>
                    </Field>
                    <Button size="sm" variant="outline">Find gluten-free nearby</Button>
                  </form>
                ) : null}
                {ai && needsGf ? (
                  <form action={generateCardsAction} className="flex items-end">
                    <input type="hidden" name="destinationId" value={d.id} />
                    <input type="hidden" name="back" value={back} />
                    <Button size="sm" variant="outline" disabled={d.languages.length === 0} title={d.languages.length ? "" : "Set card languages on the overview"}>
                      Write allergy cards
                    </Button>
                  </form>
                ) : null}
              </div>

              <ul className="space-y-3 text-sm">
                {here.map((p) => (
                  <li key={p.id} className="space-y-1 border-t pt-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong>{p.name}</strong>
                      <Badge variant={gfVariant(p.gfStatus)}>{GF_LABELS[p.gfStatus]}</Badge>
                      {p.dedicatedFryer ? <Badge variant="secondary">dedicated fryer</Badge> : null}
                      {p.favorite ? <span>★</span> : null}
                      {p.cuisine ? <span className="text-muted-foreground">{p.cuisine}</span> : null}
                    </div>
                    <div className="text-muted-foreground">
                      {[p.address, p.phone].filter(Boolean).join(" · ")}
                      {p.website ? <> · <a className="underline" href={p.website} target="_blank" rel="noreferrer noopener">website</a></> : null}
                      {p.fmgfUrl ? <> · <a className="underline" href={p.fmgfUrl} target="_blank" rel="noreferrer noopener">Find Me Gluten Free</a></> : null}
                    </div>
                    {p.notes ? <p>{p.notes}</p> : null}
                    <details>
                      <summary className="cursor-pointer text-muted-foreground">Edit</summary>
                      <form action={updateDiningPlaceAction} className="mt-2 flex flex-wrap items-end gap-2">
                        <input type="hidden" name="id" value={p.id} />
                        <input type="hidden" name="back" value={back} />
                        <Field label="Gluten-free">
                          <select name="gfStatus" defaultValue={p.gfStatus} className={inputCls}>{GF_STATUSES.map((s) => <option key={s} value={s}>{GF_LABELS[s]}</option>)}</select>
                        </Field>
                        <Field label="Our rating">
                          <select name="ourRating" defaultValue={p.ourRating ?? ""} className={inputCls}>
                            <option value="">-</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                          </select>
                        </Field>
                        <label className="flex items-center gap-1"><input type="checkbox" name="visited" defaultChecked={p.visited} /> visited</label>
                        <label className="flex items-center gap-1"><input type="checkbox" name="favorite" defaultChecked={p.favorite} /> favourite</label>
                        <Field label="Notes" className="basis-full"><textarea name="notes" defaultValue={p.notes ?? ""} className={textareaCls} /></Field>
                        <Button size="sm" variant="outline">Save</Button>
                      </form>
                      <form action={deleteDiningPlaceAction} className="mt-1">
                        <input type="hidden" name="id" value={p.id} />
                        <input type="hidden" name="back" value={back} />
                        <Button size="sm" variant="ghost">Delete</Button>
                      </form>
                    </details>
                  </li>
                ))}
              </ul>

              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">Add a place by hand</summary>
                <form action={addDiningPlaceAction} className="mt-2 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="destinationId" value={d.id} />
                  <input type="hidden" name="back" value={back} />
                  <Field label="Name"><input name="name" required className={`${inputCls} w-44`} /></Field>
                  <Field label="Cuisine"><input name="cuisine" className={`${inputCls} w-28`} /></Field>
                  <Field label="Address"><input name="address" className={`${inputCls} w-52`} /></Field>
                  <Field label="Website"><input name="website" type="url" className={`${inputCls} w-44`} /></Field>
                  <Field label="Find Me Gluten Free link"><input name="fmgfUrl" type="url" className={`${inputCls} w-44`} /></Field>
                  <Field label="Gluten-free">
                    <select name="gfStatus" className={inputCls}>{GF_STATUSES.map((s) => <option key={s} value={s}>{GF_LABELS[s]}</option>)}</select>
                  </Field>
                  <label className="flex items-center gap-1"><input type="checkbox" name="dedicatedFryer" /> dedicated fryer</label>
                  <Field label="Notes" className="basis-full"><textarea name="notes" className={textareaCls} /></Field>
                  <Button size="sm" variant="outline">Add</Button>
                </form>
              </details>
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">Paste places from Find Me Gluten Free</summary>
                <form action={importPastedPlacesAction} className="mt-2 space-y-2">
                  <input type="hidden" name="destinationId" value={d.id} />
                  <input type="hidden" name="back" value={back} />
                  <textarea name="pasted" className={`${textareaCls} w-full`} placeholder={"One per line: Name | address | dedicated | notes"} />
                  <Button size="sm" variant="outline">Import</Button>
                </form>
              </details>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
