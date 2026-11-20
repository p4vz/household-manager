import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listTravelers } from "@/modules/trips/api";
import { ErrorBanner, Field, inputCls, textareaCls } from "@/modules/trips/ui/form";
import { addTravelerAction, deleteTravelerAction, saveDietProfileAction } from "../actions";

const OWNER = { user1: "Me", user2: "Wife" } as const;

export default async function TravelersPage({ searchParams }: PageProps<"/trips/travelers">) {
  const { error } = await searchParams;
  const travelers = await listTravelers();
  return (
    <section className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold">Travellers</h1>
      <ErrorBanner error={error} />
      <p className="text-sm text-muted-foreground">
        Everyone who travels, including kids who never sign in. Names stay in this app: AI features only ever hear &quot;adult&quot; or &quot;child, age 8&quot;.
      </p>
      {travelers.map((t) => (
        <Card key={t.id}>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              {t.name} <Badge variant="outline">{t.kind}</Badge>
              {t.owner ? <Badge variant="secondary">{OWNER[t.owner]}</Badge> : null}
              {t.celiac ? <Badge variant="destructive">coeliac</Badge> : t.glutenFree ? <Badge variant="warning">gluten-free</Badge> : null}
            </CardTitle>
            <form action={deleteTravelerAction}>
              <input type="hidden" name="id" value={t.id} />
              <Button size="sm" variant="ghost">Remove</Button>
            </form>
          </CardHeader>
          <CardContent>
            <form action={saveDietProfileAction} className="flex flex-wrap items-end gap-3 text-sm">
              <input type="hidden" name="id" value={t.id} />
              <label className="flex items-center gap-1"><input type="checkbox" name="celiac" defaultChecked={t.celiac} /> Coeliac disease</label>
              <label className="flex items-center gap-1"><input type="checkbox" name="glutenFree" defaultChecked={t.glutenFree} /> Gluten-free</label>
              <label className="flex items-center gap-1"><input type="checkbox" name="crossContactStrict" defaultChecked={t.crossContactStrict} /> Strict about cross-contact</label>
              <Field label="Other allergens"><input name="otherAllergens" defaultValue={t.otherAllergens.join(", ")} className={`${inputCls} w-48`} placeholder="tree nuts, shellfish" /></Field>
              <Field label="Notes" className="basis-full"><textarea name="dietNotes" defaultValue={t.dietNotes ?? ""} className={textareaCls} /></Field>
              <Button size="sm" variant="outline">Save</Button>
            </form>
          </CardContent>
        </Card>
      ))}
      <Card>
        <CardHeader><CardTitle>Add a traveller</CardTitle></CardHeader>
        <CardContent>
          <form action={addTravelerAction} className="flex flex-wrap items-end gap-2">
            <Field label="Name"><input name="name" required className={`${inputCls} w-40`} /></Field>
            <Field label="Kind">
              <select name="kind" className={inputCls}><option value="adult">Adult</option><option value="child">Child</option></select>
            </Field>
            <Field label="Birthday (for ages)"><input name="birthdate" type="date" className={inputCls} /></Field>
            <Field label="Signs in as">
              <select name="owner" className={inputCls}><option value="">Nobody</option><option value="user1">Me</option><option value="user2">Wife</option></select>
            </Field>
            <Button size="sm">Add</Button>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}
