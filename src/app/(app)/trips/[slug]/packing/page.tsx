import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PACKING_CATEGORIES, aiConfigured, getTrip, listTemplates, listTravelers, tripPacking } from "@/modules/trips/api";
import { ErrorBanner, Field, inputCls } from "@/modules/trips/ui/form";
import { PACKING_LABELS } from "@/modules/trips/ui/format";
import {
  addPackingItemAction,
  createEmptyListAction,
  deletePackingItemAction,
  saveListAsTemplateAction,
  suggestForListAction,
  togglePackingItemAction,
  applyTemplateAction,
} from "../../actions";

export default async function TripPackingPage({ params, searchParams }: PageProps<"/trips/[slug]/packing">) {
  const { slug } = await params;
  const { error } = await searchParams;
  const trip = await getTrip(slug);
  if (!trip) notFound();
  const back = `/trips/${slug}/packing`;
  const [lists, templates, travelers] = await Promise.all([tripPacking(trip.id), listTemplates(), listTravelers()]);
  const who = new Map(travelers.map((t) => [t.id, t.name]));
  const ai = aiConfigured();

  return (
    <div className="space-y-6">
      <ErrorBanner error={error} />
      {lists.map((list) => {
        const done = list.items.filter((i) => i.packed).length;
        const groups = PACKING_CATEGORIES.map((c) => [c, list.items.filter((i) => i.category === c)] as const).filter(([, xs]) => xs.length);
        return (
          <Card key={list.id}>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>{list.name} <span className="text-sm font-normal text-muted-foreground">{done}/{list.items.length} packed</span></CardTitle>
              {ai ? (
                <form action={suggestForListAction}>
                  <input type="hidden" name="listId" value={list.id} />
                  <input type="hidden" name="back" value={back} />
                  <Button size="sm" variant="outline">Suggest what&apos;s missing</Button>
                </form>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-4">
              {groups.map(([cat, items]) => (
                <div key={cat}>
                  <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{PACKING_LABELS[cat]}</h3>
                  <ul className="space-y-0.5 text-sm">
                    {items.map((i) => (
                      <li key={i.id} className="flex items-center gap-2">
                        <form action={togglePackingItemAction}>
                          <input type="hidden" name="id" value={i.id} />
                          <input type="hidden" name="back" value={back} />
                          <button aria-label={i.packed ? "Unpack" : "Mark packed"} className="w-5 text-left">{i.packed ? "☑" : "☐"}</button>
                        </form>
                        <span className={i.packed ? "text-muted-foreground line-through" : ""}>
                          {i.name}{i.quantity > 1 ? ` ×${i.quantity}` : ""}
                        </span>
                        <span className="text-xs text-muted-foreground">{i.travelerId ? who.get(i.travelerId) : "shared"}</span>
                        {i.notes ? <span className="text-xs text-muted-foreground">· {i.notes}</span> : null}
                        <form action={deletePackingItemAction} className="ml-auto">
                          <input type="hidden" name="id" value={i.id} />
                          <input type="hidden" name="back" value={back} />
                          <button className="text-xs text-muted-foreground hover:text-destructive">remove</button>
                        </form>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <form action={addPackingItemAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="listId" value={list.id} />
                <input type="hidden" name="back" value={back} />
                <Field label="Item"><input name="name" required className={`${inputCls} w-44`} /></Field>
                <Field label="Category">
                  <select name="category" className={inputCls}>{PACKING_CATEGORIES.map((c) => <option key={c} value={c}>{PACKING_LABELS[c]}</option>)}</select>
                </Field>
                <Field label="Qty"><input name="quantity" type="number" min="1" defaultValue={1} className={`${inputCls} w-16`} /></Field>
                <Field label="Whose">
                  <select name="travelerId" className={inputCls}>
                    <option value="">Shared</option>
                    {travelers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </Field>
                <Button size="sm" variant="outline">Add</Button>
              </form>
              <form action={saveListAsTemplateAction} className="flex items-end gap-2">
                <input type="hidden" name="listId" value={list.id} />
                <input type="hidden" name="back" value={back} />
                <Field label="Save as a reusable list"><input name="name" required placeholder="Winter Europe" className={`${inputCls} w-48`} /></Field>
                <Button size="sm" variant="ghost">Save template</Button>
              </form>
            </CardContent>
          </Card>
        );
      })}

      <Card>
        <CardHeader><CardTitle>Start a list</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {templates.length ? (
            <form action={applyTemplateAction} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="tripId" value={trip.id} />
              <input type="hidden" name="back" value={back} />
              <Field label="From a reusable list">
                <select name="templateId" className={inputCls}>{templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.items.length})</option>)}</select>
              </Field>
              <fieldset className="flex flex-wrap gap-3 text-sm">
                <legend className="text-xs text-muted-foreground">Who is going</legend>
                {travelers.map((t) => (
                  <label key={t.id} className="flex items-center gap-1"><input type="checkbox" name="travelerIds" value={t.id} defaultChecked /> {t.name}</label>
                ))}
              </fieldset>
              <Button size="sm">Use list</Button>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">No reusable lists yet. Make one under <Link className="underline" href="/trips/packing">Packing lists</Link>.</p>
          )}
          {travelers.length === 0 ? <p className="text-sm text-muted-foreground">Add the family under <Link className="underline" href="/trips/travelers">Travellers</Link> so per-person items expand.</p> : null}
          <form action={createEmptyListAction} className="flex items-end gap-2">
            <input type="hidden" name="tripId" value={trip.id} />
            <input type="hidden" name="back" value={back} />
            <Field label="Or an empty list"><input name="name" required defaultValue="Packing" className={`${inputCls} w-40`} /></Field>
            <Button size="sm" variant="outline">Create</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
