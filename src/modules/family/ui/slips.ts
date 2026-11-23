import { blank, center, checkbox, columns, divider, text, type ReceiptLine } from "@/lib/thermal/receipt";

/** The three printed slips, as receipt lines. Pure. */
export function shoppingSlip(store: string, items: { name: string; quantity: string | null }[], dateLabel: string): ReceiptLine[] {
  return [
    center(store, { bold: true, large: true }),
    center(dateLabel),
    divider("="),
    ...(items.length ? items.map((i) => checkbox(i.quantity ? `${i.name} (${i.quantity})` : i.name)) : [text("Nothing on the list.")]),
    divider(),
    center(`${items.length} item${items.length === 1 ? "" : "s"}`),
  ];
}

export function choreSlip(kids: { name: string; chores: { title: string; done: boolean; recurrence: string }[] }[], dateLabel: string): ReceiptLine[] {
  const out: ReceiptLine[] = [center("CHORES", { bold: true, large: true }), center(dateLabel), divider("=")];
  for (const kid of kids) {
    out.push(center(kid.name, { bold: true, large: true }));
    const shown = kid.chores;
    if (!shown.length) out.push(text("No chores today!"));
    for (const c of shown) out.push(checkbox(c.recurrence === "weekly" ? `${c.title} (this week)` : c.title, c.done));
    out.push(blank());
  }
  out.push(divider(), center("Great job!"));
  return out;
}

export function agendaSlip(input: {
  dateLabel: string;
  events: { timeLabel: string; title: string; location: string | null }[];
  returns: { itemName: string; store: string; deadlineLabel: string | null; status: string }[];
  upkeep: { title: string; dueLabel: string }[];
}): ReceiptLine[] {
  const out: ReceiptLine[] = [center("TODAY", { bold: true, large: true }), center(input.dateLabel), divider("=")];
  out.push(center("Agenda", { bold: true }));
  if (!input.events.length) out.push(text("Nothing on the calendar."));
  for (const e of input.events) {
    out.push(text(`${e.timeLabel}`), checkbox(e.location ? `${e.title} @ ${e.location}` : e.title));
  }
  out.push(divider(), center("Errands & returns", { bold: true }));
  if (!input.returns.length && !input.upkeep.length) out.push(text("No errands."));
  for (const r of input.returns) {
    out.push(checkbox(`Return ${r.itemName} to ${r.store}${r.status === "packed_in_car" ? " (in car)" : ""}`));
    if (r.deadlineLabel) out.push(columns("", `by ${r.deadlineLabel}`));
  }
  for (const u of input.upkeep) out.push(checkbox(`${u.title} (${u.dueLabel})`));
  return out;
}
