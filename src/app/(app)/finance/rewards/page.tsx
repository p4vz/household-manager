import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/utils";
import { OWNER_LABELS, latestAdvisorReport, listCardsWithProfiles, rewardsAudit } from "@/modules/finance/api";
import { AdvisorButton } from "@/modules/finance/ui/advisor-button";
import { addCardRuleAction, deleteCardRuleAction, runAdvisorAction, saveCardProfileAction } from "../actions";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const input = "h-8 rounded-md border bg-background px-2";

export default async function RewardsPage() {
  const [cards, { audit }, advisor] = await Promise.all([listCardsWithProfiles(), rewardsAudit("12M"), latestAdvisorReport()]);

  return (
    <section className="max-w-5xl space-y-8">
      <h1 className="text-2xl font-semibold">Card rewards</h1>

      {audit ? (
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader>
              <CardDescription>Points left on the table · last 12 months</CardDescription>
              <CardTitle className="text-3xl text-destructive">{formatMoney(audit.totalMissed)}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">Earned {formatMoney(audit.totalEarned)} in rewards value.</CardContent>
          </Card>
          <Card className="md:col-span-2">
            <CardHeader><CardTitle>Use the right card</CardTitle></CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm">
                {audit.byCategory.slice(0, 6).map((c) => (
                  <li key={c.category} className="flex justify-between">
                    <span>{c.category}: use <strong>{c.useCard}</strong></span>
                    <span className="tabular-nums text-destructive">{formatMoney(c.missed, { cents: true })} missed</span>
                  </li>
                ))}
                {audit.byCategory.length === 0 ? <li className="text-muted-foreground">Every purchase went on the best card.</li> : null}
              </ul>
            </CardContent>
          </Card>
          <Card className="md:col-span-3">
            <CardHeader><CardTitle>Card performance</CardTitle></CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr><th className="py-1">Card</th><th className="text-right">Spend</th><th className="text-right">Rewards</th><th className="text-right">Fee</th><th className="text-right">Net</th></tr>
                </thead>
                <tbody>
                  {audit.perCard.map((c) => (
                    <tr key={c.card} className="border-t">
                      <td className="py-1.5">{c.card}</td>
                      <td className="text-right tabular-nums">{formatMoney(c.spend)}</td>
                      <td className="text-right tabular-nums">{formatMoney(c.earned)}</td>
                      <td className="text-right tabular-nums">{formatMoney(c.annualFee)}</td>
                      <td className={`text-right tabular-nums ${c.net < 0 ? "text-destructive" : ""}`}>{formatMoney(c.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {audit.topMisses.length ? (
                <details className="mt-4 text-sm">
                  <summary className="cursor-pointer text-muted-foreground">Biggest misses</summary>
                  <table className="mt-2 w-full">
                    <tbody>
                      {audit.topMisses.map((m) => (
                        <tr key={m.txnId} className="border-t">
                          <td className="py-1 text-muted-foreground">{m.date}</td>
                          <td>{m.merchant}</td>
                          <td className="text-right tabular-nums">{formatMoney(m.amount, { cents: true })}</td>
                          <td className="pl-3">{m.actualCard} → <strong>{m.bestCard}</strong></td>
                          <td className="text-right tabular-nums text-destructive">{formatMoney(m.missedCents / 100, { cents: true })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              ) : null}
            </CardContent>
          </Card>
        </div>
      ) : (
        <p className="text-muted-foreground">Set up a reward profile for at least one card below to see the audit.</p>
      )}

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>AI card advisor</CardTitle>
            <CardDescription>
              Runs on the 1st of each month or on demand. Sees only per-card and per-category totals, never transactions or account numbers.
              {advisor ? ` Last run ${advisor.createdAt.toLocaleString()} with ${advisor.provider === "gemini" ? "Gemini" : "Claude"}.` : ""}
            </CardDescription>
          </div>
          <AdvisorButton action={runAdvisorAction} />
        </CardHeader>
        {advisor ? (
          <CardContent className="space-y-4 text-sm">
            <p>{advisor.report.summary}</p>
            {advisor.report.underperformingCards.length ? (
              <div>
                <h3 className="font-medium">Underperforming cards</h3>
                <ul className="list-disc pl-5">
                  {advisor.report.underperformingCards.map((c, i) => <li key={i}><strong>{c.cardName}</strong>: {c.finding} {c.suggestion}</li>)}
                </ul>
              </div>
            ) : null}
            {advisor.report.billIncreases.length ? (
              <div>
                <h3 className="font-medium">Recurring bills that went up</h3>
                <ul className="list-disc pl-5">
                  {advisor.report.billIncreases.map((b, i) => (
                    <li key={i}><strong>{b.merchant}</strong>: {formatMoney(b.previousMonthly, { cents: true })} → {formatMoney(b.latestMonthly, { cents: true })}. {b.note}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {advisor.report.signupBonusIdeas.length ? (
              <div>
                <h3 className="font-medium">Sign-up bonus ideas <span className="font-normal text-muted-foreground">(verify current offers before applying)</span></h3>
                <ul className="list-disc pl-5">
                  {advisor.report.signupBonusIdeas.map((s, i) => <li key={i}><strong>{s.idea}</strong>: {s.rationale}</li>)}
                </ul>
              </div>
            ) : null}
          </CardContent>
        ) : null}
      </Card>

      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Reward profiles</h2>
        {cards.length === 0 ? <p className="text-muted-foreground">No active credit cards. Mark cards as type “credit” on the Accounts page.</p> : null}
        {cards.map((c) => (
          <Card key={c.accountId}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {c.name} <Badge variant="outline">{OWNER_LABELS[c.owner]}</Badge>
                {!c.profile ? <Badge variant="warning">Not set up</Badge> : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <form action={saveCardProfileAction} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="accountId" value={c.accountId} />
                <label className="flex flex-col">Type
                  <select name="rewardType" defaultValue={c.profile?.rewardType ?? "points"} className={input}>
                    <option value="points">Points / miles</option>
                    <option value="cashback">Cash back (%)</option>
                  </select>
                </label>
                <label className="flex flex-col">Base rate (x or %)
                  <input name="baseRate" type="number" step="0.01" min="0" defaultValue={c.profile?.baseRate ?? 1} className={`${input} w-28`} />
                </label>
                <label className="flex flex-col">Value per point (¢)
                  <input name="centsPerUnit" type="number" step="0.01" min="0" defaultValue={c.profile?.centsPerUnit ?? 1} className={`${input} w-28`} />
                </label>
                <label className="flex flex-col">Annual fee ($)
                  <input name="annualFee" type="number" step="1" min="0" defaultValue={c.profile?.annualFee ?? 0} className={`${input} w-28`} />
                </label>
                <label className="flex flex-col">Fee posts in
                  <select name="annualFeeMonth" defaultValue={c.profile?.annualFeeMonth ?? ""} className={input}>
                    <option value="">n/a</option>
                    {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                  </select>
                </label>
                <Button size="sm" variant="outline">Save</Button>
              </form>
              <p className="text-xs text-muted-foreground">For cash back, set value per point to 1 (a 2% card is base rate 2). Fee month adds a reminder to the calendar.</p>

              {c.rules.length ? (
                <ul className="space-y-1">
                  {c.rules.map((r) => (
                    <li key={r.id} className="flex items-center gap-2">
                      <Badge variant="secondary">{r.rate}{c.profile?.rewardType === "cashback" ? "%" : "x"}</Badge>
                      <span>{r.label ? `${r.label}: ` : ""}{r.matchType} “{r.match}”</span>
                      {r.capAmount ? <span className="text-muted-foreground">up to {formatMoney(r.capAmount)}/{r.capPeriod}</span> : null}
                      {r.validFrom || r.validTo ? <span className="text-muted-foreground">{r.validFrom ?? "…"} to {r.validTo ?? "…"}</span> : null}
                      <form action={deleteCardRuleAction} className="ml-auto">
                        <input type="hidden" name="id" value={r.id} />
                        <Button size="sm" variant="ghost">Remove</Button>
                      </form>
                    </li>
                  ))}
                </ul>
              ) : null}

              {c.profile ? (
                <form action={addCardRuleAction} className="flex flex-wrap items-end gap-2 rounded-md bg-muted/50 p-3">
                  <input type="hidden" name="accountId" value={c.accountId} />
                  <label className="flex flex-col">Bonus on
                    <select name="matchType" className={input}>
                      <option value="category">Category</option>
                      <option value="subcategory">Subcategory</option>
                      <option value="merchant">Merchant contains</option>
                    </select>
                  </label>
                  <label className="flex flex-col">Match
                    <input name="match" required placeholder="e.g. Food & Dining" className={`${input} w-40`} />
                  </label>
                  <label className="flex flex-col">Rate
                    <input name="rate" type="number" step="0.01" min="0" required className={`${input} w-20`} />
                  </label>
                  <label className="flex flex-col">Cap ($)
                    <input name="capAmount" type="number" step="1" min="0" className={`${input} w-24`} />
                  </label>
                  <label className="flex flex-col">per
                    <select name="capPeriod" className={input}>
                      <option value="quarter">quarter</option>
                      <option value="year">year</option>
                      <option value="month">month</option>
                    </select>
                  </label>
                  <label className="flex flex-col">From
                    <input name="validFrom" type="date" className={input} />
                  </label>
                  <label className="flex flex-col">To
                    <input name="validTo" type="date" className={input} />
                  </label>
                  <label className="flex flex-col">Label
                    <input name="label" placeholder="Q1 rotating" className={`${input} w-28`} />
                  </label>
                  <Button size="sm" variant="outline">Add bonus</Button>
                </form>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
