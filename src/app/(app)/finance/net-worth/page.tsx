import Link from "next/link";
import { SubmitButton } from "@/components/submit-button";
import { Badge } from "@/components/ui/badge";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { householdToday } from "@/modules/family/ui/dates";
import {
  LIABILITY_KINDS,
  NET_WORTH_GROUP_LABELS,
  NET_WORTH_ITEM_KINDS,
  NET_WORTH_KIND_LABELS,
  OWNER_LABELS,
  listNetWorthItems,
  netWorth,
  viewerFromLabel,
  type NetWorthScope,
  type Owner,
} from "@/modules/finance/api";
import { NetWorthChart } from "@/modules/finance/ui/net-worth-chart";
import { addItemFormAction, deleteItemFormAction, setValueFormAction, updateItemFormAction } from "./actions";

const input = "min-h-10 rounded-lg border bg-transparent px-2";
const button = "min-h-9 rounded-lg border px-3 text-sm disabled:opacity-50";
const primary = "min-h-10 rounded-lg bg-foreground px-3 text-sm text-background disabled:opacity-50";
const money = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const shortDate = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${iso}T00:00:00Z`));
const SCOPES: NetWorthScope[] = ["joint", "mine", "both"];

type Item = Awaited<ReturnType<typeof listNetWorthItems>>[number];

function ItemFields({ i, owners }: { i?: Item; owners: Owner[] }) {
  return (
    <>
      <label className="grid gap-1 text-sm">
        Name
        <input name="name" required maxLength={80} defaultValue={i?.name} placeholder="House" className={input} />
      </label>
      <label className="grid gap-1 text-sm">
        Kind
        <select name="kind" defaultValue={i?.kind ?? "home"} className={input}>
          {NET_WORTH_ITEM_KINDS.map((k) => (
            <option key={k} value={k}>
              {NET_WORTH_KIND_LABELS[k]}
              {LIABILITY_KINDS.includes(k) ? " (owed)" : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        Whose
        <select name="owner" defaultValue={i?.owner ?? "joint"} className={input}>
          {owners.map((o) => (
            <option key={o} value={o}>
              {OWNER_LABELS[o]}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        Bought or taken out on
        <input name="acquiredOn" type="date" defaultValue={i?.acquiredOn ?? ""} className={input} />
      </label>
      <label className="grid gap-1 text-sm">
        Sold or paid off on
        <input name="closedOn" type="date" defaultValue={i?.closedOn ?? ""} className={input} />
      </label>
      <label className="grid gap-1 text-sm">
        Notes (how the value was estimated)
        <input name="notes" maxLength={500} defaultValue={i?.notes ?? ""} className={input} />
      </label>
    </>
  );
}

/**
 * Net worth: account balances plus the house, cars and loans entered by hand.
 * Joint, yours, or both together; never the other member's own. History is
 * month-end values, rebuilt from balances and transactions. No forecasting.
 */
export default async function NetWorthPage({ searchParams }: PageProps<"/finance/net-worth">) {
  const user = await requireUserOrRedirect();
  const viewer = viewerFromLabel(user.owner);
  const sp = await searchParams;
  const message = typeof sp.m === "string" ? sp.m : null;
  const scope = SCOPES.find((s) => s === sp.s) ?? "joint";
  const today = householdToday();
  const [nw, items] = await Promise.all([netWorth(viewer, scope, today), listNetWorthItems(viewer)]);
  const owners: Owner[] = ["joint", viewer];
  const scopeLabel = (s: NetWorthScope) => (s === "joint" ? "Joint" : s === "mine" ? OWNER_LABELS[viewer] : `Joint + ${OWNER_LABELS[viewer]}`);
  const first = nw.history[0];

  return (
    <section className="max-w-5xl space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Net worth</h1>
        <p className="text-sm opacity-70">
          Synced account balances (cards and loans count as owed) plus what you add by hand below. You see the joint net worth and your own;{" "}
          {OWNER_LABELS[viewer === "user1" ? "user2" : "user1"]}&apos;s own stays private to them.
        </p>
        <nav className="flex gap-3 text-sm">
          {SCOPES.map((s) => (
            <Link key={s} href={`/finance/net-worth?s=${s}`} className={s === scope ? "font-semibold underline" : "underline opacity-70"}>
              {scopeLabel(s)}
            </Link>
          ))}
        </nav>
      </div>

      {message && (
        <p role="status" className="rounded-lg border border-foreground/30 bg-muted px-4 py-2 text-sm">
          {message}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border p-3">
          <p className="text-sm opacity-70">{scopeLabel(scope)} net worth</p>
          <p className="text-2xl font-semibold">{money(nw.total)}</p>
          {first && first.date !== today && (
            <p className="text-xs opacity-70">
              {nw.total - first.total >= 0 ? "Up" : "Down"} {money(Math.abs(nw.total - first.total))} since {shortDate(first.date)}
            </p>
          )}
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-sm opacity-70">Assets</p>
          <p className="text-xl font-semibold">{money(nw.assets)}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-sm opacity-70">Owed</p>
          <p className="text-xl font-semibold">{money(nw.liabilities)}</p>
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Over time</h2>
        <NetWorthChart history={nw.history} />
        <p className="text-xs opacity-60">
          Month-end values. Past balances are worked back from transactions until daily balance snapshots exist, so investment
          accounts show deposits but not market moves before the snapshots began.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">By type</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {nw.groups.map((g) => (
              <li key={g.group} className="flex justify-between p-2">
                <span>{NET_WORTH_GROUP_LABELS[g.group]}</span>
                <span className={g.total < 0 ? "text-destructive" : ""}>{money(g.total)}</span>
              </li>
            ))}
            {nw.groups.length === 0 && <li className="p-2 opacity-70">Nothing yet.</li>}
          </ul>
        </div>
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Everything counted</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {nw.lines.map((l) => (
              <li key={l.key} className="flex justify-between gap-2 p-2">
                <span>
                  {l.name} {scope === "both" && <Badge variant="outline">{OWNER_LABELS[l.owner]}</Badge>}
                  {l.asOf && <span className="text-xs opacity-60"> · {shortDate(l.asOf)}</span>}
                </span>
                <span className={l.value < 0 ? "text-destructive" : ""}>{money(l.value)}</span>
              </li>
            ))}
          </ul>
          {nw.missingBalances.length > 0 && (
            <p className="text-xs opacity-60">
              Not counted (no balance, CSV history only): {nw.missingBalances.join(", ")}. Add them to bank sync, or enter them by hand below.
            </p>
          )}
        </div>
      </div>

      <div id="items" className="space-y-3">
        <h2 className="text-lg font-semibold">Added by hand</h2>
        <p className="text-sm opacity-70">
          The house, cars, a mortgage or loan the bank sync doesn&apos;t see. Update a value now and then; each update is kept for the history.
        </p>
        <ul className="space-y-2">
          {items.map((i) => (
            <li key={i.id} className="space-y-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium">
                  {i.name} <Badge variant="outline">{OWNER_LABELS[i.owner]}</Badge>{" "}
                  <span className="text-sm font-normal opacity-70">{NET_WORTH_KIND_LABELS[i.kind]}</span>
                  {i.closedOn && <span className="text-sm font-normal opacity-70"> · closed {shortDate(i.closedOn)}</span>}
                </p>
                <p className={LIABILITY_KINDS.includes(i.kind) ? "text-destructive" : ""}>
                  {i.value != null ? money(LIABILITY_KINDS.includes(i.kind) ? -i.value : i.value) : "No value"}
                  {i.asOf && <span className="text-xs opacity-60"> · {shortDate(i.asOf)}</span>}
                </p>
              </div>
              <form action={setValueFormAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="id" value={i.id} />
                <label className="grid gap-1 text-sm">
                  New value ($)
                  <input name="value" type="number" min={0} step="1" required className={input} />
                </label>
                <label className="grid gap-1 text-sm">
                  As of
                  <input name="asOf" type="date" defaultValue={today} className={input} />
                </label>
                <SubmitButton className={button}>Update value</SubmitButton>
              </form>
              <details>
                <summary className="cursor-pointer text-sm opacity-70">Edit or see past values ({i.history.length})</summary>
                <ul className="mt-2 text-sm opacity-80">
                  {i.history.map((h) => (
                    <li key={h.asOf}>
                      {shortDate(h.asOf)}: {money(h.value)}
                    </li>
                  ))}
                </ul>
                <form action={updateItemFormAction} className="mt-2 grid gap-2 sm:grid-cols-3">
                  <input type="hidden" name="id" value={i.id} />
                  <ItemFields i={i} owners={owners} />
                  <div className="sm:col-span-3">
                    <SubmitButton className={primary} pending="Saving…">
                      Save
                    </SubmitButton>
                  </div>
                </form>
                <form action={deleteItemFormAction} className="mt-2">
                  <input type="hidden" name="id" value={i.id} />
                  <SubmitButton className={button}>Delete</SubmitButton>
                </form>
              </details>
            </li>
          ))}
        </ul>
        <form action={addItemFormAction} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-3">
          <ItemFields owners={owners} />
          <label className="grid gap-1 text-sm">
            Value or amount owed ($)
            <input name="value" type="number" min={0} step="1" required className={input} />
          </label>
          <label className="grid gap-1 text-sm">
            As of
            <input name="asOf" type="date" defaultValue={today} className={input} />
          </label>
          <div className="sm:col-span-3">
            <SubmitButton className={primary} pending="Adding…">
              Add
            </SubmitButton>
          </div>
        </form>
      </div>
    </section>
  );
}
