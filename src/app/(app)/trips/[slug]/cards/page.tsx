import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatMoney } from "@/lib/utils";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { viewerFromLabel } from "@/modules/finance/api";
import { getTrip, tripCardPlan } from "@/modules/trips/api";
import { ITINERARY_ICONS } from "@/modules/trips/ui/format";

export default async function TripCardsPage({ params }: PageProps<"/trips/[slug]/cards">) {
  const { slug } = await params;
  const trip = await getTrip(slug);
  if (!trip) notFound();
  const user = await requireUserOrRedirect();
  const plan = await tripCardPlan(viewerFromLabel(user.owner), trip.id);
  const unpaid = plan.steps.filter((s) => s.plan);
  const paid = plan.steps.filter((s) => s.paidWith);
  const extra = unpaid.reduce((s, x) => s + Math.max(0, x.plan!.recommended.cents - x.plan!.options[x.plan!.options.length - 1].cents), 0);
  const bonusesHelped = plan.bonuses.filter((b) => b.planned > 0);

  if (!plan.hasProfiles) {
    return (
      <p className="text-muted-foreground">
        Set up reward profiles for the household cards on <Link className="underline" href="/finance/rewards">Finance → Rewards</Link> and this page will say which card to book each step with.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Based on the cards&apos; reward profiles and sign-up offers in finance. Only steps with a cost that are not yet paid are planned. Cap usage counts this year&apos;s real spending.
      </p>

      {bonusesHelped.length ? (
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle>This trip can earn sign-up bonuses</CardTitle>
            <CardDescription>Bookings below are routed to these cards first, because the welcome offer is worth more than any multiplier.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {bonusesHelped.map((b) => (
              <p key={b.accountId}>
                Put {formatMoney(b.planned)} of bookings on <strong>{b.card}</strong>{" "}
                {b.metWithPlan ? <>to finish its minimum spend by {b.deadline} and earn about <strong>{formatMoney(b.bonusValue)}</strong>.</> : <>toward its minimum ({formatMoney(b.remaining)} to go by {b.deadline}).</>}
              </p>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Book each step with</CardTitle>
          {unpaid.length ? <CardDescription>Following this earns about {formatMoney(extra / 100, { cents: true })} more than the worst card choice, before bonuses.</CardDescription> : null}
        </CardHeader>
        <CardContent>
          {unpaid.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No unpaid steps with a cost. Add costs on the <Link className="underline" href={`/trips/${slug}/itinerary`}>itinerary</Link> to get card advice.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr><th className="py-1">Step</th><th className="text-right">Cost</th><th className="pl-3">Charge</th><th className="pl-3">Use</th><th className="text-right">Earns</th><th className="pl-3">Why</th></tr>
              </thead>
              <tbody>
                {unpaid.map((s) => {
                  const p = s.plan!;
                  return (
                    <tr key={s.id} className="border-t align-top">
                      <td className="py-1.5">{ITINERARY_ICONS[s.kind]} {s.title}{s.provider ? <span className="text-muted-foreground"> · {s.provider}</span> : null}</td>
                      <td className="text-right tabular-nums">{formatMoney(s.cost)}</td>
                      <td className="pl-3 text-muted-foreground">{s.chargeDate}</td>
                      <td className="pl-3"><strong>{p.recommended.card}</strong></td>
                      <td className="text-right tabular-nums">{formatMoney(p.recommended.cents / 100, { cents: true })}</td>
                      <td className="pl-3 text-muted-foreground">
                        {p.reason === "bonus" ? (
                          <><Badge variant="default">sign-up bonus</Badge> best multiplier would be {p.bestMultiplier.card} ({formatMoney(p.bestMultiplier.cents / 100, { cents: true })})</>
                        ) : (
                          <>best earn rate{p.options[1] ? `; next ${p.options[1].card} ${formatMoney(p.options[1].cents / 100, { cents: true })}` : ""}</>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {plan.bonuses.length ? (
        <Card>
          <CardHeader><CardTitle>Sign-up bonus progress</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {plan.bonuses.map((b) => (
              <div key={b.accountId} className="space-y-1">
                <div className="flex justify-between">
                  <span><strong>{b.card}</strong> · worth about {formatMoney(b.bonusValue)}</span>
                  <span className="text-muted-foreground">by {b.deadline} ({b.daysLeft} days)</span>
                </div>
                <div className="relative">
                  <Progress value={((b.spent + b.planned) / b.minSpend) * 100} indicatorClassName="bg-primary/40" />
                  <Progress value={(b.spent / b.minSpend) * 100} className="absolute inset-0 bg-transparent" />
                </div>
                <p className="text-xs text-muted-foreground">
                  Spent {formatMoney(b.spent)} of {formatMoney(b.minSpend)}
                  {b.planned > 0 ? `, plus ${formatMoney(b.planned)} planned from this trip` : ""}
                  {b.remaining > 0 && !b.metWithPlan ? `. ${formatMoney(Math.max(0, b.remaining - b.planned))} still needed.` : b.metWithPlan ? ". Minimum met with this plan." : ""}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {paid.length ? (
        <Card>
          <CardHeader><CardTitle>Already paid</CardTitle><CardDescription>These show up in finance once the card syncs, and count toward bonuses there.</CardDescription></CardHeader>
          <CardContent>
            <ul className="text-sm">{paid.map((s) => <li key={s.id}>{ITINERARY_ICONS[s.kind]} {s.title}: {formatMoney(s.cost)} on {s.paidWith}</li>)}</ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
