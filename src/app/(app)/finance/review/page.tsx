import Link from "next/link";
import { SubmitButton } from "@/components/submit-button";
import { Badge } from "@/components/ui/badge";
import { aiConfigured } from "@/core/ai/keys";
import { requireUserOrRedirect } from "@/core/auth/guard";
import {
  ACCOUNT_KINDS,
  ACCOUNT_KIND_LABELS,
  OWNER_LABELS,
  allChoices,
  categoryReview,
  formatPair,
  largePurchases,
  largeThreshold,
  listReviewActions,
  reconcileReport,
  viewerFromLabel,
} from "@/modules/finance/api";
import { ASSET_KIND_LABELS, listAssets, listOpenTasks } from "@/modules/maintenance/api";
import {
  answerPurchaseAction,
  applyCategoriesAction,
  categorizeUncategorizedAction,
  deactivateAccountAction,
  mergeAccountAction,
  proposeCategoriesAction,
  removeDuplicatesAction,
  renameAccountAction,
  reopenPurchaseAction,
  setThresholdAction,
  skipMerchantAction,
  skipPurchaseAction,
  undoReviewChangeAction,
} from "./actions";

const input = "rounded border bg-transparent px-2 py-1";
const button = "rounded border px-3 py-1 text-sm hover:bg-muted disabled:opacity-50";
const primary = "rounded bg-foreground px-3 py-1 text-sm text-background disabled:opacity-50";
const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * One-time Finance review: reconcile imports with the bank feed, settle on
 * one category set, explain large purchases, and seed house upkeep from the
 * answers. Runs as the signed-in member: only joint accounts and their own.
 */
export default async function FinanceReviewPage({ searchParams }: PageProps<"/finance/review">) {
  const user = await requireUserOrRedirect();
  const viewer = viewerFromLabel(user.owner);
  const { m } = await searchParams;
  const message = typeof m === "string" ? m : null;
  const threshold = await largeThreshold(viewer);
  const [report, cats, large, log, ai, assets, tasks] = await Promise.all([
    reconcileReport(viewer),
    categoryReview(viewer),
    largePurchases(viewer, threshold),
    listReviewActions(viewer),
    aiConfigured(),
    listAssets(),
    listOpenTasks(),
  ]);
  const other = viewer === "user1" ? "user2" : "user1";
  const toMap = cats.rows.filter((r) => r.source !== "keep");
  const fits = cats.rows.filter((r) => r.source === "keep");
  const unplaced = toMap.filter((r) => !r.suggestion).length;
  const step1 = report.imported.length + (report.duplicates.length ? 1 : 0) + report.names.length + report.coverage.filter((c) => c.level === "warn").length;
  const choices = allChoices();

  return (
    <section className="max-w-5xl space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Finance review</h1>
        <p className="text-sm text-muted-foreground">
          A one-time check after linking the bank and importing history. Work down the four steps; every change is logged at the
          bottom and can be undone. This covers joint accounts and yours; {OWNER_LABELS[other]}&apos;s personal accounts aren&apos;t
          included.
        </p>
        <ol className="flex flex-wrap gap-2 pt-2 text-sm">
          <li><a className="underline" href="#reconcile">1. Reconcile ({step1 ? `${step1} to look at` : "all clear"})</a></li>
          <li><a className="underline" href="#categories">2. Categories ({toMap.length ? `${toMap.length} to map` : "all clean"})</a></li>
          <li><a className="underline" href="#large">3. Large purchases ({large.openCount ? `${large.openCount} questions` : "none open"})</a></li>
          <li><a className="underline" href="#upkeep">4. House upkeep ({assets.length} equipment, {tasks.length} tasks)</a></li>
        </ol>
      </div>

      {message && (
        <p role="status" className="rounded-lg border border-foreground/30 bg-muted px-4 py-2 text-sm">
          {message}
        </p>
      )}

      {/* ------------------------------------------------------------ step 1 */}
      <section id="reconcile" className="space-y-4 scroll-mt-4">
        <h2 className="text-xl font-semibold">1. Reconcile accounts and imports</h2>

        <div className="space-y-2">
          <h3 className="font-medium">Imported accounts that match a linked one</h3>
          <p className="text-sm text-muted-foreground">
            Simplifi history that landed in its own account. Merging moves its transactions into the linked account and drops any the
            bank feed already has (same amount within 3 days). The emptied account is marked inactive.
          </p>
          {report.imported.length === 0 ? (
            <p className="text-sm">Nothing to merge.</p>
          ) : (
            <ul className="space-y-2">
              {report.imported.map((a) => (
                <li key={a.accountId} className="rounded-lg border p-3 text-sm">
                  <form action={mergeAccountAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="fromId" value={a.accountId} />
                    <span className="font-medium">{a.name}</span>
                    <span className="text-muted-foreground">
                      {a.count} transactions, {a.first} to {a.last} · {OWNER_LABELS[a.owner]}
                    </span>
                    <span>→</span>
                    <select name="intoId" defaultValue={a.suggestedIntoId ?? ""} required className={input}>
                      <option value="" disabled>
                        Pick the linked account
                      </option>
                      {a.candidates.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({ACCOUNT_KIND_LABELS[c.kind]}, {OWNER_LABELS[c.owner]}){c.id === a.suggestedIntoId ? " · likely match" : ""}
                        </option>
                      ))}
                    </select>
                    <SubmitButton className={primary} pending="Merging…">
                      Merge
                    </SubmitButton>
                  </form>
                  {a.candidates.some((c) => c.owner !== a.owner) && (
                    <p className="pt-1 text-xs text-muted-foreground">
                      If the linked account has another owner, the history becomes visible to whoever can see that account.
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="font-medium">Duplicates between the import and the bank feed</h3>
          {report.duplicates.length === 0 ? (
            <p className="text-sm">No duplicates found.</p>
          ) : (
            <form action={removeDuplicatesAction} className="space-y-2">
              <p className="text-sm text-muted-foreground">
                These imported rows match a bank-feed transaction on the same account (same amount, posted within 3 days). Removing the
                imported copy keeps the bank&apos;s.
              </p>
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th>Account</th>
                    <th>Imported</th>
                    <th>Bank feed</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {report.duplicates.slice(0, 25).map((d) => (
                    <tr key={d.csvId} className="border-t">
                      <td>{d.account}</td>
                      <td>
                        {d.csvDate} {d.csvMerchant}
                      </td>
                      <td>
                        {d.bankDate} {d.bankMerchant}
                      </td>
                      <td className="text-right">{money(d.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {report.duplicates.length > 25 && <p className="text-xs text-muted-foreground">and {report.duplicates.length - 25} more.</p>}
              {report.duplicates.map((d) => (
                <input key={d.csvId} type="hidden" name="csvId" value={d.csvId} />
              ))}
              <SubmitButton className={primary} pending="Removing…">
                Remove {report.duplicates.length} imported {report.duplicates.length === 1 ? "copy" : "copies"}
              </SubmitButton>
            </form>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="font-medium">Account names and types</h3>
          {report.names.length === 0 ? (
            <p className="text-sm">Names look tidy.</p>
          ) : (
            <ul className="space-y-2">
              {report.names.map((n) => (
                <li key={n.accountId}>
                  <form action={renameAccountAction} className="flex flex-wrap items-center gap-2 text-sm">
                    <input type="hidden" name="id" value={n.accountId} />
                    <span className="min-w-48 text-muted-foreground">{n.current}</span>
                    <span>→</span>
                    <input name="displayName" defaultValue={n.suggested} maxLength={80} className={input} aria-label="Nickname" />
                    <select name="kind" defaultValue={n.suggestedKind} className={input} aria-label="Type">
                      {ACCOUNT_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {ACCOUNT_KIND_LABELS[k]}
                        </option>
                      ))}
                    </select>
                    <SubmitButton className={button}>Save</SubmitButton>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            Official card names and owners are on the <Link className="underline" href="/finance/accounts">Accounts page</Link>.
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="font-medium">Balances and gaps</h3>
          {report.coverage.length === 0 ? (
            <p className="text-sm">Balances are current and the history has no gaps.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {report.coverage.map((c, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  <Badge variant={c.level === "warn" ? "warning" : "secondary"}>{c.level === "warn" ? "Check" : "Note"}</Badge>
                  <span className="font-medium">{c.account}:</span>
                  <span>{c.text}</span>
                  {c.offerDeactivate && (
                    <form action={deactivateAccountAction}>
                      <input type="hidden" name="id" value={c.accountId} />
                      <SubmitButton className={button}>Mark inactive</SubmitButton>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------ step 2 */}
      <section id="categories" className="space-y-4 scroll-mt-4">
        <h2 className="text-xl font-semibold">2. One clean set of categories</h2>
        <p className="text-sm text-muted-foreground">
          Every category in your history, mapped onto one set of {choices.filter((c) => !c.includes("›")).length} categories with
          subcategories. Mint and Simplifi names are mapped by a built-in list; Claude suggests the rest. Change any target, untick
          rows to leave them, then Apply. Merchant rules follow, so new bank transactions land in the new categories.
        </p>
        <div className="flex flex-wrap gap-2">
          {unplaced > 0 && (
            <form action={proposeCategoriesAction}>
              <SubmitButton className={primary} pending="Claude is reading your categories…">
                Ask Claude about the {unplaced} without a suggestion
              </SubmitButton>
            </form>
          )}
          {cats.uncategorized > 0 && (
            <form action={categorizeUncategorizedAction}>
              <SubmitButton className={button} pending="Categorizing…">
                Categorize {cats.uncategorized} uncategorized transactions
              </SubmitButton>
            </form>
          )}
          {!ai && <p className="text-sm text-muted-foreground">Claude isn&apos;t set up yet: add it in <Link className="underline" href="/settings">Settings</Link>.</p>}
        </div>
        {toMap.length === 0 ? (
          <p className="text-sm">Every category already fits the set.</p>
        ) : (
          <form action={applyCategoriesAction} className="space-y-2">
            <datalist id="category-choices">
              {choices.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="w-8">Use</th>
                  <th>Now</th>
                  <th className="text-right">Txns</th>
                  <th>Examples</th>
                  <th>Becomes</th>
                </tr>
              </thead>
              <tbody>
                {toMap.map((r, i) => (
                  <tr key={formatPair(r.from)} className="border-t align-top">
                    <td className="py-1">
                      <input type="hidden" name={`row-${i}`} value={JSON.stringify(r.from)} />
                      <input type="checkbox" name={`use-${i}`} defaultChecked={Boolean(r.suggestion)} aria-label={`Remap ${formatPair(r.from)}`} />
                    </td>
                    <td className="py-1">{formatPair(r.from)}</td>
                    <td className="py-1 text-right">{r.count}</td>
                    <td className="py-1 text-xs text-muted-foreground">{r.merchants.join(", ")}</td>
                    <td className="py-1">
                      <input
                        name={`to-${i}`}
                        list="category-choices"
                        defaultValue={r.suggestion ? formatPair(r.suggestion) : ""}
                        placeholder="Pick a category"
                        className={`${input} w-full min-w-56`}
                      />
                      {r.source && r.source !== "keep" && <span className="text-xs text-muted-foreground">{r.source === "claude" ? "Claude" : "built-in"}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <SubmitButton className={primary} pending="Recategorizing…">
              Apply ticked rows
            </SubmitButton>
          </form>
        )}
        {fits.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">{fits.length} categories already fit</summary>
            <p className="pt-1">{fits.map((f) => `${formatPair(f.from)} (${f.count})`).join(" · ")}</p>
          </details>
        )}
        <p className="text-xs text-muted-foreground">
          Budgets are kept per category: after remapping, re-accept suggestions on the <Link className="underline" href="/finance/budget">Budget page</Link>.
        </p>
      </section>

      {/* ------------------------------------------------------------ step 3 */}
      <section id="large" className="space-y-4 scroll-mt-4">
        <h2 className="text-xl font-semibold">3. Large purchases: what were they for?</h2>
        <p className="text-sm text-muted-foreground">
          Purchases of {money(threshold)} or more (not transfers, card payments, mortgage or loan payments). Say what each one was in a
          few words. Claude notes it on the transaction and, when it&apos;s about the house, adds the equipment and the upkeep it needs to
          Home maintenance. Those edits show in <Link className="underline" href="/assistant/history">Ask Claude&apos;s change history</Link>,
          where each can be undone.
        </p>
        <form action={setThresholdAction} className="flex items-center gap-2 text-sm">
          <label htmlFor="threshold">Ask about purchases from $</label>
          <input id="threshold" name="amount" type="number" min={50} max={100000} step={50} defaultValue={threshold} className={`${input} w-28`} />
          <SubmitButton className={button}>Update</SubmitButton>
        </form>
        {large.open.length === 0 ? (
          <p className="text-sm">No unexplained purchases at this amount.</p>
        ) : (
          <ul className="space-y-3">
            {large.open.map((p) => (
              <li key={p.id} className="space-y-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {p.merchant} <span className="font-normal text-muted-foreground">· {p.date} · {p.account}</span>
                  </span>
                  <span className="font-semibold">{money(p.amount)}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {formatPair(p)}
                  {p.description && p.description !== p.merchant ? ` · ${p.description}` : ""}
                  {p.notes ? ` · Note: ${p.notes}` : ""}
                </p>
                <form action={answerPurchaseAction} className="flex flex-wrap gap-2">
                  <input type="hidden" name="id" value={p.id} />
                  <input
                    name="answer"
                    required
                    maxLength={500}
                    placeholder="What was this for? e.g. new furnace and AC, 3-ton Trane"
                    className={`${input} min-w-72 flex-1`}
                  />
                  <SubmitButton className={primary} pending="Claude is filing it…">
                    Save
                  </SubmitButton>
                </form>
                <div className="flex flex-wrap gap-2">
                  <form action={skipPurchaseAction}>
                    <input type="hidden" name="id" value={p.id} />
                    <SubmitButton className={button}>Skip, nothing to record</SubmitButton>
                  </form>
                  <form action={skipMerchantAction}>
                    <input type="hidden" name="merchant" value={p.merchant} />
                    <SubmitButton className={button}>Skip all at {p.merchant}</SubmitButton>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
        {large.openCount > large.open.length && (
          <p className="text-sm text-muted-foreground">Showing the newest {large.open.length} of {large.openCount}. Answer or skip these to see more.</p>
        )}
        {large.done.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">{large.done.length} answered or skipped</summary>
            <ul className="space-y-2 pt-2">
              {large.done.map((d) => (
                <li key={d.id} className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{d.merchant}</span>
                  <span className="text-muted-foreground">
                    {d.date} · {money(d.amount)}
                  </span>
                  <span>{d.status === "dismissed" ? "Skipped" : `“${d.answer}”`}</span>
                  {d.outcome?.summary && <span className="text-muted-foreground">→ {d.outcome.summary}</span>}
                  <form action={reopenPurchaseAction}>
                    <input type="hidden" name="id" value={d.id} />
                    <SubmitButton className="text-xs underline">Ask again</SubmitButton>
                  </form>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {/* ------------------------------------------------------------ step 4 */}
      <section id="upkeep" className="space-y-3 scroll-mt-4">
        <h2 className="text-xl font-semibold">4. House upkeep</h2>
        <p className="text-sm text-muted-foreground">
          The house history, equipment and action items, including what the answers above added. Manage everything on{" "}
          <Link className="underline" href="/maintenance">Home maintenance</Link>, or ask Claude to add more.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="font-medium">Equipment</h3>
            {assets.length === 0 ? (
              <p className="text-sm text-muted-foreground">None yet.</p>
            ) : (
              <ul className="text-sm">
                {assets.map((a) => (
                  <li key={a.id}>
                    {a.name} <span className="text-muted-foreground">· {ASSET_KIND_LABELS[a.kind]}{a.installedOn ? ` · since ${a.installedOn}` : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="font-medium">Open upkeep tasks</h3>
            {tasks.length === 0 ? (
              <p className="text-sm text-muted-foreground">None yet.</p>
            ) : (
              <ul className="text-sm">
                {tasks.slice(0, 15).map((t) => (
                  <li key={t.id}>
                    {t.title} <span className="text-muted-foreground">· due {t.dueDate}{t.recurrenceDays ? ` · every ${t.recurrenceDays} days` : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------- log */}
      <section id="log" className="space-y-2 scroll-mt-4">
        <h2 className="text-lg font-semibold">Changes made in this review</h2>
        {log.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {log.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">{l.createdAt.toLocaleString("en-US")}</span>
                <span className={l.status === "undone" ? "line-through opacity-60" : ""}>{l.summary}</span>
                {l.status === "applied" ? (
                  <form action={undoReviewChangeAction}>
                    <input type="hidden" name="id" value={l.id} />
                    <SubmitButton className={button} pending="Undoing…">
                      Undo
                    </SubmitButton>
                  </form>
                ) : (
                  <Badge variant="secondary">Undone</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
