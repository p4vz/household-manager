import { Button } from "@/components/ui/button";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { budgetOverview, viewerFromLabel } from "@/modules/finance/api";
import { BudgetTable } from "@/modules/finance/ui/budget-table";
import {
  acceptAllBudgetsAction,
  acceptBudgetAction,
  budgetOptionsAction,
  overrideBudgetAction,
  removeBudgetAction,
} from "../actions";

export default async function BudgetPage() {
  const viewer = viewerFromLabel((await requireUserOrRedirect()).owner);
  const { options, month, rows } = await budgetOverview(viewer);
  return (
    <section className="max-w-4xl space-y-6">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Budget · {month}</h1>
          <p className="text-sm text-muted-foreground">
            Your budget: targets come from your last {options.basis} complete months of spending on joint accounts and your own.
          </p>
        </div>
        <form action={budgetOptionsAction} className="ml-auto flex items-center gap-3 text-sm">
          <select name="basis" defaultValue={options.basis} className="h-8 rounded-md border bg-background px-2">
            <option value={3}>3-month average</option>
            <option value={6}>6-month average</option>
          </select>
          <label className="flex items-center gap-1">
            <input type="checkbox" name="excludeOutliers" defaultChecked={options.excludeOutliers} /> Ignore spikes
          </label>
          <Button size="sm" variant="outline">Apply</Button>
        </form>
        <form action={acceptAllBudgetsAction}>
          <Button size="sm">Accept all suggestions</Button>
        </form>
      </div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground">No spending history yet. Connect SimpleFIN or import Simplifi history first.</p>
      ) : (
        <BudgetTable rows={rows} basis={options.basis} accept={acceptBudgetAction} override={overrideBudgetAction} remove={removeBudgetAction} />
      )}
    </section>
  );
}
