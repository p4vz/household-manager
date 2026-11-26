import Link from "next/link";
import { SubmitButton } from "@/components/submit-button";
import {
  ACCOUNT_KINDS,
  ACCOUNT_KIND_LABELS,
  OWNER_LABELS,
  formatPair,
  type categoryReview,
  type largePurchases,
  type listReviewActions,
  type reconcileReport,
} from "@/modules/finance/api";
import { ASSET_KIND_LABELS, type listAssets, type listOpenTasks } from "@/modules/maintenance/api";
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

export type ReviewData = {
  otherLabel: string;
  message: string | null;
  threshold: number;
  report: Awaited<ReturnType<typeof reconcileReport>>;
  cats: Awaited<ReturnType<typeof categoryReview>>;
  large: Awaited<ReturnType<typeof largePurchases>>;
  log: Awaited<ReturnType<typeof listReviewActions>>;
  ai: boolean;
  assets: Awaited<ReturnType<typeof listAssets>>;
  tasks: Awaited<ReturnType<typeof listOpenTasks>>;
  choices: string[];
};

const input = "rounded-md border bg-background px-2 py-1.5 text-sm";
const button = "rounded-md border bg-background px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50";
const primary = "rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50";
const quiet = "text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50";
const money = (n: number) =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The Finance review, laid out to scan: a "what needs you" summary on top,
 * then one card per step. A step with nothing to do collapses to a single
 * "All clear" line; explanations sit behind "How this works".
 */
export function ReviewView(d: ReviewData) {
  const { report, cats, large, log, assets, tasks } = d;
  const toMap = cats.rows.filter((r) => r.source !== "keep");
  const fits = cats.rows.filter((r) => r.source === "keep");
  const unplaced = toMap.filter((r) => !r.suggestion).length;
  const warnings = report.coverage.filter((c) => c.level === "warn");
  const notes = report.coverage.filter((c) => c.level !== "warn");

  const accountTodo = report.imported.length + (report.duplicates.length ? 1 : 0) + report.names.length + warnings.length;
  const categoryTodo = toMap.length + (cats.uncategorized ? 1 : 0);
  const purchaseTodo = large.openCount;
  const total = accountTodo + categoryTodo + purchaseTodo;
  const applied = log.filter((l) => l.status === "applied").length;

  return (
    <section className="max-w-4xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Finance review</h1>
        <p className="text-sm text-muted-foreground">
          A checkup of your joint accounts and yours ({d.otherLabel}&apos;s personal accounts aren&apos;t included). Every change can be
          undone.
        </p>
      </header>

      {d.message && (
        <p role="status" className="rounded-lg border border-foreground/20 bg-muted px-4 py-2 text-sm">
          {d.message}
        </p>
      )}

      {/* ----------------------------------------------------------- summary */}
      <div className="rounded-xl border bg-card p-5 shadow-sm">
        <p className="text-lg font-semibold">
          {total === 0 ? "You're all caught up." : `${plural(total, "thing needs", "things need")} your attention`}
        </p>
        <p className="text-sm text-muted-foreground">
          {total === 0
            ? "Nothing to fix right now. New large purchases will show up here when they come in."
            : "Start with whichever card has the most. Each one opens the step below."}
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <SummaryTile href="#reconcile" count={accountTodo} label="Accounts to tidy" done="Accounts look right" />
          <SummaryTile href="#categories" count={categoryTodo} label="Categories to sort" done="Categories are clean" />
          <SummaryTile href="#large" count={purchaseTodo} label="Purchases to explain" done="No purchases to explain" />
        </div>
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <a className="hover:text-foreground hover:underline" href="#upkeep">
            House upkeep: {plural(assets.length, "item")} of equipment, {plural(tasks.length, "open task")}
          </a>
          <a className="hover:text-foreground hover:underline" href="#log">
            {applied ? `${plural(applied, "change")} made, undo any` : "No changes made yet"}
          </a>
        </div>
      </div>

      {/* ------------------------------------------------------ 1. accounts */}
      <Step
        id="reconcile"
        n={1}
        title="Tidy up accounts"
        lead="Make sure each real account shows up once, with a clear name and no doubled transactions."
        todo={accountTodo}
        how={
          <>
            Imported history (from Simplifi) sometimes lands in its own account. Merging moves those transactions into the bank-linked
            account and drops any the bank already has (same amount, within 3 days). Official card names and owners live on the{" "}
            <Link className="underline" href="/finance/accounts">Accounts page</Link>.
          </>
        }
      >
        {report.imported.length > 0 && (
          <Group title="Combine imported history with the linked account" hint="Pick the bank account it belongs to, then Merge.">
            {report.imported.map((a) => (
              <Item key={a.accountId}>
                <form action={mergeAccountAction} className="space-y-2">
                  <input type="hidden" name="fromId" value={a.accountId} />
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">{a.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {plural(a.count, "transaction")} · {a.first} to {a.last} · {OWNER_LABELS[a.owner]}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-muted-foreground">Belongs to</span>
                    <select name="intoId" defaultValue={a.suggestedIntoId ?? ""} required className={`${input} min-w-56 flex-1`}>
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
                  </div>
                  {a.candidates.some((c) => c.owner !== a.owner) && (
                    <p className="text-xs text-muted-foreground">
                      Heads up: if the linked account has a different owner, this history becomes visible to whoever can see that account.
                    </p>
                  )}
                </form>
              </Item>
            ))}
          </Group>
        )}

        {report.duplicates.length > 0 && (
          <Group title="Remove doubled transactions">
            <Item>
              <form action={removeDuplicatesAction} className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm">
                    <span className="font-medium">{plural(report.duplicates.length, "transaction")}</span> appear twice: once from the
                    import and once from the bank. Removing keeps the bank&apos;s copy.
                  </p>
                  <SubmitButton className={primary} pending="Removing…">
                    Remove {report.duplicates.length} {report.duplicates.length === 1 ? "copy" : "copies"}
                  </SubmitButton>
                </div>
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground">See them</summary>
                  <table className="mt-2 w-full text-sm">
                    <thead className="text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="py-1 font-normal">Account</th>
                        <th className="py-1 font-normal">Imported</th>
                        <th className="py-1 font-normal">From the bank</th>
                        <th className="py-1 text-right font-normal">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.duplicates.slice(0, 25).map((x) => (
                        <tr key={x.csvId} className="border-t">
                          <td className="py-1">{x.account}</td>
                          <td className="py-1">
                            {x.csvDate} {x.csvMerchant}
                          </td>
                          <td className="py-1">
                            {x.bankDate} {x.bankMerchant}
                          </td>
                          <td className="py-1 text-right tabular-nums">{money(x.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {report.duplicates.length > 25 && (
                    <p className="pt-1 text-xs text-muted-foreground">and {report.duplicates.length - 25} more.</p>
                  )}
                </details>
                {report.duplicates.map((x) => (
                  <input key={x.csvId} type="hidden" name="csvId" value={x.csvId} />
                ))}
              </form>
            </Item>
          </Group>
        )}

        {report.names.length > 0 && (
          <Group title="Give accounts clearer names" hint="We suggested a name and type. Edit if you like, then Save.">
            {report.names.map((x) => (
              <Item key={x.accountId}>
                <form action={renameAccountAction} className="space-y-2">
                  <input type="hidden" name="id" value={x.accountId} />
                  <p className="text-xs text-muted-foreground">Now called “{x.current}”</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <input name="displayName" defaultValue={x.suggested} maxLength={80} className={`${input} min-w-48 flex-1`} aria-label="Nickname" />
                    <select name="kind" defaultValue={x.suggestedKind} className={input} aria-label="Type">
                      {ACCOUNT_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {ACCOUNT_KIND_LABELS[k]}
                        </option>
                      ))}
                    </select>
                    <SubmitButton className={primary}>Save</SubmitButton>
                  </div>
                </form>
              </Item>
            ))}
          </Group>
        )}

        {warnings.length > 0 && (
          <Group title="Worth a look" hint="Things that may mean missing history or a stale balance.">
            {warnings.map((c, i) => (
              <Item key={i}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm">
                    <span className="font-medium">{c.account}</span>
                    <span className="text-muted-foreground"> · </span>
                    {c.text}
                  </p>
                  {c.offerDeactivate && (
                    <form action={deactivateAccountAction}>
                      <input type="hidden" name="id" value={c.accountId} />
                      <SubmitButton className={button}>Mark inactive</SubmitButton>
                    </form>
                  )}
                </div>
              </Item>
            ))}
          </Group>
        )}

        {notes.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">{plural(notes.length, "note")}, nothing to do</summary>
            <ul className="mt-2 space-y-1">
              {notes.map((c, i) => (
                <li key={i}>
                  <span className="font-medium">{c.account}</span>
                  <span className="text-muted-foreground"> · {c.text}</span>
                  {c.offerDeactivate && (
                    <form action={deactivateAccountAction} className="ml-2 inline">
                      <input type="hidden" name="id" value={c.accountId} />
                      <SubmitButton className={quiet}>Mark inactive</SubmitButton>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Step>

      {/* ---------------------------------------------------- 2. categories */}
      <Step
        id="categories"
        n={2}
        title="Sort categories"
        lead="Put every transaction into one tidy set of categories, so budgets and reports add up."
        todo={categoryTodo}
        how={
          <>
            Your history uses category names from Mint, Simplifi and the bank. Each old name below is mapped onto one set of{" "}
            {d.choices.filter((c) => !c.includes("›")).length} categories. Mint and Simplifi names are matched by a built-in list; Claude
            suggests the rest. Applying also updates merchant rules so new transactions land in the right place. Budgets are kept per
            category, so re-accept suggestions on the <Link className="underline" href="/finance/budget">Budget page</Link> afterwards.
          </>
        }
      >
        {(unplaced > 0 || cats.uncategorized > 0) && (
          <div className="flex flex-wrap items-center gap-2">
            {unplaced > 0 && (
              <form action={proposeCategoriesAction}>
                <SubmitButton className={button} pending="Claude is reading your categories…">
                  Ask Claude to suggest {plural(unplaced, "missing one")}
                </SubmitButton>
              </form>
            )}
            {cats.uncategorized > 0 && (
              <form action={categorizeUncategorizedAction}>
                <SubmitButton className={button} pending="Categorizing…">
                  Categorize {plural(cats.uncategorized, "transaction")} with no category
                </SubmitButton>
              </form>
            )}
            {!d.ai && (
              <p className="text-xs text-muted-foreground">
                Claude isn&apos;t set up yet. Add it in <Link className="underline" href="/settings">Settings</Link>.
              </p>
            )}
          </div>
        )}

        {toMap.length > 0 && (
          <form action={applyCategoriesAction} className="space-y-3">
            <p className="text-sm">
              {plural(toMap.length - unplaced, "old category has", "old categories have")} a suggestion ready
              {unplaced > 0 ? `, ${plural(unplaced, "needs", "need")} you to pick` : ""}. Untick any you want to leave as they are.
            </p>
            <datalist id="category-choices">
              {d.choices.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <ul className="divide-y rounded-lg border">
              {toMap.map((r, i) => (
                <li key={formatPair(r.from)} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
                  <input type="hidden" name={`row-${i}`} value={JSON.stringify(r.from)} />
                  <input
                    type="checkbox"
                    name={`use-${i}`}
                    defaultChecked={Boolean(r.suggestion)}
                    aria-label={`Change ${formatPair(r.from)}`}
                    className="size-4"
                  />
                  <div className="min-w-40 flex-1">
                    <p className="text-sm font-medium">
                      {formatPair(r.from)} <span className="font-normal text-muted-foreground">· {plural(r.count, "txn")}</span>
                    </p>
                    {r.merchants.length > 0 && <p className="truncate text-xs text-muted-foreground">e.g. {r.merchants.join(", ")}</p>}
                  </div>
                  <span aria-hidden className="text-muted-foreground">
                    →
                  </span>
                  <div className="flex min-w-56 flex-1 items-center gap-2">
                    <input
                      name={`to-${i}`}
                      list="category-choices"
                      defaultValue={r.suggestion ? formatPair(r.suggestion) : ""}
                      placeholder="Pick a category"
                      aria-label={`New category for ${formatPair(r.from)}`}
                      className={`${input} w-full ${r.suggestion ? "" : "border-warning"}`}
                    />
                    {r.source && r.source !== "keep" && (
                      <span className="shrink-0 text-xs text-muted-foreground">{r.source === "claude" ? "by Claude" : "built-in"}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <SubmitButton className={primary} pending="Recategorizing…">
              Apply ticked changes
            </SubmitButton>
          </form>
        )}

        {fits.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">{plural(fits.length, "category already fits", "categories already fit")}</summary>
            <p className="pt-2 text-muted-foreground">{fits.map((f) => `${formatPair(f.from)} (${f.count})`).join(" · ")}</p>
          </details>
        )}
      </Step>

      {/* ----------------------------------------------- 3. large purchases */}
      <Step
        id="large"
        n={3}
        title="Explain large purchases"
        lead={`Say in a few words what each purchase of $${d.threshold.toLocaleString("en-US")} or more was for. House-related ones are added to Home maintenance for you.`}
        todo={purchaseTodo}
        how={
          <>
            <p>
              Transfers, card payments, mortgage and loan payments are left out. Claude saves your answer as a note on the transaction and,
              when it&apos;s about the house, adds the equipment and its upkeep to Home maintenance. Those edits can be undone from{" "}
              <Link className="underline" href="/assistant/history">Ask Claude&apos;s change history</Link>.
            </p>
            <form action={setThresholdAction} className="mt-2 flex flex-wrap items-center gap-2">
              <label htmlFor="threshold">Ask about purchases from $</label>
              <input id="threshold" name="amount" type="number" min={50} max={100000} step={50} defaultValue={d.threshold} className={`${input} w-28`} />
              <SubmitButton className={button}>Update</SubmitButton>
            </form>
          </>
        }
      >
        {large.open.length > 0 && (
          <ul className="space-y-3">
            {large.open.map((p) => (
              <li key={p.id}>
                <Item>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">{p.merchant}</span>
                    <span className="text-lg font-semibold tabular-nums">{money(p.amount)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {p.date} · {p.account} · {formatPair(p)}
                    {p.description && p.description !== p.merchant ? ` · ${p.description}` : ""}
                  </p>
                  {p.notes && <p className="text-xs text-muted-foreground">Note: {p.notes}</p>}
                  <form action={answerPurchaseAction} className="mt-2 flex flex-wrap gap-2">
                    <input type="hidden" name="id" value={p.id} />
                    <input
                      name="answer"
                      required
                      maxLength={500}
                      placeholder="What was it? e.g. new furnace and AC"
                      aria-label={`What was the ${p.merchant} purchase for?`}
                      className={`${input} min-w-60 flex-1`}
                    />
                    <SubmitButton className={primary} pending="Claude is filing it…">
                      Save
                    </SubmitButton>
                  </form>
                  <div className="mt-1 flex flex-wrap gap-x-4">
                    <form action={skipPurchaseAction}>
                      <input type="hidden" name="id" value={p.id} />
                      <SubmitButton className={quiet}>Nothing to record</SubmitButton>
                    </form>
                    <form action={skipMerchantAction}>
                      <input type="hidden" name="merchant" value={p.merchant} />
                      <SubmitButton className={quiet}>Skip every {p.merchant} purchase</SubmitButton>
                    </form>
                  </div>
                </Item>
              </li>
            ))}
          </ul>
        )}
        {large.openCount > large.open.length && (
          <p className="text-sm text-muted-foreground">
            Showing the newest {large.open.length} of {large.openCount}. More appear as you answer these.
          </p>
        )}
        {large.done.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">{plural(large.done.length, "purchase")} already answered or skipped</summary>
            <ul className="mt-2 divide-y">
              {large.done.map((x) => (
                <li key={x.id} className="flex flex-wrap items-baseline gap-x-2 py-1.5">
                  <span className="font-medium">{x.merchant}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {x.date} · {money(x.amount)}
                  </span>
                  <span>{x.status === "dismissed" ? "Skipped" : `“${x.answer}”`}</span>
                  {x.outcome?.summary && <span className="text-muted-foreground">· {x.outcome.summary}</span>}
                  <form action={reopenPurchaseAction} className="ml-auto">
                    <input type="hidden" name="id" value={x.id} />
                    <SubmitButton className={quiet}>Ask again</SubmitButton>
                  </form>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Step>

      {/* --------------------------------------------------- house upkeep */}
      <details id="upkeep" className="group scroll-mt-4 rounded-xl border bg-card shadow-sm">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5">
          <div>
            <p className="font-semibold">What this added to house upkeep</p>
            <p className="text-sm text-muted-foreground">
              {plural(assets.length, "piece")} of equipment, {plural(tasks.length, "open task")}. For reference, nothing to do here.
            </p>
          </div>
          <Chevron />
        </summary>
        <div className="grid gap-6 border-t p-5 sm:grid-cols-2">
          <div>
            <h3 className="text-sm font-medium">Equipment</h3>
            {assets.length === 0 ? (
              <p className="text-sm text-muted-foreground">None yet.</p>
            ) : (
              <ul className="mt-1 space-y-0.5 text-sm">
                {assets.map((a) => (
                  <li key={a.id}>
                    {a.name}{" "}
                    <span className="text-muted-foreground">
                      · {ASSET_KIND_LABELS[a.kind]}
                      {a.installedOn ? ` · since ${a.installedOn}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="text-sm font-medium">Open tasks</h3>
            {tasks.length === 0 ? (
              <p className="text-sm text-muted-foreground">None yet.</p>
            ) : (
              <ul className="mt-1 space-y-0.5 text-sm">
                {tasks.slice(0, 15).map((t) => (
                  <li key={t.id}>
                    {t.title}{" "}
                    <span className="text-muted-foreground">
                      · due {t.dueDate}
                      {t.recurrenceDays ? ` · every ${t.recurrenceDays} days` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="text-sm sm:col-span-2">
            Manage it all on <Link className="underline" href="/maintenance">Home maintenance</Link>.
          </p>
        </div>
      </details>

      {/* ------------------------------------------------------------- log */}
      <details id="log" className="group scroll-mt-4 rounded-xl border bg-card shadow-sm">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5">
          <div>
            <p className="font-semibold">Changes made in this review</p>
            <p className="text-sm text-muted-foreground">
              {log.length === 0 ? "None yet." : `${plural(applied, "change")} in effect. Open to undo any of them.`}
            </p>
          </div>
          <Chevron />
        </summary>
        {log.length > 0 && (
          <ul className="divide-y border-t px-5">
            {log.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <span className={`flex-1 ${l.status === "undone" ? "line-through opacity-60" : ""}`}>{l.summary}</span>
                <span className="text-xs text-muted-foreground">{l.createdAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</span>
                {l.status === "applied" ? (
                  <form action={undoReviewChangeAction}>
                    <input type="hidden" name="id" value={l.id} />
                    <SubmitButton className={button} pending="Undoing…">
                      Undo
                    </SubmitButton>
                  </form>
                ) : (
                  <span className="text-xs text-muted-foreground">Undone</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}

function SummaryTile({ href, count, label, done }: { href: string; count: number; label: string; done: string }) {
  const clear = count === 0;
  return (
    <a
      href={href}
      className={`flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted ${clear ? "" : "border-warning/60 bg-warning/5"}`}
    >
      {clear ? (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-success/15 text-success" aria-hidden>
          <Check />
        </span>
      ) : (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-warning/20 text-base font-semibold tabular-nums">
          {count}
        </span>
      )}
      <span className={`text-sm ${clear ? "text-muted-foreground" : "font-medium"}`}>{clear ? done : label}</span>
    </a>
  );
}

/** One review step as a card. Opens by default only when it has something to do. */
function Step({
  id,
  n,
  title,
  lead,
  todo,
  how,
  children,
}: {
  id: string;
  n: number;
  title: string;
  lead: string;
  todo: number;
  how: React.ReactNode;
  children: React.ReactNode;
}) {
  const clear = todo === 0;
  return (
    <details id={id} open={!clear} className="group scroll-mt-4 rounded-xl border bg-card shadow-sm">
      <summary className="flex cursor-pointer list-none items-start gap-3 p-5">
        <span
          className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
            clear ? "bg-success/15 text-success" : "bg-foreground text-background"
          }`}
          aria-hidden
        >
          {clear ? <Check /> : n}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{title}</h2>
            {clear ? (
              <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">All clear</span>
            ) : (
              <span className="rounded-full bg-warning/20 px-2 py-0.5 text-xs font-medium">{todo} to do</span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">{lead}</p>
        </div>
        <Chevron />
      </summary>
      <div className="space-y-5 border-t p-5">
        {clear && <p className="text-sm text-muted-foreground">Nothing to do here right now.</p>}
        {children}
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer">How this works</summary>
          <div className="mt-2 space-y-2">{how}</div>
        </details>
      </div>
    </details>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div>
        <h3 className="font-medium">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Item({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border bg-background p-3">{children}</div>;
}

function Check() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}
