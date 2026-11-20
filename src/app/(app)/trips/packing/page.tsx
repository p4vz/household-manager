import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PACKING_CATEGORIES, listTemplates } from "@/modules/trips/api";
import { ErrorBanner, Field, inputCls } from "@/modules/trips/ui/form";
import { PACKING_LABELS } from "@/modules/trips/ui/format";
import { addTemplateItemAction, createTemplateAction, deleteTemplateAction, deleteTemplateItemAction } from "../actions";

export default async function PackingTemplatesPage({ searchParams }: PageProps<"/trips/packing">) {
  const { error } = await searchParams;
  const templates = await listTemplates();
  return (
    <section className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold">Reusable packing lists</h1>
      <ErrorBanner error={error} />
      <p className="text-sm text-muted-foreground">Build a list once and use it on any trip. Per-person items get one checkbox per traveller; ticking things off on a trip never changes the list here.</p>
      {templates.map((t) => (
        <Card key={t.id}>
          <CardHeader className="flex-row items-start justify-between">
            <div>
              <CardTitle>{t.name}</CardTitle>
              {t.description || t.tags.length ? <CardDescription>{[t.description, t.tags.join(", ")].filter(Boolean).join(" · ")}</CardDescription> : null}
            </div>
            <form action={deleteTemplateAction}>
              <input type="hidden" name="id" value={t.id} />
              <Button size="sm" variant="ghost">Delete list</Button>
            </form>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="grid gap-1 text-sm md:grid-cols-2">
              {t.items.map((i) => (
                <li key={i.id} className="flex items-center gap-2">
                  <span>{i.name}{i.quantity > 1 ? ` ×${i.quantity}` : ""}</span>
                  <span className="text-xs text-muted-foreground">{PACKING_LABELS[i.category]} · {i.perPerson ? "each" : "shared"}</span>
                  <form action={deleteTemplateItemAction} className="ml-auto">
                    <input type="hidden" name="id" value={i.id} />
                    <button className="text-xs text-muted-foreground hover:text-destructive">remove</button>
                  </form>
                </li>
              ))}
            </ul>
            <form action={addTemplateItemAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="templateId" value={t.id} />
              <Field label="Item"><input name="name" required className={`${inputCls} w-44`} /></Field>
              <Field label="Category">
                <select name="category" className={inputCls}>{PACKING_CATEGORIES.map((c) => <option key={c} value={c}>{PACKING_LABELS[c]}</option>)}</select>
              </Field>
              <Field label="Qty"><input name="quantity" type="number" min="1" defaultValue={1} className={`${inputCls} w-16`} /></Field>
              <label className="flex items-center gap-1 text-sm"><input type="checkbox" name="perPerson" defaultChecked /> one each</label>
              <Button size="sm" variant="outline">Add</Button>
            </form>
          </CardContent>
        </Card>
      ))}
      <Card>
        <CardHeader><CardTitle>New list</CardTitle></CardHeader>
        <CardContent>
          <form action={createTemplateAction} className="flex flex-wrap items-end gap-2">
            <Field label="Name"><input name="name" required className={`${inputCls} w-56`} placeholder="Winter Europe, Christmas markets" /></Field>
            <Field label="Description"><input name="description" className={`${inputCls} w-56`} /></Field>
            <Field label="Tags"><input name="tags" className={`${inputCls} w-40`} placeholder="cold, international" /></Field>
            <Button size="sm">Create</Button>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}
