import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { formatMoney } from "@/lib/utils";
import { OWNER_LABELS, viewerFromLabel } from "@/modules/finance/api";
import { getTrip, tripSpend } from "@/modules/trips/api";
import { ErrorBanner } from "@/modules/trips/ui/form";
import { ITINERARY_ICONS } from "@/modules/trips/ui/format";
import { tripChargesAction } from "../../actions";

const money = (n: number) => formatMoney(n, { cents: true });
const out = (amount: number) => (amount < 0 ? money(-amount) : `${money(amount)} back`);

export default async function TripSpendPage({ params, searchParams }: PageProps<"/trips/[slug]/spend">) {
  const { slug } = await params;
  const { error } = await searchParams;
  const trip = await getTrip(slug);
  if (!trip) notFound();
  const user = await requireUserOrRedirect();
  const s = await tripSpend(viewerFromLabel(user.owner), trip.id);
  const back = `/trips/${slug}/spend`;
  const steps = s.steps;
  const strong = s.suggestions.filter((x) => x.confidence === "strong");
  const possible = s.suggestions.filter((x) => x.confidence === "possible");
  const stepTitle = new Map(steps.map((x) => [x.id, x.title]));
  const pct = s.planned ? Math.min(100, (s.spent / s.planned) * 100) : 0;
  const misses = s.rewards.rows.filter((r) => r.missedCents > 0).sort((a, b) => b.missedCents - a.missedCents);

  const hidden = (action: string) => (
    <>
      <input type="hidden" name="tripId" value={trip.id} />
      <input type="hidden" name="back" value={back} />
      <input type="hidden" name="action" value={action} />
    </>
  );

  const suggestionTable = (rows: typeof s.suggestions, checked: boolean) => (
    <form action={tripChargesAction} className="space-y-3">
      <input type="hidden" name="tripId" value={trip.id} />
      <input type="hidden" name="back" value={back} />
      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <tbody>
          {rows.map((x) => (
            <tr key={x.transactionId} className="border-t align-top">
              <td className="w-6 py-1.5">
                <input type="checkbox" name="pick" value={x.stepId ? `${x.transactionId}:${x.stepId}` : x.transactionId} defaultChecked={checked} aria-label={`${x.merchant} ${x.date}`} />
              </td>
              <td className="py-1.5 whitespace-nowrap text-muted-foreground">{x.date}</td>
              <td className="py-1.5">
                {x.merchant}
                <div className="text-xs text-muted-foreground">
                  {x.reason}
                  {x.stepId ? <> · goes with &ldquo;{stepTitle.get(x.stepId) ?? "a step"}&rdquo;</> : null}
                </div>
              </td>
              <td className="py-1.5 text-muted-foreground">{x.account}</td>
              <td className="py-1.5 text-right tabular-nums">{out(x.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" name="action" value="link">Add ticked to this trip</Button>
        <Button size="sm" variant="outline" name="action" value="dismiss">Not this trip</Button>
      </div>
    </form>
  );

  return (
    <div className="space-y-6">
      <ErrorBanner error={error} />
      <p className="text-sm text-muted-foreground">
        Real charges from the bank, tied to this trip. Clear matches (the same company as a booking at about its cost, or charged in a trip town during the
        trip) are added after each bank sync; the rest are suggested below. Only accounts you can see in Finance are counted. You can also ask Claude
        &ldquo;what did {trip.name} cost?&rdquo; on the <Link className="underline" href="/assistant">Ask Claude</Link> page.
      </p>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="gap-1 py-4">
          <CardHeader><CardDescription>Planned</CardDescription></CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">{s.planned == null ? "—" : formatMoney(s.planned)}</CardContent>
        </Card>
        <Card className="gap-1 py-4">
          <CardHeader><CardDescription>Spent ({s.charges.length} charges)</CardDescription></CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">{formatMoney(s.spent)}</CardContent>
        </Card>
        <Card className="gap-1 py-4">
          <CardHeader><CardDescription>{s.remaining != null && s.remaining < 0 ? "Over plan" : "Left in plan"}</CardDescription></CardHeader>
          <CardContent className={`text-2xl font-semibold tabular-nums ${s.remaining != null && s.remaining < 0 ? "text-destructive" : ""}`}>
            {s.remaining == null ? "—" : formatMoney(Math.abs(s.remaining))}
          </CardContent>
        </Card>
      </div>
      {s.planned ? <Progress value={pct} indicatorClassName={s.spent > s.planned ? "bg-destructive" : undefined} /> : null}
      {s.spentBeforeTrip > 0 ? <p className="text-xs text-muted-foreground">{formatMoney(s.spentBeforeTrip)} of it was paid before the trip (bookings).</p> : null}

      {s.flags.length ? (
        <Card className="border-warning/50">
          <CardHeader><CardTitle>Worth a look</CardTitle></CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {s.flags.map((f, i) => <li key={i}>{f.message}</li>)}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {strong.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Charges that look like this trip</CardTitle>
            <CardDescription>Ticked ones are added when you press the button. A charge marked &ldquo;not this trip&rdquo; is never suggested for it again.</CardDescription>
          </CardHeader>
          <CardContent>{suggestionTable(strong, true)}</CardContent>
        </Card>
      ) : null}

      {possible.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Maybe this trip</CardTitle>
            <CardDescription>Spending during the trip dates, or travel booked in the months before. Tick the ones that belong.</CardDescription>
          </CardHeader>
          <CardContent>{suggestionTable(possible, false)}</CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>Plan vs actual by step</CardTitle></CardHeader>
        <CardContent>
          {steps.length === 0 ? (
            <p className="text-sm text-muted-foreground">No steps with a cost yet. Add costs on the <Link className="underline" href={`/trips/${slug}/itinerary`}>itinerary</Link>.</p>
          ) : (
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr><th className="py-1">Step</th><th className="text-right">Planned</th><th className="text-right">Charged</th></tr>
              </thead>
              <tbody>
                {steps.map((x) => (
                  <tr key={x.id} className="border-t">
                    <td className="py-1.5">{ITINERARY_ICONS[x.kind]} {x.title}{x.provider ? <span className="text-muted-foreground"> · {x.provider}</span> : null}</td>
                    <td className="text-right tabular-nums">{x.planned == null ? "—" : money(x.planned)}</td>
                    <td className="text-right tabular-nums">{x.actual == null ? <span className="text-muted-foreground">none yet</span> : money(x.actual)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </CardContent>
      </Card>

      {s.byCategory.length ? (
        <Card>
          <CardHeader><CardTitle>By category</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {s.byCategory.map((c) => (
              <div key={c.category} className="flex justify-between"><span>{c.category}</span><span className="tabular-nums">{money(c.amount)}</span></div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Charges on this trip</CardTitle>
          <CardDescription>Tie a charge to a step so the step counts as paid in &ldquo;Which card&rdquo; and its cost is compared with the plan.</CardDescription>
        </CardHeader>
        <CardContent>
          {s.charges.length === 0 ? (
            <p className="text-sm text-muted-foreground">No charges linked yet.</p>
          ) : (
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {s.charges.map((c) => (
                  <tr key={c.id} className="border-t align-top">
                    <td className="py-1.5 whitespace-nowrap text-muted-foreground">{c.date}</td>
                    <td className="py-1.5">
                      {c.merchant} {c.pending ? <Badge variant="outline">pending</Badge> : null}
                      <div className="text-xs text-muted-foreground">
                        {c.account} · {OWNER_LABELS[c.owner as keyof typeof OWNER_LABELS] ?? c.owner}
                        {c.category ? ` · ${c.category}` : ""}
                        {c.source === "auto" ? " · added automatically" : ""}
                      </div>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{out(c.amount)}</td>
                    <td className="py-1.5 pl-3">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <form action={tripChargesAction} className="flex items-center gap-1">
                          {hidden("link")}
                          <input type="hidden" name="pick" value={c.id} />
                          <select name="stepId" defaultValue={c.link?.detailId ?? ""} className="h-8 max-w-44 rounded-md border bg-background px-2 text-xs" aria-label="Step">
                            <option value="">Whole trip</option>
                            {steps.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
                          </select>
                          <Button size="sm" variant="ghost">Save</Button>
                        </form>
                        <form action={tripChargesAction}>
                          {hidden("unlink")}
                          <input type="hidden" name="pick" value={c.id} />
                          <Button size="sm" variant="ghost">Remove</Button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </CardContent>
      </Card>

      {s.rewards.rows.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Rewards on this trip</CardTitle>
            <CardDescription>
              Earned about {money(s.rewards.earned)}.{" "}
              {s.rewards.missed > 0 ? <>The best household card would have earned {money(s.rewards.missed)} more.</> : "Every charge was on the best card."}
            </CardDescription>
          </CardHeader>
          {misses.length ? (
            <CardContent>
              <ul className="space-y-1 text-sm">
                {misses.slice(0, 8).map((m) => (
                  <li key={m.txnId}>
                    {m.merchant} {money(m.amount)} on {m.actualCard}: <strong>{m.bestCard}</strong> would have earned {money(m.missedCents / 100)} more
                  </li>
                ))}
              </ul>
            </CardContent>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
