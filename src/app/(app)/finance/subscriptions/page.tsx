import Link from "next/link";
import { SubmitButton } from "@/components/submit-button";
import { Badge } from "@/components/ui/badge";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { householdToday } from "@/modules/family/ui/dates";
import {
  OWNER_LABELS,
  SUBSCRIPTION_CADENCES,
  listSubscriptions,
  viewerFromLabel,
  type Owner,
  type SubscriptionRow,
  type SubscriptionStatus,
} from "@/modules/finance/api";
import { addSubscriptionFormAction, deleteSubscriptionFormAction, saveSubscriptionFormAction } from "./actions";

const input = "min-h-10 rounded-lg border bg-transparent px-2";
const button = "min-h-9 rounded-lg border px-3 text-sm disabled:opacity-50";
const primary = "min-h-10 rounded-lg bg-foreground px-3 text-sm text-background disabled:opacity-50";
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shortDate = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${iso}T00:00:00Z`));
const CADENCE_LABEL = { weekly: "week", monthly: "month", quarterly: "quarter", yearly: "year" } as const;
const SCOPES = ["all", "joint", "mine"] as const;

function Hidden({ r, status }: { r: SubscriptionRow; status: SubscriptionStatus }) {
  return (
    <>
      <input type="hidden" name="id" value={r.id ?? ""} />
      <input type="hidden" name="merchantKey" value={r.merchantKey ?? ""} />
      <input type="hidden" name="name" value={r.name} />
      <input type="hidden" name="owner" value={r.owner} />
      <input type="hidden" name="amount" value={r.source === "detected" ? "" : (r.amount ?? "")} />
      <input type="hidden" name="cadence" value={r.cadence} />
      <input type="hidden" name="nextCharge" value={r.source === "manual" ? (r.nextCharge ?? "") : ""} />
      <input type="hidden" name="notes" value={r.notes ?? ""} />
      <input type="hidden" name="status" value={status} />
    </>
  );
}

function OwnerSelect({ owners, value }: { owners: Owner[]; value: Owner }) {
  return (
    <select name="owner" defaultValue={value} className={input}>
      {owners.map((o) => (
        <option key={o} value={o}>
          {OWNER_LABELS[o]}
        </option>
      ))}
    </select>
  );
}

/**
 * Running subscriptions: recurring charges found in the transactions you can
 * see (joint accounts and your own), plus ones added by hand. Confirm,
 * rename, mark cancelled or hide what isn't a subscription.
 */
export default async function SubscriptionsPage({ searchParams }: PageProps<"/finance/subscriptions">) {
  const user = await requireUserOrRedirect();
  const viewer = viewerFromLabel(user.owner);
  const sp = await searchParams;
  const message = typeof sp.m === "string" ? sp.m : null;
  const scope = SCOPES.find((s) => s === sp.o) ?? "all";
  const today = householdToday();
  const { rows, totals, hiddenCount } = await listSubscriptions(viewer, today);
  const owners: Owner[] = ["joint", viewer];
  const inScope = (r: SubscriptionRow) => scope === "all" || (scope === "joint" ? r.owner === "joint" : r.owner === viewer);
  const active = rows.filter((r) => r.status === "active" && inScope(r));
  const cancelled = rows.filter((r) => r.status === "cancelled" && inScope(r));
  const detectedCount = active.filter((r) => r.source === "detected").length;
  const increases = active.filter((r) => r.priceChange);
  const both = { monthly: totals.joint.monthly + totals[viewer].monthly, yearly: totals.joint.yearly + totals[viewer].yearly };

  return (
    <section className="max-w-5xl space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Subscriptions</h1>
        <p className="text-sm opacity-70">
          Charges that repeat at a steady price, found in the joint accounts and yours, plus any you add. Keep the ones that are real
          subscriptions, hide the rest (rent, loan payments, bills), and mark one cancelled when you stop it. Only you and{" "}
          {OWNER_LABELS[viewer === "user1" ? "user2" : "user1"]} see Joint ones; your own are private to you.
        </p>
      </div>

      {message && (
        <p role="status" className="rounded-lg border border-foreground/30 bg-muted px-4 py-2 text-sm">
          {message}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { label: "Joint", t: totals.joint },
          { label: OWNER_LABELS[viewer], t: totals[viewer] },
          { label: "Joint + yours", t: { ...both, count: totals.joint.count + totals[viewer].count } },
        ].map(({ label, t }) => (
          <div key={label} className="rounded-lg border p-3">
            <p className="text-sm opacity-70">
              {label} ({t.count})
            </p>
            <p className="text-xl font-semibold">{money(t.monthly)}/mo</p>
            <p className="text-sm opacity-70">{money(t.yearly)} a year</p>
          </div>
        ))}
      </div>

      {increases.length > 0 && (
        <div className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm">
          <p className="font-medium">Price went up</p>
          <ul>
            {increases.map((r) => (
              <li key={`${r.owner}|${r.merchantKey ?? r.id}`}>
                {r.name}: {money(r.priceChange!.from)} → {money(r.priceChange!.to)} on {shortDate(r.priceChange!.on)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <nav className="flex gap-3 text-sm">
        {SCOPES.map((s) => (
          <Link key={s} href={s === "all" ? "/finance/subscriptions" : `/finance/subscriptions?o=${s}`} className={s === scope ? "font-semibold underline" : "underline opacity-70"}>
            {s === "all" ? "All" : s === "joint" ? "Joint" : OWNER_LABELS[viewer]}
          </Link>
        ))}
      </nav>

      <div id="list" className="space-y-2">
        <h2 className="text-lg font-semibold">Running ({active.length})</h2>
        {detectedCount > 0 && <p className="text-sm opacity-70">{detectedCount} found automatically and not confirmed yet: keep or hide them.</p>}
        {active.length === 0 && <p className="text-sm opacity-70">No recurring charges found yet. They show up after two or three charges; add one by hand below.</p>}
        <ul className="divide-y rounded-lg border">
          {active.map((r) => (
            <li key={`${r.owner}|${r.merchantKey ?? r.id}`} className="space-y-2 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <p className="font-medium">
                    {r.name}{" "}
                    <Badge variant="outline">{OWNER_LABELS[r.owner]}</Badge>{" "}
                    {r.source === "detected" && <Badge variant="secondary">Found</Badge>}
                    {r.noRecentCharge && <Badge variant="outline">No recent charge</Badge>}
                  </p>
                  <p className="text-sm opacity-70">
                    {r.amount != null ? `${money(r.amount)} a ${CADENCE_LABEL[r.cadence]}` : `Amount unknown, ${r.cadence}`}
                    {r.lastCharge && ` · last ${shortDate(r.lastCharge)}`}
                    {r.nextCharge && ` · next about ${shortDate(r.nextCharge)}`}
                    {r.chargeCount > 0 && ` · ${r.chargeCount} charges seen`}
                  </p>
                  {r.notes && <p className="text-sm opacity-70">{r.notes}</p>}
                </div>
                <div className="text-right">
                  <p className="font-semibold">{money(r.monthly)}/mo</p>
                  <p className="text-xs opacity-70">{money(r.yearly)}/yr</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {r.source === "detected" && (
                  <form action={saveSubscriptionFormAction}>
                    <Hidden r={r} status="active" />
                    <SubmitButton className={button}>Keep</SubmitButton>
                  </form>
                )}
                {r.merchantKey && (
                  <form action={saveSubscriptionFormAction}>
                    <Hidden r={r} status="ignored" />
                    <SubmitButton className={button}>Not a subscription</SubmitButton>
                  </form>
                )}
                <form action={saveSubscriptionFormAction}>
                  <Hidden r={r} status="cancelled" />
                  <SubmitButton className={button}>Cancelled</SubmitButton>
                </form>
              </div>
              <details>
                <summary className="cursor-pointer text-sm opacity-70">Edit</summary>
                <form action={saveSubscriptionFormAction} className="mt-2 grid gap-2 sm:grid-cols-3">
                  <input type="hidden" name="id" value={r.id ?? ""} />
                  <input type="hidden" name="merchantKey" value={r.merchantKey ?? ""} />
                  <input type="hidden" name="status" value="active" />
                  <label className="grid gap-1 text-sm">
                    Name
                    <input name="name" required maxLength={80} defaultValue={r.name} className={input} />
                  </label>
                  {r.merchantKey ? (
                    <input type="hidden" name="owner" value={r.owner} />
                  ) : (
                    <label className="grid gap-1 text-sm">
                      Whose
                      <OwnerSelect owners={owners} value={r.owner} />
                    </label>
                  )}
                  <label className="grid gap-1 text-sm">
                    Price ({r.merchantKey ? "blank = follow the charges" : "per charge"})
                    <input name="amount" type="number" min={0} step="0.01" defaultValue={r.source === "detected" ? "" : (r.amount ?? "")} className={input} />
                  </label>
                  <label className="grid gap-1 text-sm">
                    Every
                    <select name="cadence" defaultValue={r.cadence} className={input}>
                      {SUBSCRIPTION_CADENCES.map((c) => (
                        <option key={c} value={c}>
                          {CADENCE_LABEL[c]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-sm">
                    Next charge
                    <input name="nextCharge" type="date" defaultValue={r.source === "manual" ? (r.nextCharge ?? "") : ""} className={input} />
                  </label>
                  <label className="grid gap-1 text-sm sm:col-span-3">
                    Notes (who uses it, how to cancel)
                    <input name="notes" maxLength={500} defaultValue={r.notes ?? ""} className={input} />
                  </label>
                  <div className="sm:col-span-3">
                    <SubmitButton className={primary} pending="Saving…">
                      Save
                    </SubmitButton>
                  </div>
                </form>
                {r.id && (
                  <form action={deleteSubscriptionFormAction} className="mt-2">
                    <input type="hidden" name="id" value={r.id} />
                    <SubmitButton className={button}>{r.merchantKey ? "Forget my edits" : "Delete"}</SubmitButton>
                  </form>
                )}
              </details>
            </li>
          ))}
        </ul>
        {hiddenCount > 0 && <p className="text-xs opacity-60">{hiddenCount} recurring charges hidden as not subscriptions.</p>}
      </div>

      {cancelled.length > 0 && (
        <details className="space-y-2">
          <summary className="cursor-pointer text-lg font-semibold">Cancelled ({cancelled.length})</summary>
          <ul className="divide-y rounded-lg border">
            {cancelled.map((r) => (
              <li key={r.id ?? r.merchantKey} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <span>
                  {r.name} <Badge variant="outline">{OWNER_LABELS[r.owner]}</Badge>
                  {r.lastCharge && <span className="opacity-70"> · last charged {shortDate(r.lastCharge)}</span>}
                  {r.stillCharging && <span className="text-destructive"> · charged again after you cancelled</span>}
                </span>
                <form action={saveSubscriptionFormAction}>
                  <Hidden r={r} status="active" />
                  <SubmitButton className={button}>Running again</SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div id="add" className="space-y-2">
        <h2 className="text-lg font-semibold">Add one by hand</h2>
        <p className="text-sm opacity-70">For a subscription paid from an account the app doesn&apos;t sync, or one that hasn&apos;t charged yet.</p>
        <form action={addSubscriptionFormAction} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-3">
          <label className="grid gap-1 text-sm">
            Name
            <input name="name" required maxLength={80} placeholder="Netflix" className={input} />
          </label>
          <label className="grid gap-1 text-sm">
            Whose
            <OwnerSelect owners={owners} value="joint" />
          </label>
          <label className="grid gap-1 text-sm">
            Price per charge ($)
            <input name="amount" type="number" min={0} step="0.01" className={input} />
          </label>
          <label className="grid gap-1 text-sm">
            Every
            <select name="cadence" defaultValue="monthly" className={input}>
              {SUBSCRIPTION_CADENCES.map((c) => (
                <option key={c} value={c}>
                  {CADENCE_LABEL[c]}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Next charge
            <input name="nextCharge" type="date" className={input} />
          </label>
          <label className="grid gap-1 text-sm">
            Notes
            <input name="notes" maxLength={500} className={input} />
          </label>
          <div className="sm:col-span-3">
            <SubmitButton className={primary} pending="Adding…">
              Add subscription
            </SubmitButton>
          </div>
        </form>
      </div>
    </section>
  );
}
