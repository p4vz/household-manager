"use client";

import { PrintSlipButton } from "./print-slip";
import { agendaSlip, choreSlip } from "./slips";
import type { AgendaDayView } from "./calendar-panel";
import type { BoardKidView } from "./chore-board";
import type { ReturnView } from "./returns-panel";
import type { UpkeepView } from "./upkeep-panel";

/** "Print chores" and "Print today" slips (kids' chore slip; agenda + errands + returns). */
export function PrintTodayButtons({
  dateLabel,
  kids,
  today,
  returns,
  upkeep,
  className,
}: {
  dateLabel: string;
  kids: BoardKidView[];
  today: AgendaDayView | undefined;
  returns: ReturnView[];
  upkeep: UpkeepView[];
  className?: string;
}) {
  return (
    <>
      <PrintSlipButton
        label="Chores"
        className={className}
        lines={() => choreSlip(kids.map((k) => ({ name: k.name, chores: k.chores })), dateLabel)}
      />
      <PrintSlipButton
        label="Today"
        className={className}
        lines={() =>
          agendaSlip({
            dateLabel,
            events: (today?.items ?? []).map((e) => ({ timeLabel: e.timeLabel, title: e.title, location: e.location })),
            returns: returns.filter((r) => r.status !== "returned").map((r) => ({ itemName: r.itemName, store: r.store, deadlineLabel: r.deadlineLabel, status: r.status })),
            upkeep: upkeep.map((u) => ({ title: u.title, dueLabel: u.dueLabel })),
          })
        }
      />
    </>
  );
}
