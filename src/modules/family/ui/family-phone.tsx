"use client";

import { startTransition, useState } from "react";
import { ChoreBoard, type BoardKidView } from "./chore-board";
import type { KidProgressView } from "./goal-strip";
import { field, tap } from "./kit";
import { PrintTodayButtons } from "./print-today";
import { ReturnsPanel, type MemberReturnTools, type ReturnView } from "./returns-panel";
import { ShoppingPanel, type ShoppingActions, type ShoppingBoard, type ShoppingMemberActions } from "./shopping-panel";
import { UpkeepPanel, type UpkeepView } from "./upkeep-panel";
import type { AgendaDayView } from "./calendar-panel";
import type { EventActions } from "./event-modal";
import { PhoneCalendar } from "./phone-calendar";

type Fn<I, O = void> = (input: I) => Promise<O>;

export type FamilyPhoneActions = {
  setChoreDone: Fn<{ choreId: string; done: boolean }>;
  addOneTimeChore: Fn<{ kidId: string; title: string; icon?: string }>;
  shopping: ShoppingActions;
  shoppingMember: ShoppingMemberActions;
  addReturn: Fn<{ itemName: string; store: string; returnDeadline?: string; notes?: string; orderRef?: string }, { error: string | null }>;
  setReturnStatus: Fn<{ id: string; status: ReturnView["status"] }>;
  completeUpkeep: Fn<{ taskId: string }>;
  addKid: Fn<{ name: string; color?: (typeof KID_COLOR_LIST)[number] }>;
  removeKid: Fn<{ id: string }>;
  /** Make bed, brush teeth, read, tidy room; skips ones the kid already has. */
  addStarterChores: Fn<{ kidId: string }>;
  addChore: Fn<{ kidId: string; title: string; icon: string; recurrence: "daily" | "weekly" | "once"; stars: number }>;
  archiveChore: Fn<{ id: string }>;
  deleteReturn: Fn<{ id: string }>;
  /** Returns found in this member's email, and fill-from-screenshot. */
  memberReturns: MemberReturnTools;
  calendar: EventActions;
  syncCalendar: () => Promise<{ ok: boolean; message: string | null }>;
};

export type PhoneCalendarView = {
  days: AgendaDayView[];
  today: string;
  writableLabel: string | null;
  configured: boolean;
  syncError: string | null;
};

const KID_COLOR_LIST = ["#2563eb", "#db2777", "#16a34a", "#ea580c", "#7c3aed", "#0891b2"] as const;

/** Phone companion (390–430 px): the same lists as the kiosk, plus setup. */
export function FamilyPhone({
  kids,
  shopping,
  stores,
  returns,
  upkeep,
  today,
  todayIso,
  calendar,
  dateLabel,
  printing = false,
  icons,
  actions,
  progress,
}: {
  progress?: Record<string, KidProgressView>;
  kids: BoardKidView[];
  shopping: ShoppingBoard;
  stores: string[];
  returns: ReturnView[];
  upkeep: UpkeepView[];
  today: AgendaDayView | undefined;
  /** Household date, YYYY-MM-DD. */
  todayIso: string;
  calendar: PhoneCalendarView;
  dateLabel: string;
  /** Slip printing is parked until there is a printer. */
  printing?: boolean;
  icons: readonly string[];
  actions: FamilyPhoneActions;
}) {
  const [tab, setTab] = useState<"calendar" | "shopping" | "chores" | "returns" | "upkeep" | "setup">("calendar");
  const tabs = [
    ["calendar", "📅", "Calendar"],
    ["shopping", "🛒", "Shop"],
    ["chores", "⭐", "Chores"],
    ["returns", "📦", "Returns"],
    ["upkeep", "🔧", "Upkeep"],
    ["setup", "⚙️", "Setup"],
  ] as const;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-3 text-slate-900 dark:text-slate-100">
      {printing ? (
        <div className="flex gap-2">
          <PrintTodayButtons className={`${tap} flex-1 border`} dateLabel={dateLabel} kids={kids} today={today} returns={returns} upkeep={upkeep} />
        </div>
      ) : null}
      {kids.length === 0 && tab !== "setup" ? (
        <button type="button" onClick={() => setTab("setup")} className="rounded-xl border-2 border-yellow-300 bg-yellow-50 p-3 text-left text-yellow-950">
          <div className="font-semibold">👋 Add your kids for chores and stars</div>
          <div className="text-sm">Tap here, type a first name, then Add kid. Do it once per kid.</div>
        </button>
      ) : null}
      <nav className="sticky top-0 z-10 grid grid-cols-6 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
        {tabs.map(([key, icon, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`flex min-h-12 flex-col items-center justify-center rounded-lg text-xs ${tab === key ? "bg-white font-semibold shadow dark:bg-slate-900" : ""}`}
          >
            <span className="text-lg">{icon}</span>
            {label}
          </button>
        ))}
      </nav>
      <div className="h-[calc(100dvh-14rem)] min-h-96">
        {tab === "calendar" ? (
          <PhoneCalendar {...calendar} actions={actions.calendar} sync={actions.syncCalendar} />
        ) : tab === "shopping" ? (
          <ShoppingPanel board={shopping} today={todayIso} dateLabel={dateLabel} actions={actions.shopping} member={actions.shoppingMember} printing={printing} />
        ) : tab === "chores" ? (
          <div className="flex h-full flex-col gap-2">
            <a href="/family/progress" className={`${tap} flex items-center justify-center border text-sm`}>
              📈 Progress, goals and rewards
            </a>
            <div className="min-h-0 flex-1">
              <ChoreBoard kids={kids} progress={progress} icons={icons} layout="phone" actions={{ setDone: actions.setChoreDone, addOneTime: actions.addOneTimeChore }} />
            </div>
          </div>
        ) : tab === "returns" ? (
          <ReturnsPanel
            returns={returns}
            stores={stores}
            actions={{ setStatus: actions.setReturnStatus, add: actions.addReturn }}
            member={actions.memberReturns}
            manage={(r) => (
              <button type="button" aria-label="Delete" className={`${tap} px-2 opacity-60`} onClick={() => startTransition(() => actions.deleteReturn({ id: r.id }))}>
                🗑
              </button>
            )}
          />
        ) : tab === "upkeep" ? (
          <div className="flex h-full flex-col gap-2">
            <UpkeepPanel tasks={upkeep} complete={actions.completeUpkeep} />
            <a href="/maintenance" className="text-center text-sm underline">Add or edit upkeep tasks</a>
          </div>
        ) : (
          <Setup kids={kids} icons={icons} actions={actions} />
        )}
      </div>
    </div>
  );
}

function Setup({ kids, icons, actions }: { kids: BoardKidView[]; icons: readonly string[]; actions: FamilyPhoneActions }) {
  const [kidName, setKidName] = useState("");
  const [chore, setChore] = useState({ kidId: kids[0]?.id ?? "", title: "", icon: icons[0], recurrence: "daily" as "daily" | "weekly" | "once", stars: 1 });

  return (
    <div className="h-full space-y-6 overflow-y-auto pb-8">
      <section className="space-y-2">
        <h3 className="text-lg font-semibold">Kids</h3>
        <p className="text-sm opacity-70">First name or nickname only. Each kid gets a chore list, a star bank and goals; prizes are on 📈 Progress.</p>
        <ul className="space-y-1">
          {kids.map((k) => (
            <li key={k.id} className="flex items-center justify-between rounded-lg border p-2">
              <span className="font-semibold" style={{ color: k.color }}>
                {k.emoji} {k.name}
              </span>
              <span className="flex gap-1">
                {k.chores.length === 0 ? (
                  <button type="button" className={`${tap} bg-sky-600 text-sm text-white`} onClick={() => startTransition(() => actions.addStarterChores({ kidId: k.id }))}>
                    ＋ Starter chores
                  </button>
                ) : null}
                <button type="button" className={`${tap} text-sm opacity-70`} onClick={() => startTransition(() => actions.removeKid({ id: k.id }))}>
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!kidName.trim()) return;
            const name = kidName.trim();
            setKidName("");
            startTransition(() => actions.addKid({ name, color: KID_COLOR_LIST[kids.length % KID_COLOR_LIST.length] }));
          }}
        >
          <input className={`${field} min-w-0 flex-1`} placeholder="Name" maxLength={30} value={kidName} onChange={(e) => setKidName(e.target.value)} />
          <button className={`${tap} bg-sky-600 text-white`} type="submit">Add kid</button>
        </form>
      </section>

      {kids.length ? (
        <section className="space-y-2">
          <h3 className="text-lg font-semibold">Chores</h3>
          {kids.map((k) => (
            <div key={k.id} className="space-y-1">
              <div className="text-sm font-semibold" style={{ color: k.color }}>{k.name}</div>
              {k.chores.map((c) => (
                <div key={c.id} className="flex items-center gap-2 rounded-lg border px-2">
                  <span className="text-2xl">{c.icon}</span>
                  <span className="flex-1">{c.title}</span>
                  <span className="text-xs uppercase opacity-60">{c.recurrence} · {c.stars}★</span>
                  <button type="button" className={`${tap} px-2 opacity-60`} aria-label="Remove chore" onClick={() => startTransition(() => actions.archiveChore({ id: c.id }))}>
                    🗑
                  </button>
                </div>
              ))}
            </div>
          ))}
          <form
            className="grid gap-2 rounded-xl border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!chore.title.trim() || !chore.kidId) return;
              const input = { ...chore, title: chore.title.trim() };
              setChore({ ...chore, title: "" });
              startTransition(() => actions.addChore(input));
            }}
          >
            <select className={field} value={chore.kidId} onChange={(e) => setChore({ ...chore, kidId: e.target.value })} aria-label="Kid">
              {kids.map((k) => (
                <option key={k.id} value={k.id}>{k.name}</option>
              ))}
            </select>
            <input className={field} placeholder="Chore (Make bed)" maxLength={60} value={chore.title} onChange={(e) => setChore({ ...chore, title: e.target.value })} />
            <div className="grid grid-cols-8 gap-1">
              {icons.map((i) => (
                <button key={i} type="button" onClick={() => setChore({ ...chore, icon: i })} className={`h-12 rounded-lg text-2xl ${chore.icon === i ? "bg-sky-200 ring-2 ring-sky-500 dark:bg-sky-900" : "bg-slate-100 dark:bg-slate-800"}`}>
                  {i}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <select className={`${field} flex-1`} value={chore.recurrence} onChange={(e) => setChore({ ...chore, recurrence: e.target.value as typeof chore.recurrence })} aria-label="Repeats">
                <option value="daily">Every day</option>
                <option value="weekly">Once a week</option>
                <option value="once">Just once</option>
              </select>
              <select className={field} value={chore.stars} onChange={(e) => setChore({ ...chore, stars: Number(e.target.value) })} aria-label="Stars">
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>{n} ★</option>
                ))}
              </select>
            </div>
            <button className={`${tap} bg-sky-600 text-white`} type="submit">Add chore</button>
          </form>
        </section>
      ) : null}

      <section className="space-y-1">
        <h3 className="text-lg font-semibold">Shopping templates</h3>
        <p className="text-sm opacity-70">Templates start new lists (Shop tab, ＋ List). Save any list as one from its ⋯ menu; delete them at the bottom of the Shop tab.</p>
      </section>
    </div>
  );
}
