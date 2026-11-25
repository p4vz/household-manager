import Link from "next/link";
import { SubmitButton } from "@/components/submit-button";
import { Badge } from "@/components/ui/badge";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { householdToday, relativeDue, shortDate } from "@/modules/family/ui/dates";
import { allChoices, formatPair, houseAuditState, houseQuestions, viewerFromLabel, type HouseQuestionKind } from "@/modules/finance/api";
import { ASSET_KINDS, ASSET_KIND_LABELS, UPKEEP_AREAS, everyLabel, listAssets, listOpenTasks, listProjects } from "@/modules/maintenance/api";
import {
  addAssetFormAction,
  addProjectFormAction,
  addTaskFormAction,
  addToHouseFormAction,
  answerQuestionFormAction,
  categorizeQuestionFormAction,
  checkRecallsFormAction,
  completeTaskFormAction,
  deleteAssetFormAction,
  deleteProjectFormAction,
  deleteTaskFormAction,
  linkToProjectFormAction,
  runAuditFormAction,
  skipQuestionFormAction,
  unlinkProjectFormAction,
  updateProjectFormAction,
  updateTaskFormAction,
} from "./actions";

const input = "min-h-10 rounded-lg border bg-transparent px-2";
const button = "min-h-10 rounded-lg border px-3 text-sm disabled:opacity-50";
const primary = "min-h-10 rounded-lg bg-foreground px-3 text-sm text-background disabled:opacity-50";
const PAGE_SIZE = 20;
const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fullDate = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${iso}T00:00:00Z`));
const KIND_LABEL: Record<HouseQuestionKind, string> = { cash: "Cash withdrawal", uncategorized: "Uncategorized", house: "Possible house expense" };
const REPEAT_CHOICES: [number, string][] = [
  [30, "monthly"],
  [90, "every 3 months"],
  [182, "every 6 months"],
  [365, "yearly"],
  [730, "every 2 years"],
  [913, "every 2½ years"],
];

type Task = Awaited<ReturnType<typeof listOpenTasks>>[number];

function TaskFields({ t, today }: { t?: Task; today: string }) {
  return (
    <>
      <label className="grid gap-1 text-sm sm:col-span-2">
        Work
        <input name="title" required maxLength={120} defaultValue={t?.title} placeholder="Replace RO pre-filters" className={input} />
      </label>
      <label className="grid gap-1 text-sm">
        Area
        <input name="area" list="upkeep-areas" maxLength={60} defaultValue={t?.area ?? ""} className={input} />
      </label>
      <label className="grid gap-1 text-sm">
        Parts needed
        <input name="parts" maxLength={300} defaultValue={t?.parts ?? ""} placeholder="GE MWF filter" className={input} />
      </label>
      <label className="grid gap-1 text-sm">
        Last done
        <input name="lastDoneOn" type="date" defaultValue={t?.lastDoneOn ?? ""} className={input} />
      </label>
      <label className="grid gap-1 text-sm">
        Next due
        <input name="dueDate" type="date" required defaultValue={t?.dueDate ?? today} className={input} />
      </label>
      <label className="grid gap-1 text-sm">
        Repeat every (days, blank for one-off)
        <input name="recurrenceDays" type="number" min={1} max={3650} list="repeat-days" defaultValue={t?.recurrenceDays ?? ""} className={input} />
      </label>
      <label className="grid gap-1 text-sm">
        Estimated cost ($)
        <input name="estimatedCost" type="number" min={0} step="0.01" defaultValue={t?.estimatedCost ?? ""} className={input} />
      </label>
      <label className="grid gap-1 text-sm sm:col-span-2">
        Notes
        <input name="notes" maxLength={1000} defaultValue={t?.notes ?? ""} className={input} />
      </label>
    </>
  );
}

/**
 * House upkeep: action items with parts, last and next dates and how often;
 * the questionable-transactions tracker; the house project history; and the
 * home equipment with recall checks. Shown on the kitchen kiosk too (items).
 */
export default async function MaintenancePage({ searchParams }: PageProps<"/maintenance">) {
  const user = await requireUserOrRedirect();
  const viewer = viewerFromLabel(user.owner);
  const sp = await searchParams;
  const message = typeof sp.m === "string" ? sp.m : null;
  const page = Math.max(0, Number(typeof sp.qp === "string" ? sp.qp : 0) || 0);
  const today = householdToday();
  const [tasks, assets, projects, audit] = await Promise.all([listOpenTasks(), listAssets(), listProjects(), houseAuditState(viewer)]);
  const linked = projects.map((p) => p.transactionId).filter((x): x is string => Boolean(x));
  const questions = await houseQuestions(viewer, { linkedIds: linked, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  const unpaid = projects.filter((p) => !p.transactionId);
  const areas = [...new Set(tasks.map((t) => t.area ?? "Other"))].sort();
  const projectTotal = projects.reduce((n, p) => n + (p.amount ?? 0), 0);
  const choices = allChoices();

  return (
    <section className="max-w-4xl space-y-10">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Home maintenance</h1>
        <nav className="flex flex-wrap gap-3 text-sm">
          <a className="underline" href="#items">Action items ({tasks.length})</a>
          <a className="underline" href="#questions">Questionable transactions ({questions.count})</a>
          <a className="underline" href="#history">House history ({projects.length})</a>
          <a className="underline" href="#equipment">Equipment ({assets.length})</a>
        </nav>
        <p className="text-sm opacity-70">
          Ask Claude to add or change any of this, look up recommended intervals, or check recalls: <Link className="underline" href="/assistant">Ask Claude</Link>.
        </p>
      </div>

      {message && (
        <p role="status" className="rounded-lg border border-foreground/30 bg-muted px-4 py-2 text-sm">
          {message}
        </p>
      )}

      <datalist id="upkeep-areas">
        {UPKEEP_AREAS.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
      <datalist id="repeat-days">
        {REPEAT_CHOICES.map(([d, l]) => (
          <option key={d} value={d}>
            {l}
          </option>
        ))}
      </datalist>

      {/* ------------------------------------------------------- action items */}
      <section id="items" className="space-y-4 scroll-mt-4">
        <h2 className="text-xl font-semibold">Action items</h2>
        {tasks.length === 0 ? <p className="opacity-60">No open items.</p> : null}
        {areas.map((area) => (
          <div key={area} className="space-y-2">
            <h3 className="font-medium opacity-80">{area}</h3>
            <ul className="space-y-2">
              {tasks
                .filter((t) => (t.area ?? "Other") === area)
                .map((t) => {
                  const late = t.dueDate < today;
                  return (
                    <li key={t.id} className={`space-y-2 rounded-xl border p-4 ${late ? "border-red-500" : ""}`}>
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-medium">{t.title}</span>
                        <span className={`text-sm ${late ? "font-semibold text-red-600" : "opacity-70"}`}>
                          Next: {shortDate(t.dueDate)} ({relativeDue(today, t.dueDate)})
                        </span>
                      </div>
                      <dl className="grid gap-x-4 text-sm sm:grid-cols-2">
                        <div>
                          <dt className="inline opacity-60">How often: </dt>
                          <dd className="inline">{everyLabel(t.recurrenceDays)}</dd>
                        </div>
                        <div>
                          <dt className="inline opacity-60">Last done: </dt>
                          <dd className="inline">{t.lastDoneOn ? fullDate(t.lastDoneOn) : "not recorded"}</dd>
                        </div>
                        {t.parts ? (
                          <div className="sm:col-span-2">
                            <dt className="inline opacity-60">Parts: </dt>
                            <dd className="inline">{t.parts}</dd>
                          </div>
                        ) : null}
                        {t.estimatedCost != null ? (
                          <div>
                            <dt className="inline opacity-60">Estimated: </dt>
                            <dd className="inline">{money(t.estimatedCost)}</dd>
                          </div>
                        ) : null}
                      </dl>
                      {t.notes ? <p className="text-sm opacity-70">{t.notes}</p> : null}
                      <div className="flex flex-wrap gap-2">
                        <form action={completeTaskFormAction} className="flex flex-wrap items-center gap-2">
                          <input type="hidden" name="taskId" value={t.id} />
                          <input type="date" name="date" defaultValue={today} className={`${input} text-sm`} aria-label="Done on" />
                          <input type="number" name="actualCost" min={0} step="0.01" placeholder="Cost $" className={`${input} w-24 text-sm`} />
                          <SubmitButton className="min-h-10 rounded-lg bg-emerald-600 px-4 text-sm text-white">Mark complete</SubmitButton>
                        </form>
                        <form action={deleteTaskFormAction}>
                          <input type="hidden" name="taskId" value={t.id} />
                          <SubmitButton className={button}>Remove</SubmitButton>
                        </form>
                      </div>
                      <details>
                        <summary className="cursor-pointer text-sm underline">Edit</summary>
                        <form action={updateTaskFormAction} className="grid gap-3 pt-2 sm:grid-cols-2">
                          <input type="hidden" name="taskId" value={t.id} />
                          <TaskFields t={t} today={today} />
                          <SubmitButton className={`${primary} sm:col-span-2`}>Save</SubmitButton>
                        </form>
                      </details>
                    </li>
                  );
                })}
            </ul>
          </div>
        ))}
        <details className="rounded-xl border p-4">
          <summary className="cursor-pointer font-medium">Add an action item</summary>
          <form action={addTaskFormAction} className="grid gap-3 pt-3 sm:grid-cols-2">
            <TaskFields today={today} />
            <SubmitButton className={`${primary} sm:col-span-2`}>Add item</SubmitButton>
          </form>
        </details>
        <p className="text-xs opacity-60">Marking an item complete records today as its last-done date and schedules the next one from it.</p>
      </section>

      {/* -------------------------------------------- questionable transactions */}
      <section id="questions" className="space-y-4 scroll-mt-4">
        <h2 className="text-xl font-semibold">Questionable transactions</h2>
        <p className="text-sm opacity-70">
          Cash withdrawals, uncategorized spending and likely house expenses from joint accounts and yours, newest first. Go through them one
          by one: say what each was for, add it to the house history, link it to a project, or give it a category. The audit runs every week
          after the bank sync; run it now to match the house history to payments and have Claude flag new house spending.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <form action={runAuditFormAction}>
            <SubmitButton className={primary} pending="Auditing…">
              Run audit now
            </SubmitButton>
          </form>
          <span className="text-sm opacity-70">
            {audit.at ? `Last audit ${audit.at.toLocaleDateString("en-US")}: ${audit.note ?? ""}` : "Not audited yet."}
          </span>
        </div>
        <datalist id="category-choices">
          {choices.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        {questions.rows.length === 0 ? (
          <p className="text-sm">Nothing to look at.</p>
        ) : (
          <ul className="space-y-3">
            {questions.rows.map((q) => (
              <li key={q.id} className="space-y-2 rounded-xl border p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {q.merchant} <span className="font-normal opacity-70">· {fullDate(q.date)} · {q.account}</span>
                  </span>
                  <span className="font-semibold">{money(q.amount)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant={q.kind === "cash" ? "warning" : "secondary"}>{KIND_LABEL[q.kind]}</Badge>
                  <span className="opacity-70">{formatPair(q)}</span>
                  {q.notes ? <span className="opacity-70">· Note: {q.notes}</span> : null}
                  {q.suggestion ? (
                    <span>
                      · Claude thinks:{" "}
                      {q.suggestion.houseRelated ? `house spending${q.suggestion.title ? `, "${q.suggestion.title}"` : ""}` : "not house spending"} (
                      {q.suggestion.confidence})
                    </span>
                  ) : null}
                </div>
                <form action={answerQuestionFormAction} className="flex flex-wrap gap-2">
                  <input type="hidden" name="id" value={q.id} />
                  <input
                    name="answer"
                    required
                    maxLength={500}
                    placeholder={q.kind === "cash" ? "What was the cash for? e.g. paid the gutter guy" : "What was this for?"}
                    className={`${input} min-w-64 flex-1`}
                  />
                  <SubmitButton className={primary} pending="Claude is filing it…">
                    Save
                  </SubmitButton>
                </form>
                <div className="flex flex-wrap gap-2">
                  <form action={addToHouseFormAction} className="flex flex-wrap gap-2">
                    <input type="hidden" name="id" value={q.id} />
                    <input name="title" defaultValue={q.suggestion?.title ?? q.merchant} maxLength={120} className={`${input} text-sm`} aria-label="Project title" />
                    <SubmitButton className={button}>Add to house history</SubmitButton>
                  </form>
                  <form action={skipQuestionFormAction}>
                    <input type="hidden" name="id" value={q.id} />
                    <SubmitButton className={button}>Not a house expense</SubmitButton>
                  </form>
                </div>
                <details className="text-sm">
                  <summary className="cursor-pointer underline">Link to a project or set a category</summary>
                  <div className="flex flex-wrap gap-2 pt-2">
                    {unpaid.length > 0 && (
                      <form action={linkToProjectFormAction} className="flex flex-wrap gap-2">
                        <input type="hidden" name="id" value={q.id} />
                        <select name="projectId" required className={input} defaultValue="">
                          <option value="" disabled>
                            House project without a payment
                          </option>
                          {unpaid.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.title} ({p.date ?? p.period ?? "no date"}
                              {p.amount != null ? `, ${money(p.amount)}` : ""})
                            </option>
                          ))}
                        </select>
                        <SubmitButton className={button}>Link</SubmitButton>
                      </form>
                    )}
                    <form action={categorizeQuestionFormAction} className="flex flex-wrap gap-2">
                      <input type="hidden" name="id" value={q.id} />
                      <input name="category" list="category-choices" required placeholder="Category" className={`${input} min-w-56`} />
                      <SubmitButton className={button}>Set category</SubmitButton>
                    </form>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-3 text-sm">
          {page > 0 && (
            <Link className="underline" href={`/maintenance?qp=${page - 1}#questions`}>
              ← Newer
            </Link>
          )}
          {(page + 1) * PAGE_SIZE < questions.count && (
            <Link className="underline" href={`/maintenance?qp=${page + 1}#questions`}>
              Older →
            </Link>
          )}
          <span className="opacity-60">{questions.count} open</span>
        </div>
        <p className="text-xs opacity-60">
          Answers and additions are undoable from <Link className="underline" href="/assistant/history">Ask Claude&apos;s change history</Link>. Large
          purchases are also in the <Link className="underline" href="/finance/review#large">Finance review</Link>.
        </p>
      </section>

      {/* ------------------------------------------------------ house history */}
      <section id="history" className="space-y-4 scroll-mt-4">
        <h2 className="text-xl font-semibold">House project history</h2>
        <p className="text-sm opacity-70">
          {projects.length} projects, {money(projectTotal)} recorded. &ldquo;Payment found&rdquo; means the audit (or you) matched it to a bank
          transaction.
        </p>
        <ul className="space-y-2">
          {projects.map((p) => (
            <li key={p.id} className="space-y-1 rounded-xl border p-4 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {p.title} <span className="font-normal opacity-70">· {p.period ?? (p.date ? fullDate(p.date) : "no date")}</span>
                </span>
                <span className="font-semibold">{p.amount != null ? money(p.amount) : (p.amountNote ?? "")}</span>
              </div>
              {p.vendor ? <p className="opacity-80">{p.vendor}</p> : null}
              {p.description ? <p className="opacity-70">{p.description}</p> : null}
              <div className="flex flex-wrap items-center gap-2">
                {p.transactionId ? (
                  <>
                    <Badge variant="secondary">Payment found</Badge>
                    <form action={unlinkProjectFormAction}>
                      <input type="hidden" name="id" value={p.id} />
                      <SubmitButton className="text-xs underline">Unlink</SubmitButton>
                    </form>
                  </>
                ) : p.amount != null ? (
                  <Badge variant="outline">No matching payment yet</Badge>
                ) : null}
              </div>
              <details>
                <summary className="cursor-pointer underline">Edit</summary>
                <form action={updateProjectFormAction} className="grid gap-2 pt-2 sm:grid-cols-2">
                  <input type="hidden" name="id" value={p.id} />
                  <input name="title" required maxLength={120} defaultValue={p.title} className={`${input} sm:col-span-2`} aria-label="Title" />
                  <input name="date" type="date" defaultValue={p.date ?? ""} className={input} aria-label="Date" />
                  <input name="period" maxLength={40} defaultValue={p.period ?? ""} placeholder="Period, e.g. 2022 – 2023" className={input} />
                  <input name="vendor" maxLength={120} defaultValue={p.vendor ?? ""} placeholder="Vendor" className={input} />
                  <input name="amount" type="number" min={0} step="0.01" defaultValue={p.amount ?? ""} placeholder="Amount $" className={input} />
                  <input name="amountNote" maxLength={60} defaultValue={p.amountNote ?? ""} placeholder="Amount note" className={input} />
                  <textarea name="description" maxLength={1000} defaultValue={p.description ?? ""} placeholder="Description" className={`${input} sm:col-span-2`} />
                  <div className="flex gap-2 sm:col-span-2">
                    <SubmitButton className={primary}>Save</SubmitButton>
                  </div>
                </form>
                <form action={deleteProjectFormAction} className="pt-2">
                  <input type="hidden" name="id" value={p.id} />
                  <SubmitButton className={button}>Delete</SubmitButton>
                </form>
              </details>
            </li>
          ))}
        </ul>
        <details className="rounded-xl border p-4">
          <summary className="cursor-pointer font-medium">Add a project or expense</summary>
          <form action={addProjectFormAction} className="grid gap-2 pt-3 sm:grid-cols-2">
            <input name="title" required maxLength={120} placeholder="Title, e.g. Water heater replacement" className={`${input} sm:col-span-2`} />
            <input name="date" type="date" className={input} aria-label="Date" />
            <input name="period" maxLength={40} placeholder="Or a period, e.g. 2022 – 2023" className={input} />
            <input name="vendor" maxLength={120} placeholder="Vendor" className={input} />
            <input name="amount" type="number" min={0} step="0.01" placeholder="Amount $" className={input} />
            <input name="amountNote" maxLength={60} placeholder="Amount note" className={input} />
            <textarea name="description" maxLength={1000} placeholder="Description" className={`${input} sm:col-span-2`} />
            <SubmitButton className={`${primary} sm:col-span-2`}>Add</SubmitButton>
          </form>
        </details>
      </section>

      {/* ---------------------------------------------------------- equipment */}
      <section id="equipment" className="space-y-4 scroll-mt-4">
        <h2 className="text-xl font-semibold">Home equipment</h2>
        <p className="text-sm opacity-70">Check recalls searches the U.S. Consumer Product Safety Commission by the item&apos;s name only.</p>
        <ul className="space-y-2">
          {assets.map((a) => (
            <li key={a.id} className="space-y-1 rounded-xl border px-4 py-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span>
                  <span className="font-medium">{a.name}</span>
                  <span className="opacity-70">
                    {" "}
                    · {ASSET_KIND_LABELS[a.kind]}
                    {a.location ? ` · ${a.location}` : ""}
                    {a.installedOn ? ` · since ${fullDate(a.installedOn)}` : ""}
                    {a.cost != null ? ` · ${money(a.cost)}` : ""}
                  </span>
                </span>
                <span className="flex gap-2">
                  <form action={checkRecallsFormAction}>
                    <input type="hidden" name="id" value={a.id} />
                    <SubmitButton className={button} pending="Checking…">
                      Check recalls
                    </SubmitButton>
                  </form>
                  <form action={deleteAssetFormAction}>
                    <input type="hidden" name="id" value={a.id} />
                    <SubmitButton className={button}>Remove</SubmitButton>
                  </form>
                </span>
              </div>
              {a.notes ? <p className="opacity-70">{a.notes}</p> : null}
              {a.recallCheckedAt ? (
                a.recalls?.length ? (
                  <ul className="space-y-1 rounded-lg bg-muted p-2">
                    {a.recalls.map((r, i) => (
                      <li key={i}>
                        {r.url ? (
                          <a className="underline" href={r.url} target="_blank" rel="noreferrer">
                            {r.title}
                          </a>
                        ) : (
                          r.title
                        )}
                        {r.date ? ` (${r.date})` : ""}
                        {r.hazard ? <span className="opacity-70"> · {r.hazard}</span> : null}
                        {r.remedy ? <span className="opacity-70"> · Remedy: {r.remedy}</span> : null}
                      </li>
                    ))}
                    <li className="text-xs opacity-60">Check whether your model is listed before acting.</li>
                  </ul>
                ) : (
                  <p className="text-xs opacity-60">No recalls found ({a.recallCheckedAt.toLocaleDateString("en-US")}).</p>
                )
              ) : null}
            </li>
          ))}
        </ul>
        <details className="rounded-xl border p-4">
          <summary className="cursor-pointer font-medium">Add equipment</summary>
          <form action={addAssetFormAction} className="grid gap-2 pt-3 sm:grid-cols-2">
            <input name="name" required maxLength={80} placeholder="Brand and type, e.g. Rheem water heater" className={`${input} sm:col-span-2`} />
            <select name="kind" defaultValue="appliance" className={input} aria-label="Kind">
              {ASSET_KINDS.map((k) => (
                <option key={k} value={k}>
                  {ASSET_KIND_LABELS[k]}
                </option>
              ))}
            </select>
            <input name="location" maxLength={60} placeholder="Location" className={input} />
            <input name="installedOn" type="date" className={input} aria-label="Installed on" />
            <input name="cost" type="number" min={0} step="0.01" placeholder="Cost $" className={input} />
            <input name="notes" maxLength={500} placeholder="Notes (no serial numbers)" className={`${input} sm:col-span-2`} />
            <SubmitButton className={`${primary} sm:col-span-2`}>Add</SubmitButton>
          </form>
        </details>
      </section>
    </section>
  );
}
