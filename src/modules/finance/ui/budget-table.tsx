import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn, formatMoney } from "@/lib/utils";

type Row = {
  category: string;
  suggestion: { suggested: number; average: number; excludedMonth: string | null; months: { month: string; spend: number }[] } | null;
  budget: { limit: number; source: "auto" | "manual" } | null;
  spent: number;
  status: "ok" | "warning" | "over" | null;
  pct: number | null;
};

const FILL = { ok: "bg-primary", warning: "bg-warning", over: "bg-destructive" } as const;

/** Server-rendered budget rows; each row posts to the given server actions. */
export function BudgetTable(props: {
  rows: Row[];
  basis: number;
  accept: (form: FormData) => Promise<void>;
  override: (form: FormData) => Promise<void>;
  remove: (form: FormData) => Promise<void>;
}) {
  return (
    <ul className="divide-y rounded-xl border">
      {props.rows.map((r) => (
        <li key={r.category} className="space-y-2 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-medium">{r.category}</span>
            {r.budget ? (
              <Badge variant={r.budget.source === "manual" ? "outline" : "secondary"}>
                {r.budget.source === "manual" ? "Manual" : "Auto"}
              </Badge>
            ) : null}
            {r.status === "warning" ? <Badge variant="warning">80%+</Badge> : null}
            {r.status === "over" ? <Badge variant="destructive">Over</Badge> : null}
            <span className="ml-auto text-sm tabular-nums">
              {formatMoney(r.spent)} {r.budget ? `of ${formatMoney(r.budget.limit)}` : "spent"}
            </span>
          </div>
          {r.budget ? (
            <Progress value={(r.pct ?? 0) * 100} indicatorClassName={FILL[r.status ?? "ok"]} />
          ) : null}
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            {r.suggestion ? (
              <span title={r.suggestion.months.map((m) => `${m.month}: ${formatMoney(m.spend)}`).join("\n")}>
                Suggested {formatMoney(r.suggestion.suggested)} ({props.basis}-mo avg {formatMoney(r.suggestion.average)}
                {r.suggestion.excludedMonth ? `, ignoring spike in ${r.suggestion.excludedMonth}` : ""})
              </span>
            ) : (
              <span>No recent spending</span>
            )}
            {r.suggestion && r.budget?.limit !== r.suggestion.suggested ? (
              <form action={props.accept}>
                <input type="hidden" name="category" value={r.category} />
                <input type="hidden" name="limit" value={r.suggestion.suggested} />
                <Button size="sm" variant="outline">Accept</Button>
              </form>
            ) : null}
            <form action={props.override} className="flex items-center gap-1">
              <input type="hidden" name="category" value={r.category} />
              <input
                name="limit"
                type="number"
                min="0"
                step="1"
                placeholder="Override"
                className={cn("h-8 w-24 rounded-md border bg-background px-2")}
              />
              <Button size="sm" variant="ghost">Set</Button>
            </form>
            {r.budget ? (
              <form action={props.remove}>
                <input type="hidden" name="category" value={r.category} />
                <Button size="sm" variant="ghost">Remove</Button>
              </form>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
