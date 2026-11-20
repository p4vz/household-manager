import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cardCatalog, listCatalogChanges } from "@/modules/finance/api";
import { CatalogCheckButton, CatalogTermsEditor } from "@/modules/finance/ui/catalog-forms";
import { changeLines, daysAgo, multipliersText, offerText } from "@/modules/finance/ui/catalog-format";
import { addCatalogProductAction, markCatalogChangesSeenAction, refreshCatalogCardAction, reviewCatalogChangeAction, saveCatalogTermsAction } from "../../actions";

const input = "h-8 rounded-md border bg-background px-2";

export default async function CardCatalogPage() {
  const [catalog, changes] = await Promise.all([cardCatalog(), listCatalogChanges({ limit: 40 })]);
  const pending = changes.filter((c) => c.status === "pending");
  const recent = changes.filter((c) => c.status === "applied");
  const unseen = recent.some((c) => !c.seen);

  return (
    <section className="max-w-5xl space-y-8">
      <div>
        <Link href="/finance/rewards" className="text-sm text-muted-foreground hover:text-foreground">← Card rewards</Link>
        <h1 className="text-2xl font-semibold">Card catalog</h1>
        <p className="text-sm text-muted-foreground">
          The stored copy of each card&apos;s published terms. The audit and the AI advisor read it from here instead of searching each time.
          Each day at 6 AM the cards that are due are checked against the issuer&apos;s own pages: your cards weekly, others monthly, and
          rotating-category cards again as each quarter&apos;s categories are announced.
        </p>
      </div>

      {pending.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Needs your review</CardTitle>
            <CardDescription>The refresh found these changes but did not save them.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {pending.map((c) => (
              <div key={c.id} className="space-y-1 border-t pt-3 first:border-t-0 first:pt-0">
                <div className="flex items-center gap-2">
                  <strong>{c.issuer} {c.name}</strong>
                  <span className="text-muted-foreground">{c.reason}</span>
                  <form action={reviewCatalogChangeAction} className="ml-auto flex gap-2">
                    <input type="hidden" name="id" value={c.id} />
                    <Button size="sm" name="decision" value="accept">Accept</Button>
                    <Button size="sm" variant="ghost" name="decision" value="reject">Reject</Button>
                  </form>
                </div>
                <ul className="list-disc pl-5">{changeLines(c.changes).map((l, i) => <li key={i}>{l}</li>)}</ul>
                <Sources urls={c.sourceUrls} />
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {recent.length ? (
        <Card>
          <CardHeader className="flex-row items-start justify-between">
            <div>
              <CardTitle>Recent changes</CardTitle>
              <CardDescription>Saved automatically. Your own cards&apos; rules are only updated when you apply them on the Rewards page.</CardDescription>
            </div>
            {unseen ? (
              <form action={markCatalogChangesSeenAction}><Button size="sm" variant="ghost">Mark all seen</Button></form>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {recent.slice(0, 15).map((c) => (
              <div key={c.id}>
                <div className="flex items-center gap-2">
                  <strong>{c.issuer} {c.name}</strong>
                  {!c.seen ? <Badge variant="warning">New</Badge> : null}
                  <span className="text-muted-foreground">{c.detectedAt.toLocaleDateString()}{c.reason ? ` · ${c.reason}` : ""}</span>
                </div>
                <ul className="list-disc pl-5">{changeLines(c.changes).map((l, i) => <li key={i}>{l}</li>)}</ul>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Cards on file</h2>
        {catalog.map((p) => (
          <Card key={p.id}>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  {p.issuer} {p.name}
                  {p.held ? <Badge>Yours</Badge> : null}
                  {p.status === "verified" ? (
                    <Badge variant="secondary">Verified {daysAgo(p.verifiedAt)}</Badge>
                  ) : (
                    <Badge variant="warning">{p.status === "seed" ? "Not yet verified" : "Waiting for first lookup"}</Badge>
                  )}
                  {p.editedBy === "user" ? <Badge variant="outline">Edited by you</Badge> : null}
                </CardTitle>
                {p.lastError ? <CardDescription className="text-destructive">Last check {daysAgo(p.checkedAt)}: {p.lastError}</CardDescription> : null}
              </div>
              <CatalogCheckButton action={refreshCatalogCardAction} productId={p.id} />
            </CardHeader>
            {p.terms ? (
              <CardContent className="space-y-1 text-sm">
                <p>
                  <strong>${p.terms.annualFee}</strong> fee · base {p.terms.rewardType === "cashback" ? `${p.terms.baseRate}%` : `${p.terms.baseRate}x`}
                  {p.terms.rewardCurrency ? ` ${p.terms.rewardCurrency}` : ""} · {p.terms.pointValueCents}¢/pt
                  {p.terms.multipliers.length ? ` · ${multipliersText(p.terms)}` : ""}
                </p>
                {p.terms.rotating ? (
                  <p>
                    Rotating {p.terms.rotating.rate}% to ${p.terms.rotating.capAmount?.toLocaleString() ?? "∞"}/quarter
                    {p.terms.rotating.activationRequired ? " (activate each quarter)" : ""}:{" "}
                    {p.terms.rotating.quarters.length
                      ? p.terms.rotating.quarters.slice(-3).map((q) => `${q.quarter} ${q.description}`).join("; ")
                      : "no quarters on file yet"}
                  </p>
                ) : null}
                <p>Sign-up offer: {offerText(p.terms)}</p>
                {p.terms.credits.length ? <p className="text-muted-foreground">Credits: {p.terms.credits.map((c) => `${c.label} $${c.amount}/${c.period}`).join(" · ")}</p> : null}
                {p.terms.perks.length ? <p className="text-muted-foreground">Perks: {p.terms.perks.join(" · ")}</p> : null}
                <Sources urls={p.sourceUrls} />
                <details className="pt-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">Edit terms</summary>
                  <p className="my-2 text-xs text-muted-foreground">
                    Your edits are kept: later checks will only propose changes to this card for review.
                  </p>
                  <CatalogTermsEditor action={saveCatalogTermsAction} productId={p.id} terms={JSON.stringify(p.terms, null, 2)} />
                </details>
              </CardContent>
            ) : null}
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add a card</CardTitle>
          <CardDescription>Its terms are looked up on the next daily run, or press Check now once it is listed.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={addCatalogProductAction} className="flex flex-wrap items-end gap-2 text-sm">
            <label className="flex flex-col">Issuer<input name="issuer" required placeholder="Chase" className={`${input} w-36`} /></label>
            <label className="flex flex-col">Card<input name="name" required placeholder="Ink Business Preferred" className={`${input} w-56`} /></label>
            <label className="flex flex-col">Issuer website(s)<input name="sourceDomains" required placeholder="chase.com" className={`${input} w-48`} /></label>
            <Button size="sm" variant="outline">Add</Button>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}

function Sources({ urls }: { urls: string[] }) {
  if (!urls.length) return null;
  return (
    <p className="text-xs text-muted-foreground">
      Source:{" "}
      {urls.slice(0, 3).map((u, i) => (
        <span key={u}>
          {i ? ", " : ""}
          <a href={u} target="_blank" rel="noreferrer noopener" className="underline">{hostOf(u)}</a>
        </span>
      ))}
    </p>
  );
}

function hostOf(u: string) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}
