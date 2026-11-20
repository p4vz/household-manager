import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { emergencyForTrip, getTrip } from "@/modules/trips/api";
import { ErrorBanner, Field, inputCls, textareaCls } from "@/modules/trips/ui/form";
import { PrintButton } from "@/modules/trips/ui/print-button";
import { saveEmergencyInfoAction } from "../../actions";

type Entry = { name: string; detail: string | null };
const asLines = (xs: Entry[] | undefined) => (xs ?? []).map((e) => (e.detail ? `${e.name} | ${e.detail}` : e.name)).join("\n");

function List({ title, entries }: { title: string; entries: Entry[] }) {
  if (!entries.length) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase text-muted-foreground">{title}</h3>
      <ul className="text-sm">{entries.map((e, i) => <li key={i}><strong>{e.name}</strong>{e.detail ? ` · ${e.detail}` : ""}</li>)}</ul>
    </div>
  );
}

export default async function EmergencyPage({ params, searchParams }: PageProps<"/trips/[slug]/emergency">) {
  const { slug } = await params;
  const { error } = await searchParams;
  const trip = await getTrip(slug);
  if (!trip) notFound();
  const back = `/trips/${slug}/emergency`;
  const infos = await emergencyForTrip(trip.id);

  return (
    <div className="space-y-6">
      <ErrorBanner error={error} />
      <div className="flex justify-end print:hidden"><PrintButton /></div>
      {trip.destinations.map((d) => {
        const info = infos.find((x) => x.destinationId === d.id)?.info;
        return (
          <Card key={d.id} className="break-inside-avoid">
            <CardHeader><CardTitle>{d.name}{info?.emergencyNumber ? <span className="ml-3 text-2xl">☎ {info.emergencyNumber}</span> : null}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <List title="Hospitals" entries={info?.hospitals ?? []} />
              <List title="Pharmacies" entries={info?.pharmacies ?? []} />
              <List title="Embassy / consulate" entries={info?.embassies ?? []} />
              <List title="Gluten-free groceries" entries={info?.gfGroceries ?? []} />
              {info?.notes ? <p className="whitespace-pre-line text-sm">{info.notes}</p> : null}
              <details className="text-sm print:hidden">
                <summary className="cursor-pointer text-muted-foreground">{info ? "Edit" : "Add emergency info"}</summary>
                <form action={saveEmergencyInfoAction} className="mt-2 grid gap-2 md:grid-cols-2">
                  <input type="hidden" name="destinationId" value={d.id} />
                  <input type="hidden" name="back" value={back} />
                  <Field label="Emergency number"><input name="emergencyNumber" defaultValue={info?.emergencyNumber ?? (d.countryCode && d.countryCode !== "US" ? "112" : "")} className={inputCls} /></Field>
                  <span className="text-xs text-muted-foreground md:self-end">One per line as &quot;Name | address, phone&quot;.</span>
                  <Field label="Hospitals"><textarea name="hospitals" defaultValue={asLines(info?.hospitals)} className={textareaCls} /></Field>
                  <Field label="Pharmacies"><textarea name="pharmacies" defaultValue={asLines(info?.pharmacies)} className={textareaCls} /></Field>
                  <Field label="Embassy / consulate"><textarea name="embassies" defaultValue={asLines(info?.embassies)} className={textareaCls} /></Field>
                  <Field label="Gluten-free groceries"><textarea name="gfGroceries" defaultValue={asLines(info?.gfGroceries)} className={textareaCls} /></Field>
                  <Field label="Notes" className="md:col-span-2"><textarea name="notes" defaultValue={info?.notes ?? ""} className={textareaCls} /></Field>
                  <div><Button size="sm" variant="outline">Save</Button></div>
                </form>
              </details>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
