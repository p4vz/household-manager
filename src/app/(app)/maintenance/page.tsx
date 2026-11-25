import { requireUserOrRedirect } from "@/core/auth/guard";
import { householdToday, relativeDue, shortDate } from "@/modules/family/ui/dates";
import { ASSET_KIND_LABELS, listAssets, listOpenTasks } from "@/modules/maintenance/api";
import { completeTaskAction, deleteTaskAction, scheduleTaskAction } from "./actions";

const PRESETS: [string, number][] = [
  ["HVAC filter", 90],
  ["Humidifier pad", 30],
  ["Smoke detector test", 180],
  ["Gutter cleaning", 180],
  ["Water heater flush", 365],
];

/** House upkeep: open tasks, repeating ones, and a quick add form. Shown on the kitchen kiosk too. */
export default async function MaintenancePage() {
  await requireUserOrRedirect();
  const today = householdToday();
  const [tasks, assets] = await Promise.all([listOpenTasks(), listAssets()]);

  async function addTask(form: FormData) {
    "use server";
    await scheduleTaskAction(Object.fromEntries(form));
  }
  async function markDone(form: FormData) {
    "use server";
    await completeTaskAction({ taskId: form.get("taskId"), date: form.get("date"), actualCost: form.get("actualCost") });
  }
  async function dropTask(form: FormData) {
    "use server";
    await deleteTaskAction({ taskId: form.get("taskId") });
  }

  return (
    <section className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Home maintenance</h1>

      <form action={addTask} className="grid gap-3 rounded-xl border p-4 sm:grid-cols-2">
        <h2 className="font-medium sm:col-span-2">Add an upkeep task</h2>
        <input name="title" required maxLength={80} list="upkeep-presets" placeholder="Task (HVAC filter)" className="min-h-12 rounded-lg border bg-transparent px-3 sm:col-span-2" />
        <datalist id="upkeep-presets">
          {PRESETS.map(([t]) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <label className="grid gap-1 text-sm">
          Due
          <input name="dueDate" type="date" required defaultValue={today} className="min-h-12 rounded-lg border bg-transparent px-3" />
        </label>
        <label className="grid gap-1 text-sm">
          Repeat every (days, blank for one-off)
          <input name="recurrenceDays" type="number" min={1} max={3650} placeholder="90" className="min-h-12 rounded-lg border bg-transparent px-3" />
        </label>
        <label className="grid gap-1 text-sm">
          Estimated cost ($)
          <input name="estimatedCost" type="number" min={0} step="0.01" className="min-h-12 rounded-lg border bg-transparent px-3" />
        </label>
        <label className="grid gap-1 text-sm">
          Notes
          <input name="notes" maxLength={300} placeholder="Filter size 16x25x1" className="min-h-12 rounded-lg border bg-transparent px-3" />
        </label>
        <button type="submit" className="min-h-12 rounded-lg bg-foreground px-4 text-background sm:col-span-2">Add task</button>
        <p className="text-xs opacity-60 sm:col-span-2">
          Common intervals: {PRESETS.map(([t, d]) => `${t} ${d} days`).join(", ")}.
        </p>
      </form>

      <ul className="space-y-2">
        {tasks.length === 0 ? <li className="opacity-60">No open tasks.</li> : null}
        {tasks.map((t) => (
          <li key={t.id} className={`space-y-2 rounded-xl border p-4 ${t.dueDate < today ? "border-red-500" : ""}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{t.title}</span>
              <span className={`text-sm ${t.dueDate < today ? "font-semibold text-red-600" : "opacity-70"}`}>
                {shortDate(t.dueDate)} ({relativeDue(today, t.dueDate)})
                {t.recurrenceDays ? ` · every ${t.recurrenceDays} days` : ""}
                {t.estimatedCost != null ? ` · est. $${t.estimatedCost.toFixed(2)}` : ""}
              </span>
            </div>
            {t.notes ? <p className="text-sm opacity-70">{t.notes}</p> : null}
            <div className="flex flex-wrap gap-2">
              <form action={markDone} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="taskId" value={t.id} />
                <input type="date" name="date" defaultValue={today} className="min-h-12 rounded-lg border bg-transparent px-2 text-sm" aria-label="Done on" />
                <input type="number" name="actualCost" min={0} step="0.01" placeholder="Cost $" className="min-h-12 w-24 rounded-lg border bg-transparent px-2 text-sm" />
                <button type="submit" className="min-h-12 rounded-lg bg-emerald-600 px-4 text-white">Done</button>
              </form>
              <form action={dropTask}>
                <input type="hidden" name="taskId" value={t.id} />
                <button type="submit" className="min-h-12 rounded-lg border px-4 text-sm">Delete</button>
              </form>
            </div>
          </li>
        ))}
      </ul>

      <div className="space-y-2">
        <h2 className="font-medium">Home equipment</h2>
        {assets.length === 0 ? (
          <p className="text-sm opacity-60">
            Nothing listed yet. Answer the large-purchase questions in the{" "}
            <a className="underline" href="/finance/review#large">Finance review</a>, or ask Claude to add the furnace, water heater or roof.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {assets.map((a) => (
              <li key={a.id} className="rounded-lg border px-3 py-2">
                <span className="font-medium">{a.name}</span>
                <span className="opacity-70">
                  {" "}
                  · {ASSET_KIND_LABELS[a.kind]}
                  {a.location ? ` · ${a.location}` : ""}
                  {a.installedOn ? ` · since ${shortDate(a.installedOn)}` : ""}
                  {a.cost != null ? ` · $${a.cost.toFixed(2)}` : ""}
                </span>
                {a.notes ? <p className="opacity-70">{a.notes}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
