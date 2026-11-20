import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DOCUMENT_KINDS, listDocuments, listTravelers, listTrips, vaultConfigured } from "@/modules/trips/api";
import { ErrorBanner, Field, inputCls, textareaCls } from "@/modules/trips/ui/form";
import { DOCUMENT_LABELS, daysUntil } from "@/modules/trips/ui/format";
import { OpenDocumentButton } from "@/modules/trips/ui/open-document-button";
import { addDocumentAction, deleteDocumentAction, openDocumentAction } from "../actions";

export default async function DocumentsPage({ searchParams }: PageProps<"/trips/documents">) {
  const { error } = await searchParams;
  const [docs, travelers, trips] = await Promise.all([listDocuments(), listTravelers(), listTrips()]);
  const vault = vaultConfigured();
  const who = new Map(travelers.map((t) => [t.id, t.name]));
  const trip = new Map(trips.map((t) => [t.id, t.name]));

  return (
    <section className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold">Documents</h1>
      <ErrorBanner error={error} />
      <p className="text-sm text-muted-foreground">
        Files are encrypted (AES-256-GCM) before they reach the database. Only the last four characters of a number and the expiry date are kept readable. AI features never see this page.
      </p>
      {!vault ? <p className="text-sm text-warning">DOC_VAULT_KEY is not set, so files cannot be uploaded yet. Details-only entries still work.</p> : null}

      <Card>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr><th className="py-1">Document</th><th>For</th><th>Number</th><th>Expires</th><th /></tr>
            </thead>
            <tbody>
              {docs.map((d) => {
                const left = d.expiresOn ? daysUntil(d.expiresOn) : null;
                return (
                  <tr key={d.id} className="border-t align-top">
                    <td className="py-1.5">
                      <Badge variant="outline">{DOCUMENT_LABELS[d.kind]}</Badge> {d.title}
                      {d.tripId ? <span className="text-muted-foreground"> · {trip.get(d.tripId)}</span> : null}
                    </td>
                    <td>{d.travelerId ? who.get(d.travelerId) : "Household"}</td>
                    <td>{d.documentNumberLast4 ? `…${d.documentNumberLast4}` : ""}</td>
                    <td className={left != null && left < 183 ? "text-destructive" : ""}>{d.expiresOn ?? ""}</td>
                    <td className="space-x-3 text-right">
                      {d.hasFile ? <OpenDocumentButton id={d.id} action={openDocumentAction} /> : null}
                      <form action={deleteDocumentAction} className="inline">
                        <input type="hidden" name="id" value={d.id} />
                        <button className="text-xs text-muted-foreground hover:text-destructive">delete</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
              {docs.length === 0 ? <tr><td colSpan={5} className="py-2 text-muted-foreground">Nothing stored yet.</td></tr> : null}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Add a document</CardTitle><CardDescription>Up to 8 MB per file.</CardDescription></CardHeader>
        <CardContent>
          <form action={addDocumentAction} className="flex flex-wrap items-end gap-2">
            <Field label="Title"><input name="title" required className={`${inputCls} w-48`} placeholder="Passport" /></Field>
            <Field label="Kind">
              <select name="kind" className={inputCls}>{DOCUMENT_KINDS.map((k) => <option key={k} value={k}>{DOCUMENT_LABELS[k]}</option>)}</select>
            </Field>
            <Field label="Whose">
              <select name="travelerId" className={inputCls}><option value="">Household</option>{travelers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
            </Field>
            <Field label="Trip">
              <select name="tripId" className={inputCls}><option value="">Any trip</option>{trips.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
            </Field>
            <Field label="Number (only last 4 kept)"><input name="documentNumber" autoComplete="off" className={`${inputCls} w-36`} /></Field>
            <Field label="Expires"><input name="expiresOn" type="date" className={inputCls} /></Field>
            <Field label="Issued by"><input name="issuingCountry" className={`${inputCls} w-28`} /></Field>
            <Field label="File"><input name="file" type="file" disabled={!vault} accept="application/pdf,image/*" className="text-sm" /></Field>
            <Field label="Notes" className="basis-full"><textarea name="notes" className={textareaCls} /></Field>
            <Button size="sm">Save</Button>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}
