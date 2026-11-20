import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/utils";
import Link from "next/link";
import {
  OWNER_LABELS,
  cardCatalog,
  catalogComparison,
  catalogDriftForCards,
  latestAdvisorReport,
  listCardsWithProfiles,
  listCatalogChanges,
  rewardsAudit,
  signupBonusOverview,
} from "@/modules/finance/api";
import { AdvisorButton } from "@/modules/finance/ui/advisor-button";
import { changeLines, daysAgo } from "@/modules/finance/ui/catalog-format";
import {
  addCardRuleAction,
  applyCatalogTermsAction,
  deleteCardRuleAction,
  keepCardRulesAction,
  linkCardToCatalogAction,
  runAdvisorAction,
  saveCardProfileAction,
} from "../actions";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const input = "h-8 rounded-md border bg-background px-2";

export default async function RewardsPage() {
  const [cards, { audit }, advisor, catalog, drift, candidates, changes, bonuses] = await Promise.all([
    listCardsWithProfiles(),
    rewardsAudit("12M"),
    latestAdvisorReport(),
    cardCatalog(),
    catalogDriftForCards(),
    catalogComparison("12M"),
    listCatalogChanges({ limit: 40 }),
    signupBonusOverview(),
  ]);
  const driftByCard = new Map(drift.map((d) => [d.accountId, d]));
  const toReview = changes.filter((c) => c.status === "pending" || !c.seen).length;

  return (
    <section className="max-w-5xl space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Card rewards</h1>
        <Link href="/finance/rewards/catalog" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          Card catalog ({catalog.length} cards){toReview ? <Badge variant="warning">{toReview} to review</Badge> : null}
        </Link>
      </div>

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

      {candidates.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Cards worth considering</CardTitle>
            <CardDescription>
              Each catalog card you don&apos;t hold, priced against your last 12 months of card spending: what it would add on top of your
              current cards (always using the best card per purchase), minus its fee. Credits are listed at face value and not counted.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr><th className="py-1">Card</th><th className="text-right">Fee</th><th className="text-right">Adds / yr</th><th className="text-right">Net / yr</th><th className="pl-4">Sign-up offer</th><th className="text-right">Verified</th></tr>
              </thead>
              <tbody>
                {candidates.slice(0, 8).map((c) => (
                  <tr key={c.id} className="border-t">
                    <td className="py-1.5">{c.card}</td>
                    <td className="text-right tabular-nums">{formatMoney(c.annualFee)}</td>
                    <td className="text-right tabular-nums">{formatMoney(c.addedRewards)}</td>
                    <td className={`text-right tabular-nums ${c.netPerYear < 0 ? "text-destructive" : ""}`}>{formatMoney(c.netPerYear)}</td>
                    <td className="pl-4">
                      {c.signupOffer ? (
                        <>~{formatMoney(c.signupValue)} after {formatMoney(c.signupOffer.minSpend)} in {c.signupOffer.windowMonths} mo{c.signupOffer.endDate ? ` (ends ${c.signupOffer.endDate})` : ""}</>
                      ) : (
                        <span className="text-muted-foreground">none on file</span>
                      )}
                    </td>
                    <td className="text-right text-muted-foreground">{c.verifiedAt ?? "not yet"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ) : null}

      {bonuses.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Sign-up bonuses in progress</CardTitle>
            <CardDescription>Spend on the card since the offer started, net of refunds. Trip pages suggest bookings that would close the gap.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {bonuses.map((b) => (
              <div key={b.accountId} className="space-y-1">
                <div className="flex justify-between">
                  <span><strong>{b.card}</strong>: worth about {formatMoney(b.bonusValue)}</span>
                  <span className={b.remaining > 0 && b.daysLeft < 30 ? "text-destructive" : "text-muted-foreground"}>
                    {b.remaining > 0 ? `${formatMoney(b.remaining)} to go, ${b.daysLeft} days left (by ${b.deadline})` : "Minimum spend met"}
                  </span>
                </div>
                <Progress value={Math.min(100, (b.spent / b.minSpend) * 100)} />
                <p className="text-xs text-muted-foreground">{formatMoney(b.spent)} of {formatMoney(b.minSpend)}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

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
              <form action={linkCardToCatalogAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="accountId" value={c.accountId} />
                <label className="flex flex-col">Catalog card
                  <select name="productId" defaultValue={c.profile?.catalogProductId ?? ""} className={input}>
                    <option value="">Not linked</option>
                    {catalog.map((p) => <option key={p.id} value={p.id}>{p.issuer} {p.name}</option>)}
                  </select>
                </label>
                <Button size="sm" variant="outline">Link</Button>
                {(() => {
                  const p = catalog.find((x) => x.id === c.profile?.catalogProductId);
                  return p ? (
                    <span className="text-xs text-muted-foreground">
                      {p.status === "verified" ? `Terms verified ${daysAgo(p.verifiedAt)}` : "Terms not yet verified"}
                      {p.terms?.rotating ? " · rotating categories are added to the audit automatically" : ""}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">Link it to fill in fee and bonus categories and keep them current.</span>
                  );
                })()}
              </form>
              {driftByCard.has(c.accountId) ? (
                <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3">
                  <p className="font-medium">
                    {driftByCard.get(c.accountId)!.appliedVersion == null
                      ? `Use the catalog terms for ${driftByCard.get(c.accountId)!.productName}?`
                      : `${driftByCard.get(c.accountId)!.productName} terms changed`}
                  </p>
                  {driftByCard.get(c.accountId)!.appliedVersion != null ? (
                    <ul className="list-disc pl-5">{changeLines(driftByCard.get(c.accountId)!.changes).map((l, i) => <li key={i}>{l}</li>)}</ul>
                  ) : null}
                  <p className="text-xs text-muted-foreground">Applying sets the fee, base rate and catalog bonus rules. Rules you added yourself are kept.</p>
                  <div className="flex gap-2">
                    <form action={applyCatalogTermsAction}><input type="hidden" name="accountId" value={c.accountId} /><Button size="sm">Apply to this card</Button></form>
                    <form action={keepCardRulesAction}><input type="hidden" name="accountId" value={c.accountId} /><Button size="sm" variant="ghost">Keep mine</Button></form>
                  </div>
                </div>
              ) : null}
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
                <fieldset className="flex basis-full flex-wrap items-end gap-3">
                  <legend className="mb-1 text-xs text-muted-foreground">Sign-up bonus (leave blank if none)</legend>
                  <label className="flex flex-col">Bonus ({c.profile?.rewardType === "cashback" ? "$" : "points"})
                    <input name="signupBonus" type="number" step="1" min="0" defaultValue={c.profile?.signupBonus ?? ""} className={`${input} w-28`} />
                  </label>
                  <label className="flex flex-col">Minimum spend ($)
                    <input name="signupMinSpend" type="number" step="1" min="0" defaultValue={c.profile?.signupMinSpend ?? ""} className={`${input} w-28`} />
                  </label>
                  <label className="flex flex-col">Opened
                    <input name="signupStart" type="date" defaultValue={c.profile?.signupStart ?? ""} className={input} />
                  </label>
                  <label className="flex flex-col">Spend by
                    <input name="signupDeadline" type="date" defaultValue={c.profile?.signupDeadline ?? ""} className={input} />
                  </label>
                  <Button size="sm" variant="outline">Save</Button>
                </fieldset>
              </form>
              <p className="text-xs text-muted-foreground">For cash back, set value per point to 1 (a 2% card is base rate 2). Fee month adds a reminder to the calendar.</p>

              {c.rules.length ? (
                <ul className="space-y-1">
                  {c.rules.map((r) => (
                    <li key={r.id} className="flex items-center gap-2">
                      <Badge variant="secondary">{r.rate}{c.profile?.rewardType === "cashback" ? "%" : "x"}</Badge>
                      {r.source === "catalog" ? <Badge variant="outline">catalog</Badge> : null}
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
