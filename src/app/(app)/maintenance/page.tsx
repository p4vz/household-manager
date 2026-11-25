import Link from "next/link";
import { SubmitButton } from "@/components/submit-button";
import { Badge } from "@/components/ui/badge";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { householdToday, relativeDue, shortDate } from "@/modules/family/ui/dates";
import { allChoices, formatPair, houseAuditState, houseQuestions, viewerFromLabel, type HouseQuestionKind } from "@/modules/finance/api";
import { ASSET_KINDS, ASSET_KIND_LABELS, UPKEEP_AREAS, listAssets, listOpenTasks, listProjects, scheduleLabel, type RecallHit } from "@/modules/maintenance/api";
import {
  addAssetFormAction,
  addProjectFormAction,
  addTaskFormAction,
  addToHouseFormAction,
  addVehicleFormAction,
  answerQuestionFormAction,
  categorizeQuestionFormAction,
  checkRecallsFormAction,
  completeTaskFormAction,
  deleteAssetFormAction,
  deleteProjectFormAction,
  deleteTaskFormAction,
  deleteVehicleFormAction,
  linkToProjectFormAction,
  runAuditFormAction,
  skipQuestionFormAction,
  unlinkProjectFormAction,
  updateProjectFormAction,
  updateMileageFormAction,
  updateTaskFormAction,
  updateVehicleFormAction,
} from "./actions";

const input = "min-h-10 rounded-lg border bg-transparent px-2";
const button = "min-h-10 rounded-lg border px-3 text-sm disabled:opacity-50";
const primary = "min-h-10 rounded-lg bg-foreground px-3 text-sm text-background disabled:opacity-50";
const PAGE_SIZE = 20;
const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fullDate = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${iso}T00:00:00Z`));
const KIND_LABEL: Record<HouseQuestionKind, string> = { cash: "Cash withdrawal", car: "Car upkeep", uncategorized: "Uncategorized", house: "Possible house expense" };
const miles = (n: number) => `${n.toLocaleString("en-US")} mi`;
const REPEAT_CHOICES: [number, string][] = [
  [30, "monthly"],
  [90, "every 3 months"],
  [182, "every 6 months"],
  [365, "yearly"],
  [730, "every 2 years"],
  [913, "every 2½ years"],
];

type Task = Awaited<ReturnType<typeof listOpenTasks>>[number];
type Vehicle = Awaited<ReturnType<typeof listAssets>>[number];

function RecallList({ checkedAt, recalls, note }: { checkedAt: Date | null; recalls: RecallHit[] | null; note: string }) {
  if (!checkedAt) return null;
  if (!recalls?.length) return <p className="text-xs opacity-60">No recalls found ({checkedAt.toLocaleDateString("en-US")}).</p>;
  return (
    <ul className="space-y-1 rounded-lg bg-muted p-2">
      {recalls.map((r, i) => (
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
      <li className="text-xs opacity-60">{note}</li>
    </ul>
  );
}

function TaskFields({ t, today, vehicles }: { t?: Task; today: string; vehicles: Vehicle[] }) {
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
      {vehicles.length > 0 && (
        <>
          <label className="grid gap-1 text-sm">
            Car (for car upkeep)
            <select name="assetId" defaultValue={t?.assetId && vehicles.some((v) => v.id === t.assetId) ? t.assetId : ""} className={input}>
              <option value="">None</option>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Due at (miles)
            <input name="dueMileage" type="number" min={0} defaultValue={t?.dueMileage ?? ""} className={input} />
          </label>
          <label className="grid gap-1 text-sm">
            Repeat every (miles)
            <input name="recurrenceMiles" type="number" min={1} max={200000} defaultValue={t?.recurrenceMiles ?? ""} className={input} />
          </label>
        </>
      )}
      {/* Keep a car link on items of a car that is not listed (never silently unlink). */}
      {vehicles.length === 0 && t?.assetId ? <input type="hidden" name="assetId" value={t.assetId} /> : null}
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
  const [tasks, allAssets, allProjects, audit] = await Promise.all([listOpenTasks(), listAssets(), listProjects(), houseAuditState(viewer)]);
  const vehicles = allAssets.filter((a) => a.kind === "vehicle");
  const vehicleIds = new Set(vehicles.map((v) => v.id));
  const assets = allAssets.filter((a) => a.kind !== "vehicle");
  const projects = allProjects.filter((p) => !p.assetId || !vehicleIds.has(p.assetId));
  const linked = allProjects.map((p) => p.transactionId).filter((x): x is string => Boolean(x));
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
          <a className="underline" href="#vehicles">Cars ({vehicles.length})</a>
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
                  const car = t.assetId ? vehicles.find((v) => v.id === t.assetId) : undefined;
                  const late = t.dueDate < today || (t.dueMileage != null && car?.mileage != null && car.mileage >= t.dueMileage);
                  return (
                    <li key={t.id} className={`space-y-2 rounded-xl border p-4 ${late ? "border-red-500" : ""}`}>
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-medium">{t.title}</span>
                        <span className={`text-sm ${late ? "font-semibold text-red-600" : "opacity-70"}`}>
                          Next: {shortDate(t.dueDate)} ({relativeDue(today, t.dueDate)})
                          {t.dueMileage != null ? ` or at ${miles(t.dueMileage)}` : ""}
                        </span>
                      </div>
                      <dl className="grid gap-x-4 text-sm sm:grid-cols-2">
                        <div>
                          <dt className="inline opacity-60">How often: </dt>
                          <dd className="inline">{scheduleLabel(t.recurrenceDays, t.recurrenceMiles)}</dd>
                        </div>
                        <div>
                          <dt className="inline opacity-60">Last done: </dt>
                          <dd className="inline">
                            {t.lastDoneOn ? fullDate(t.lastDoneOn) : "not recorded"}
                            {t.lastDoneMileage != null ? ` at ${miles(t.lastDoneMileage)}` : ""}
                          </dd>
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
                          {car ? (
                            <input
                              type="number"
                              name="mileage"
                              min={0}
                              placeholder="Odometer"
                              defaultValue={car.mileage ?? ""}
                              className={`${input} w-28 text-sm`}
                              aria-label="Odometer reading"
                            />
                          ) : null}
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
                          <TaskFields t={t} today={today} vehicles={vehicles} />
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
            <TaskFields today={today} vehicles={vehicles} />
            <SubmitButton className={`${primary} sm:col-span-2`}>Add item</SubmitButton>
          </form>
        </details>
        <p className="text-xs opacity-60">
          Marking an item complete records its last-done date (and odometer for car items) and schedules the next one from it.
        </p>
      </section>

      {/* ---------------------------------------------------------------- cars */}
      <section id="vehicles" className="space-y-4 scroll-mt-4">
        <h2 className="text-xl font-semibold">Cars</h2>
        <p className="text-sm opacity-70">
          Oil changes, inspections, registrations and other car upkeep are action items above (area Vehicles), due by date or mileage, whichever
          comes first. Shop, parts-store and DMV payments show up in the questionable transactions to add to a car&apos;s history; fuel, parking
          and tolls don&apos;t. The app never keeps a VIN or plate number.
        </p>
        {vehicles.length === 0 ? <p className="text-sm">No cars yet. Add both below.</p> : null}
        <ul className="space-y-3">
          {vehicles.map((v) => {
            const items = tasks.filter((t) => t.assetId === v.id);
            const history = allProjects.filter((p) => p.assetId === v.id);
            return (
              <li key={v.id} className="space-y-3 rounded-xl border p-4 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    <span className="text-base font-medium">{v.name}</span>
                    <span className="opacity-70"> · {[v.year, v.make, v.model].filter(Boolean).join(" ") || "make and model not set"}</span>
                  </span>
                  <span className="opacity-80">
                    {v.mileage != null ? `${miles(v.mileage)}${v.mileageOn ? ` (as of ${fullDate(v.mileageOn)})` : ""}` : "Mileage not recorded"}
                  </span>
                </div>
                <form action={updateMileageFormAction} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="id" value={v.id} />
                  <input name="mileage" type="number" min={0} required placeholder="Odometer now" className={`${input} w-36`} aria-label="Odometer now" />
                  <SubmitButton className={button}>Update mileage</SubmitButton>
                </form>
                {items.length > 0 && (
                  <ul className="space-y-1">
                    {items.map((t) => (
                      <li key={t.id}>
                        <span className="font-medium">{t.title.replace(`: ${v.name}`, "")}</span>
                        <span className="opacity-70">
                          {" "}
                          · next {shortDate(t.dueDate)}
                          {t.dueMileage != null ? ` or ${miles(t.dueMileage)}` : ""} · {scheduleLabel(t.recurrenceDays, t.recurrenceMiles)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="space-y-1">
                  <h3 className="font-medium opacity-80">Service history</h3>
                  {history.length === 0 ? (
                    <p className="opacity-60">Nothing recorded yet.</p>
                  ) : (
                    <ul className="space-y-1">
                      {history.map((p) => (
                        <li key={p.id}>
                          {p.date ? fullDate(p.date) : (p.period ?? "no date")} · {p.title}
                          {p.vendor ? <span className="opacity-70"> · {p.vendor}</span> : null}
                          {p.amount != null ? <span className="opacity-70"> · {money(p.amount)}</span> : null}
                          {p.transactionId ? <span className="opacity-70"> · payment found</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <form action={checkRecallsFormAction}>
                    <input type="hidden" name="id" value={v.id} />
                    <input type="hidden" name="anchor" value="vehicles" />
                    <SubmitButton className={button} pending="Checking…">
                      Check recalls
                    </SubmitButton>
                  </form>
                  <form action={deleteVehicleFormAction}>
                    <input type="hidden" name="id" value={v.id} />
                    <SubmitButton className={button}>Remove car</SubmitButton>
                  </form>
                </div>
                <RecallList checkedAt={v.recallCheckedAt} recalls={v.recalls} note="NHTSA safety recalls for this make, model and year. Your dealer can confirm which apply to your car." />
                <details>
                  <summary className="cursor-pointer underline">Add a service record</summary>
                  <form action={addProjectFormAction} className="grid gap-2 pt-2 sm:grid-cols-2">
                    <input type="hidden" name="assetId" value={v.id} />
                    <input name="title" required maxLength={120} placeholder="e.g. Oil change, New tires" className={`${input} sm:col-span-2`} />
                    <input name="date" type="date" defaultValue={today} className={input} aria-label="Date" />
                    <input name="vendor" maxLength={120} placeholder="Shop" className={input} />
                    <input name="amount" type="number" min={0} step="0.01" placeholder="Amount $" className={input} />
                    <input name="description" maxLength={1000} placeholder="Notes" className={input} />
                    <SubmitButton className={`${primary} sm:col-span-2`}>Add</SubmitButton>
                  </form>
                </details>
                <details>
                  <summary className="cursor-pointer underline">Edit car</summary>
                  <form action={updateVehicleFormAction} className="grid gap-2 pt-2 sm:grid-cols-2">
                    <input type="hidden" name="id" value={v.id} />
                    <input name="name" required maxLength={80} defaultValue={v.name} className={input} aria-label="Nickname" />
                    <input name="year" type="number" min={1950} max={2100} defaultValue={v.year ?? ""} placeholder="Year" className={input} />
                    <input name="make" maxLength={40} defaultValue={v.make ?? ""} placeholder="Make" className={input} />
                    <input name="model" maxLength={60} defaultValue={v.model ?? ""} placeholder="Model" className={input} />
                    <input name="mileage" type="number" min={0} defaultValue={v.mileage ?? ""} placeholder="Mileage" className={input} />
                    <SubmitButton className={`${primary} sm:col-span-2`}>Save</SubmitButton>
                  </form>
                </details>
              </li>
            );
          })}
        </ul>
        <details className="rounded-xl border p-4" open={vehicles.length === 0}>
          <summary className="cursor-pointer font-medium">Add a car</summary>
          <form action={addVehicleFormAction} className="grid gap-2 pt-3 sm:grid-cols-2">
            <input name="name" required maxLength={80} placeholder="Nickname, e.g. Pavel's car" className={`${input} sm:col-span-2`} />
            <input name="year" type="number" min={1950} max={2100} placeholder="Year" className={input} />
            <input name="make" maxLength={40} placeholder="Make, e.g. Toyota" className={input} />
            <input name="model" maxLength={60} placeholder="Model, e.g. RAV4" className={input} />
            <input name="mileage" type="number" min={0} placeholder="Current mileage" className={input} />
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" name="standardItems" defaultChecked /> Add oil change (5,000 mi or 6 months), state inspection, registration
              renewal and tire rotation (7,500 mi) items
            </label>
            <SubmitButton className={`${primary} sm:col-span-2`}>Add car</SubmitButton>
          </form>
        </details>
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
                    {q.kind === "car" && vehicles.length > 0 ? (
                      <>
                        <select name="vehicleId" required defaultValue={vehicles.length === 1 ? vehicles[0].id : ""} className={`${input} text-sm`} aria-label="Car">
                          <option value="" disabled>
                            Which car?
                          </option>
                          {vehicles.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.name}
                            </option>
                          ))}
                        </select>
                        <SubmitButton className={button}>Add to car history</SubmitButton>
                      </>
                    ) : (
                      <SubmitButton className={button}>Add to house history</SubmitButton>
                    )}
                  </form>
                  <form action={skipQuestionFormAction}>
                    <input type="hidden" name="id" value={q.id} />
                    <SubmitButton className={button}>{q.kind === "car" ? "Not upkeep" : "Not a house expense"}</SubmitButton>
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
              <RecallList checkedAt={a.recallCheckedAt} recalls={a.recalls} note="Check whether your model is listed before acting." />
            </li>
          ))}
        </ul>
        <details className="rounded-xl border p-4">
          <summary className="cursor-pointer font-medium">Add equipment</summary>
          <form action={addAssetFormAction} className="grid gap-2 pt-3 sm:grid-cols-2">
            <input name="name" required maxLength={80} placeholder="Brand and type, e.g. Rheem water heater" className={`${input} sm:col-span-2`} />
            <select name="kind" defaultValue="appliance" className={input} aria-label="Kind">
              {ASSET_KINDS.filter((k) => k !== "vehicle").map((k) => (
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
