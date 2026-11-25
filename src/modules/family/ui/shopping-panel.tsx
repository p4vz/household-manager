"use client";

import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ErrorNote, Modal, field, tap } from "./kit";
import { PrintSlipButton } from "./print-slip";
import {
  addItem,
  allLists,
  dayLabel,
  deferLocal,
  moveItem,
  nudge,
  openCount,
  orderLists,
  orderStores,
  plusDays,
  flatListTitle,
  isWeeklyList,
  nextWeekStart,
  removeLocal,
  sectionOfItem,
  toggleItem,
  type ShoppingBoard,
  type ShoppingList,
  type ShoppingSection,
} from "./shopping-board";
import { shoppingSlip } from "./slips";

export type { ShoppingBoard };

type Fn<I> = (input: I) => Promise<ShoppingBoard>;

/** Actions the kiosk may run (shopping-actions.ts). */
export type ShoppingActions = {
  sync: (input: { since: number }) => Promise<ShoppingBoard | null>;
  add: Fn<{ name: string; store: string; listId?: string }>;
  setChecked: Fn<{ id: string; checked: boolean }>;
  moveItem: Fn<{ id: string; sectionId: string; index: number }>;
  createList: Fn<{ name?: string; templateId?: string }>;
  renameList: Fn<{ id: string; name: string }>;
  deferList: Fn<{ id: string; until: string | null }>;
  reorderLists: Fn<{ ids: string[] }>;
  addStore: Fn<{ listId: string; store: string }>;
  reorderStores: Fn<{ listId: string; sectionIds: string[] }>;
  saveTemplate: Fn<{ listId: string; name: string }>;
};

/** Deletions, for signed-in members only (the phone view). */
export type ShoppingMemberActions = {
  deleteItem: Fn<{ id: string }>;
  removeStore: Fn<{ id: string }>;
  deleteList: Fn<{ id: string }>;
  deleteTemplate: Fn<{ id: string }>;
};

const POLL_MS = 3_000;

// ------------------------------------------------------- board state ----

/**
 * The board on screen: changes show at once (optimistic), the server's answer
 * replaces them, and every 3 s the screen asks whether anything changed
 * elsewhere (one row read when nothing did).
 */
function useShoppingBoard(initial: ShoppingBoard, sync: ShoppingActions["sync"]) {
  const [board, setBoard] = useState(initial);
  const [seen, setSeen] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(0);
  const revision = useRef(initial.revision);
  useEffect(() => {
    revision.current = board.revision;
  }, [board.revision]);

  // A fresher server render (page refresh) wins over what is on screen.
  if (initial !== seen) {
    setSeen(initial);
    if (initial.revision > board.revision) setBoard(initial);
  }

  const pull = useCallback(
    async (force = false) => {
      if (pending.current > 0) return;
      try {
        const next = await sync({ since: force ? -1 : revision.current });
        if (next && pending.current === 0) setBoard(next);
      } catch {
        // Offline or the server is restarting: try again on the next tick.
      }
    },
    [sync],
  );

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible" && navigator.onLine) void pull();
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("online", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("online", tick);
    };
  }, [pull]);

  const run = useCallback(
    async (optimistic: (b: ShoppingBoard) => ShoppingBoard, call: () => Promise<ShoppingBoard>) => {
      pending.current += 1;
      setError(null);
      setBoard(optimistic);
      try {
        const next = await call();
        pending.current -= 1;
        // With several taps in flight, only the last answer has them all.
        if (pending.current === 0) setBoard(next);
      } catch {
        pending.current -= 1;
        setError("That didn't save. Try again.");
        void pull(true);
      }
    },
    [pull],
  );

  /** While a drag is under way: show moves locally and skip polling. */
  const hold = useCallback((on: boolean) => {
    pending.current += on ? 1 : -1;
  }, []);

  return { board, run, error, setLocal: setBoard, hold };
}

// ----------------------------------------------- collapsed (per device) ----

const COLLAPSE_KEY = "hm.shopping.collapsed";
const collapseListeners = new Set<() => void>();

function readCollapsed(): string {
  try {
    return localStorage.getItem(COLLAPSE_KEY) ?? "";
  } catch {
    return "";
  }
}

function useCollapsed() {
  const raw = useSyncExternalStore(
    (cb) => {
      collapseListeners.add(cb);
      return () => collapseListeners.delete(cb);
    },
    readCollapsed,
    () => "",
  );
  const set = useMemo(() => new Set(raw.split(",").filter(Boolean)), [raw]);
  const toggle = useCallback(
    (id: string) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSE_KEY, [...next].slice(-200).join(","));
      } catch {
        // Private mode: collapsing just won't be remembered.
      }
      collapseListeners.forEach((l) => l());
    },
    [set],
  );
  return { isCollapsed: (id: string) => set.has(id), toggle };
}

// -------------------------------------------------------------- panel ----

type DragData = { type: "item"; sectionId: string } | { type: "section-drop"; sectionId: string } | { type: "store"; listId: string };

/**
 * Shopping lists, one below the other. Each list holds stores (drag by the
 * ⠿ handle or use the arrows; tap the name to fold), each store holds item
 * tiles: tap to tick, press and hold to drag to another spot or store.
 * Ticking an item ticks it on every list. A list can be saved as a template
 * or put off until a later date.
 */
export function ShoppingPanel({
  board: initial,
  actions,
  member,
  dateLabel,
  today,
  expandable = false,
  printing = false,
}: {
  board: ShoppingBoard;
  actions: ShoppingActions;
  /** Phone view (signed-in member): delete controls. */
  member?: ShoppingMemberActions;
  dateLabel: string;
  /** Household date, YYYY-MM-DD. */
  today: string;
  /** Kiosk: offer a full-screen view. */
  expandable?: boolean;
  /** Per-store slip buttons (parked until there is a printer). */
  printing?: boolean;
}) {
  const { board, run, error, setLocal, hold } = useShoppingBoard(initial, actions.sync);
  const collapsed = useCollapsed();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [newList, setNewList] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [laterOpen, setLaterOpen] = useState(false);
  const [dragging, setDragging] = useState<{ id: string; type: DragData["type"] } | null>(null);
  const snapshot = useRef<ShoppingBoard | null>(null);
  const dragFrom = useRef<string | null>(null);
  const lastDragEnd = useRef(0);
  const dndId = useId(); // stable ids for dnd-kit's aria attributes, so hydration matches

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
  );

  const collision: CollisionDetection = useCallback((args) => {
    const type = (args.active.data.current as DragData | undefined)?.type;
    const listId = type === "store" ? (args.active.data.current as { listId: string }).listId : null;
    const droppableContainers = args.droppableContainers.filter((c) => {
      const d = c.data.current as DragData | undefined;
      if (type === "store") return d?.type === "store" && d.listId === listId;
      return d?.type === "item" || d?.type === "section-drop";
    });
    const within = pointerWithin({ ...args, droppableContainers });
    if (within.length) {
      // A tile under the finger beats the store box around it.
      const tile = within.find((c) => (droppableContainers.find((d) => d.id === c.id)?.data.current as DragData | undefined)?.type !== "section-drop");
      return tile ? [tile] : within;
    }
    return closestCenter({ ...args, droppableContainers });
  }, []);

  // ------------------------------------------------------------ actions ----

  const toggle = (id: string, checked: boolean) => {
    if (Date.now() - lastDragEnd.current < 300) return;
    void run((b) => toggleItem(b, id, checked), () => actions.setChecked({ id, checked }));
  };
  const add = (input: { name: string; store: string; listId: string }) =>
    void run((b) => addItem(b, input, `tmp-${Math.random().toString(36).slice(2)}`), () => actions.add(input));
  const storesUp = (list: ShoppingList, sectionId: string, delta: -1 | 1) => {
    const ids = nudge(
      list.sections.map((s) => s.id),
      sectionId,
      delta,
    );
    void run((b) => orderStores(b, list.id, ids), () => actions.reorderStores({ listId: list.id, sectionIds: ids }));
  };
  const listsUp = (listId: string, delta: -1 | 1) => {
    const ids = nudge(
      board.lists.map((l) => l.id),
      listId,
      delta,
    );
    void run((b) => orderLists(b, ids), () => actions.reorderLists({ ids }));
  };

  // --------------------------------------------------------------- drag ----

  function onDragStart(e: DragStartEvent) {
    const d = e.active.data.current as DragData;
    snapshot.current = board;
    dragFrom.current = d.type === "item" ? d.sectionId : null;
    hold(true);
    setDragging({ id: String(e.active.id), type: d.type });
  }

  function onDragOver(e: DragOverEvent) {
    const a = e.active.data.current as DragData;
    const o = e.over?.data.current as DragData | undefined;
    if (a.type !== "item" || !o || o.type === "store") return;
    const id = String(e.active.id);
    const current = sectionOfItem(board, id);
    if (!current || current.id === o.sectionId) return;
    // Show the tile in the store it is over, at the spot under the finger.
    const target = allLists(board)
      .flatMap((l) => l.sections)
      .find((s) => s.id === o.sectionId);
    if (!target) return;
    const open = target.items.filter((i) => !i.checked);
    const at = o.type === "item" ? Math.max(0, open.findIndex((i) => i.id === e.over!.id)) : open.length;
    setLocal((b) => moveItem(b, id, o.sectionId, at));
  }

  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    hold(false);
    lastDragEnd.current = Date.now();
    const a = e.active.data.current as DragData;
    const over = e.over;
    const id = String(e.active.id);
    if (!over) return restore();

    if (a.type === "store") {
      const list = allLists(board).find((l) => l.id === a.listId);
      if (!list || over.id === e.active.id) return;
      const ids = list.sections.map((s) => `store:${s.id}`);
      const next = arrayMove(ids, ids.indexOf(id), ids.indexOf(String(over.id))).map((x) => x.slice(6));
      void run((b) => orderStores(b, list.id, next), () => actions.reorderStores({ listId: list.id, sectionIds: next }));
      return;
    }

    const section = sectionOfItem(board, id);
    if (!section) return;
    const open = section.items.filter((i) => !i.checked).map((i) => i.id);
    let order = open;
    const o = over.data.current as DragData | undefined;
    if (o?.type === "item" && o.sectionId === section.id && over.id !== id && open.includes(String(over.id))) {
      order = arrayMove(open, open.indexOf(id), open.indexOf(String(over.id)));
    }
    const index = Math.max(0, order.indexOf(id));
    const before = snapshot.current;
    const unchanged = dragFrom.current === section.id && before && sectionOfItem(before, id)?.items.filter((i) => !i.checked).map((i) => i.id).indexOf(id) === index;
    snapshot.current = null;
    if (unchanged) return;
    void run((b) => moveItem(b, id, section.id, index), () => actions.moveItem({ id, sectionId: section.id, index }));
  }

  function restore() {
    const before = snapshot.current;
    snapshot.current = null;
    if (before) setLocal(before);
  }

  function onDragCancel() {
    setDragging(null);
    hold(false);
    restore();
  }

  const draggedItem = dragging?.type === "item" ? allLists(board).flatMap((l) => l.sections.flatMap((s) => s.items)).find((i) => i.id === dragging.id) : null;
  const draggedStore = dragging?.type === "store" ? allLists(board).flatMap((l) => l.sections).find((s) => `store:${s.id}` === dragging.id) : null;
  const menuList = allLists(board).find((l) => l.id === menuFor) ?? null;

  return (
    <div
      className={
        expanded
          ? "fixed inset-4 z-30 flex flex-col gap-2 rounded-2xl bg-white p-4 text-slate-900 shadow-2xl"
          : "flex h-full min-h-0 flex-col gap-2"
      }
    >
      <QuickAdd board={board} onAdd={add} onNewList={() => setNewList(true)}>
        {member ? (
          <button type="button" className={`${compactTap} border ${editing ? "bg-slate-900 text-white" : ""}`} onClick={() => setEditing(!editing)} aria-pressed={editing} aria-label={editing ? "Done editing" : "Edit lists"} title={editing ? "Done editing" : "Edit lists"}>
            {editing ? "Done" : "✎"}
          </button>
        ) : null}
        {expandable ? (
          <button type="button" className={`${compactTap} border`} onClick={() => setExpanded(!expanded)} aria-label={expanded ? "Shrink" : "Full screen"}>
            {expanded ? "✕" : "⤢"}
          </button>
        ) : null}
      </QuickAdd>
      <ErrorNote error={error} />

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pb-2">
        {board.lists.length === 0 ? (
          <div className="space-y-3 rounded-xl border border-dashed border-slate-300 p-4 text-center">
            <p className="opacity-70">No lists right now. Start one:</p>
            <TemplateButtons board={board} onPick={(templateId) => void run((b) => b, () => actions.createList({ templateId }))} />
            <button type="button" className={`${tap} border`} onClick={() => setNewList(true)}>
              ＋ Blank list
            </button>
          </div>
        ) : null}

        <DndContext id={dndId} sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
          {board.lists.map((list, li) => (
            <ListCard
              key={list.id}
              list={list}
              collapsed={collapsed.isCollapsed(list.id)}
              onToggle={() => collapsed.toggle(list.id)}
              onUp={li > 0 ? () => listsUp(list.id, -1) : undefined}
              onDown={li < board.lists.length - 1 ? () => listsUp(list.id, 1) : undefined}
              onMenu={() => setMenuFor(list.id)}
              flat={list.sections.length === 1 && !editing}
              onDismissWeek={
                isWeeklyList(list.name) ? () => void run((b) => deferLocal(b, list.id, nextWeekStart(today), today), () => actions.deferList({ id: list.id, until: nextWeekStart(today) })) : undefined
              }
            >
              <SortableContext items={list.sections.map((s) => `store:${s.id}`)} strategy={verticalListSortingStrategy}>
                {list.sections.map((s, si) => (
                  <StoreSection
                    key={s.id}
                    list={list}
                    section={s}
                    collapsed={collapsed.isCollapsed(s.id)}
                    onToggle={() => collapsed.toggle(s.id)}
                    onUp={si > 0 ? () => storesUp(list, s.id, -1) : undefined}
                    onDown={si < list.sections.length - 1 ? () => storesUp(list, s.id, 1) : undefined}
                    onCheck={toggle}
                    onAdd={(name) => add({ name, store: s.store, listId: list.id })}
                    dateLabel={dateLabel}
                    printing={printing}
                    editing={editing}
                    onDeleteItem={member ? (id) => void run((b) => removeLocal(b, { itemId: id }), () => member.deleteItem({ id })) : undefined}
                    onRemove={member ? () => void run((b) => removeLocal(b, { sectionId: s.id }), () => member.removeStore({ id: s.id })) : undefined}
                    draggingId={dragging?.id ?? null}
                    bare={list.sections.length === 1 && !editing}
                  />
                ))}
              </SortableContext>
              {list.sections.length === 0 ? <p className="p-2 text-sm opacity-60">No stores yet. Use ⋯ to add one.</p> : null}
            </ListCard>
          ))}
          {dragging
            ? // In a portal: the kiosk frame is transformed, which would throw a fixed overlay off the finger.
              createPortal(
                <DragOverlay dropAnimation={null}>
                  {draggedItem ? <div className="flex min-h-14 items-center rounded-xl border-2 border-sky-500 bg-white px-3 text-lg font-medium text-slate-900 shadow-2xl">{draggedItem.name}</div> : null}
                  {draggedStore ? <div className="rounded-xl border-2 border-sky-500 bg-white px-4 py-3 text-lg font-bold text-slate-900 shadow-2xl">{draggedStore.store}</div> : null}
                </DragOverlay>,
                document.body,
              )
            : null}
        </DndContext>

        {board.deferred.length ? (
          <section className="rounded-xl border border-slate-200 bg-slate-50 p-2">
            <button type="button" className="flex min-h-12 w-full items-center gap-2 text-left font-semibold" onClick={() => setLaterOpen(!laterOpen)} aria-expanded={laterOpen}>
              <span className="w-6">{laterOpen ? "▾" : "▸"}</span>
              Later <span className="rounded-full bg-slate-200 px-2 text-sm">{board.deferred.length}</span>
            </button>
            {laterOpen ? (
              <ul className="space-y-1">
                {board.deferred.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-white p-2">
                    <span className="flex-1">
                      <span className="font-medium">{l.name}</span>
                      <span className="opacity-60">
                        {" "}
                        · back {dayLabel(l.deferredUntil!)} · {l.sections.reduce((n, s) => n + openCount(s), 0)} items
                      </span>
                    </span>
                    <button type="button" className={`${tap} border text-sm`} onClick={() => setMenuFor(l.id)}>
                      ⋯
                    </button>
                    <button type="button" className={`${tap} bg-sky-600 text-sm text-white`} onClick={() => void run((b) => deferLocal(b, l.id, null, today), () => actions.deferList({ id: l.id, until: null }))}>
                      Bring back now
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {member && board.templates.length ? (
          <TemplatesCard board={board} onDelete={(id) => void run((b) => ({ ...b, templates: b.templates.filter((t) => t.id !== id) }), () => member.deleteTemplate({ id }))} />
        ) : null}
      </div>

      {newList ? (
        <NewListModal
          board={board}
          onClose={() => setNewList(false)}
          onCreate={(input) => {
            setNewList(false);
            void run((b) => b, () => actions.createList(input));
          }}
        />
      ) : null}

      {menuList ? (
        <ListMenu
          list={menuList}
          stores={board.stores}
          today={today}
          onClose={() => setMenuFor(null)}
          onRename={(name) => void run((b) => b, () => actions.renameList({ id: menuList.id, name }))}
          onAddStore={(store) => void run((b) => b, () => actions.addStore({ listId: menuList.id, store }))}
          onSaveTemplate={(name) => void run((b) => b, () => actions.saveTemplate({ listId: menuList.id, name }))}
          onDefer={(until) => void run((b) => deferLocal(b, menuList.id, until, today), () => actions.deferList({ id: menuList.id, until }))}
          onDelete={member ? () => void run((b) => removeLocal(b, { listId: menuList.id }), () => member.deleteList({ id: menuList.id })) : undefined}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------- quick add ----

/** The add row sits in a narrow kiosk panel: one line, still 44 px touch targets. */
const compactTap = "min-h-11 min-w-11 shrink-0 rounded-lg px-2.5 text-sm font-medium active:scale-95 transition-transform select-none";
const compactField = "min-h-11 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100";

function QuickAdd({ board, onAdd, onNewList, children }: { board: ShoppingBoard; onAdd: (i: { name: string; store: string; listId: string }) => void; onNewList: () => void; children?: ReactNode }) {
  const [name, setName] = useState("");
  const [store, setStore] = useState("");
  const [listId, setListId] = useState("");
  const list = board.lists.find((l) => l.id === listId) ?? board.lists[0];
  const storeValue = store || list?.sections[0]?.store || board.stores[0] || "";
  return (
    <form
      className="flex min-w-0 flex-wrap items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        const n = name.trim();
        const s = storeValue.trim();
        if (!n || !s || !list) return;
        setName("");
        onAdd({ name: n, store: s, listId: list.id });
      }}
    >
      <input className={`${compactField} min-w-0 flex-[2_1_9rem]`} placeholder="Add item…" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} disabled={!list} />
      <input className={`${compactField} min-w-0 flex-[1_1_7.5rem]`} list="shopping-stores" placeholder="Store" aria-label="Store" value={storeValue} maxLength={40} onChange={(e) => setStore(e.target.value)} disabled={!list} />
      <datalist id="shopping-stores">
        {board.stores.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      {board.lists.length > 1 ? (
        <select className={`${compactField} min-w-0 flex-[1_1_9rem]`} value={list?.id} onChange={(e) => setListId(e.target.value)} aria-label="List">
          {board.lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      ) : null}
      <button type="submit" className={`${compactTap} bg-sky-600 text-white`} disabled={!list}>
        Add
      </button>
      <button type="button" className={`${compactTap} border`} onClick={onNewList} aria-label="New list" title="New list">
        ＋
      </button>
      {children}
    </form>
  );
}

// ---------------------------------------------------------------- list ----

function ListCard({
  list,
  collapsed,
  onToggle,
  onUp,
  onDown,
  onMenu,
  flat,
  onDismissWeek,
  children,
}: {
  list: ShoppingList;
  collapsed: boolean;
  onToggle: () => void;
  onUp?: () => void;
  onDown?: () => void;
  onMenu: () => void;
  /** One store: its items sit right under the list, with no store header. */
  flat: boolean;
  /** Weekly lists: hide until next Monday. */
  onDismissWeek?: () => void;
  children: ReactNode;
}) {
  const left = list.sections.reduce((n, s) => n + openCount(s), 0);
  const title = flat ? flatListTitle(list.name, list.sections[0].store) : list.name;
  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50 p-1.5">
      <div className="flex items-center gap-1">
        <button type="button" onClick={onToggle} aria-expanded={!collapsed} className="flex min-h-10 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1 text-left">
          <span className="w-4 text-sm">{collapsed ? "▸" : "▾"}</span>
          <span className="truncate text-base font-bold">{title}</span>
          <span className="shrink-0 rounded-full bg-slate-200 px-1.5 text-xs">{left}</span>
        </button>
        {onDismissWeek ? (
          <button type="button" className="min-h-10 shrink-0 rounded-lg border border-slate-300 bg-white px-2 text-xs font-medium active:scale-95" onClick={onDismissWeek}>
            Dismiss for this week
          </button>
        ) : null}
        <Arrows onUp={onUp} onDown={onDown} label={title} />
        <button type="button" className="flex h-10 w-9 shrink-0 items-center justify-center rounded-lg text-lg active:scale-95" onClick={onMenu} aria-label={`${title} options`}>
          ⋯
        </button>
      </div>
      {collapsed ? null : <div className="mt-1 space-y-1.5">{children}</div>}
    </section>
  );
}

function Arrows({ onUp, onDown, label }: { onUp?: () => void; onDown?: () => void; label: string }) {
  const btn = "flex h-10 w-8 items-center justify-center rounded-lg text-sm active:scale-95 disabled:opacity-20";
  return (
    <span className="flex">
      <button type="button" className={btn} onClick={onUp} disabled={!onUp} aria-label={`Move ${label} up`}>
        ▲
      </button>
      <button type="button" className={btn} onClick={onDown} disabled={!onDown} aria-label={`Move ${label} down`}>
        ▼
      </button>
    </span>
  );
}

// --------------------------------------------------------------- store ----

function StoreSection({
  list,
  section,
  collapsed,
  onToggle,
  onUp,
  onDown,
  onCheck,
  onAdd,
  dateLabel,
  printing,
  editing,
  onDeleteItem,
  onRemove,
  draggingId,
  bare = false,
}: {
  bare?: boolean;
  list: ShoppingList;
  section: ShoppingSection;
  collapsed: boolean;
  onToggle: () => void;
  onUp?: () => void;
  onDown?: () => void;
  onCheck: (id: string, checked: boolean) => void;
  onAdd: (name: string) => void;
  dateLabel: string;
  printing: boolean;
  editing: boolean;
  onDeleteItem?: (id: string) => void;
  onRemove?: () => void;
  draggingId: string | null;
}) {
  const {
    setNodeRef: storeRef,
    setActivatorNodeRef: handleRef,
    attributes: handleAttributes,
    listeners: handleListeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `store:${section.id}`, data: { type: "store", listId: list.id } satisfies DragData });
  const { setNodeRef: dropRef, isOver } = useDroppable({ id: `drop:${section.id}`, data: { type: "section-drop", sectionId: section.id } satisfies DragData });
  const open = section.items.filter((i) => !i.checked);
  const done = section.items.filter((i) => i.checked);
  const [confirm, setConfirm] = useState(false);

  return (
    <div
      ref={storeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`rounded-xl border bg-white ${isDragging ? "opacity-40" : ""} ${isOver && draggingId && !draggingId.startsWith("store:") ? "border-sky-500 ring-2 ring-sky-300" : "border-slate-200"}`}
    >
      <div ref={dropRef}>
        <div className={`flex items-center gap-1 px-1 ${bare ? "hidden" : ""}`}>
          <button
            type="button"
            ref={handleRef}
            {...handleAttributes}
            {...handleListeners}
            className="flex h-10 w-7 cursor-grab touch-none items-center justify-center text-base opacity-50 select-none"
            aria-label={`Drag ${section.store}`}
          >
            ⠿
          </button>
          <button type="button" onClick={onToggle} aria-expanded={!collapsed} className="flex min-h-10 min-w-0 flex-1 items-center gap-1.5 text-left">
            <span className="w-4 text-sm">{collapsed ? "▸" : "▾"}</span>
            <span className="truncate text-base font-semibold">{section.store}</span>
            <span className="text-sm opacity-60">{open.length}</span>
          </button>
          <Arrows onUp={onUp} onDown={onDown} label={section.store} />
          {printing ? <PrintSlipButton label="" className="flex h-12 w-10 items-center justify-center text-lg" lines={() => shoppingSlip(section.store, open, dateLabel)} /> : null}
          {onRemove && editing ? (
            confirm ? (
              <button type="button" className={`${tap} bg-red-600 px-2 text-sm text-white`} onClick={onRemove}>
                Remove {section.items.length ? `${section.items.length} items` : "store"}
              </button>
            ) : (
              <button type="button" className={`${tap} px-2 opacity-60`} onClick={() => setConfirm(true)} aria-label={`Remove ${section.store}`}>
                🗑
              </button>
            )
          ) : null}
        </div>
        {collapsed && !bare ? null : (
          <div className={`grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-1.5 p-1.5 ${bare ? "" : "pt-0"}`}>
            <SortableContext items={open.map((i) => i.id)} strategy={rectSortingStrategy}>
              {open.map((i) => (
                <ItemTile key={i.id} item={i} sectionId={section.id} onCheck={onCheck} onDelete={editing ? onDeleteItem : undefined} />
              ))}
            </SortableContext>
            <AddTile onAdd={onAdd} />
            {done.map((i) => (
              <button
                key={i.id}
                type="button"
                onClick={() => onCheck(i.id, false)}
                className="relative flex min-h-10 items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 text-left text-sm text-slate-500 line-through"
              >
                <span className="text-emerald-600 no-underline">✓</span>
                <span className="truncate">{i.name}</span>
                {editing && onDeleteItem ? <DeleteBadge onClick={() => onDeleteItem(i.id)} /> : null}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ItemTile({
  item,
  sectionId,
  onCheck,
  onDelete,
}: {
  item: { id: string; name: string; quantity: string | null };
  sectionId: string;
  onCheck: (id: string, checked: boolean) => void;
  onDelete?: (id: string) => void;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: item.id, data: { type: "item", sectionId } satisfies DragData });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition, WebkitTouchCallout: "none" }}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      onClick={() => onCheck(item.id, true)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onCheck(item.id, true);
        }
      }}
      className={`relative flex min-h-11 cursor-pointer touch-manipulation items-center rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-base font-medium leading-tight shadow-sm select-none active:bg-sky-50 ${isDragging ? "opacity-30" : ""}`}
    >
      <span className="break-words">
        {item.name}
        {item.quantity ? <span className="text-sm font-normal opacity-60"> ×{item.quantity}</span> : null}
      </span>
      {onDelete ? <DeleteBadge onClick={() => onDelete(item.id)} /> : null}
    </div>
  );
}

function DeleteBadge({ onClick }: { onClick: () => void }) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label="Delete"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="absolute -top-2 -right-2 flex h-8 w-8 items-center justify-center rounded-full bg-red-600 text-sm text-white no-underline shadow"
    >
      ✕
    </span>
  );
}

function AddTile({ onAdd }: { onAdd: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="flex min-h-11 items-center justify-center rounded-lg border-2 border-dashed border-slate-300 text-xl text-slate-400" aria-label="Add item here">
        ＋
      </button>
    );
  return (
    <form
      className="col-span-2 flex gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        const n = name.trim();
        if (n) onAdd(n);
        setName("");
      }}
    >
      <input
        autoFocus
        className={`${field} min-w-0 flex-1`}
        value={name}
        maxLength={80}
        placeholder="Item"
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          if (!name.trim()) setOpen(false);
        }}
      />
      <button type="submit" className={`${tap} bg-sky-600 px-3 text-white`}>
        Add
      </button>
    </form>
  );
}

// ---------------------------------------------------------- templates ----

function TemplateButtons({ board, onPick }: { board: ShoppingBoard; onPick: (templateId: string) => void }) {
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {board.templates.map((t) => (
        <button key={t.id} type="button" className={`${tap} bg-sky-600 text-white`} onClick={() => onPick(t.id)} title={t.stores.map((s) => `${s.store}: ${s.items.map((i) => i.name).join(", ")}`).join("; ")}>
          {t.name}
        </button>
      ))}
    </div>
  );
}

function TemplatesCard({ board, onDelete }: { board: ShoppingBoard; onDelete: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <section className="rounded-xl border border-slate-200 p-2">
      <button type="button" className="flex min-h-12 w-full items-center gap-2 text-left font-semibold" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="w-6">{open ? "▾" : "▸"}</span>
        Templates <span className="rounded-full bg-slate-200 px-2 text-sm">{board.templates.length}</span>
      </button>
      {open ? (
        <ul className="space-y-1">
          {board.templates.map((t) => (
            <li key={t.id} className="flex items-start gap-2 rounded-lg bg-slate-50 p-2">
              <div className="flex-1">
                <div className="font-medium">{t.name}</div>
                <div className="text-sm opacity-70">{t.stores.map((s) => `${s.store}: ${s.items.map((i) => i.name).join(", ")}`).join(" · ") || "Empty"}</div>
              </div>
              {confirm === t.id ? (
                <button type="button" className={`${tap} bg-red-600 px-2 text-sm text-white`} onClick={() => onDelete(t.id)}>
                  Delete
                </button>
              ) : (
                <button type="button" className={`${tap} px-2 opacity-60`} aria-label={`Delete template ${t.name}`} onClick={() => setConfirm(t.id)}>
                  🗑
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function NewListModal({ board, onClose, onCreate }: { board: ShoppingBoard; onClose: () => void; onCreate: (i: { name?: string; templateId?: string }) => void }) {
  const [name, setName] = useState("");
  return (
    <Modal title="New list" onClose={onClose}>
      <div className="space-y-4">
        {board.templates.length ? (
          <div className="space-y-2">
            <p className="text-sm opacity-70">From a template</p>
            <TemplateButtons board={board} onPick={(templateId) => onCreate({ templateId, ...(name.trim() && { name: name.trim() }) })} />
          </div>
        ) : null}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onCreate({ name: name.trim() || "Shopping" });
          }}
        >
          <input className={`${field} min-w-0 flex-1`} placeholder="List name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className={`${tap} border`}>
            Blank list
          </button>
        </form>
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------- list menu ----

function ListMenu({
  list,
  stores,
  today,
  onClose,
  onRename,
  onAddStore,
  onSaveTemplate,
  onDefer,
  onDelete,
}: {
  list: ShoppingList;
  stores: string[];
  today: string;
  onClose: () => void;
  onRename: (name: string) => void;
  onAddStore: (store: string) => void;
  onSaveTemplate: (name: string) => void;
  onDefer: (until: string | null) => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(list.name);
  const [store, setStore] = useState("");
  const [template, setTemplate] = useState(list.name);
  const [date, setDate] = useState(plusDays(today, 7));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saved, setSaved] = useState(false);
  const unused = stores.filter((s) => !list.sections.some((x) => x.store.toLowerCase() === s.toLowerCase()));
  const later = (until: string | null) => {
    onDefer(until);
    onClose();
  };

  return (
    <Modal title={list.name} onClose={onClose}>
      <div className="space-y-5">
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (store.trim()) onAddStore(store.trim());
            setStore("");
          }}
        >
          <h3 className="font-semibold">Add a store</h3>
          <div className="flex gap-2">
            <input className={`${field} min-w-0 flex-1`} list="shopping-stores-menu" placeholder="Store name" value={store} maxLength={40} onChange={(e) => setStore(e.target.value)} />
            <datalist id="shopping-stores-menu">
              {unused.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            <button type="submit" className={`${tap} bg-sky-600 text-white`}>
              Add
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {unused.slice(0, 8).map((s) => (
              <button key={s} type="button" className="min-h-10 rounded-lg border px-2 text-sm" onClick={() => onAddStore(s)}>
                ＋ {s}
              </button>
            ))}
          </div>
        </form>

        <div className="space-y-2">
          <h3 className="font-semibold">{list.deferredUntil && list.deferredUntil > today ? `Hidden until ${dayLabel(list.deferredUntil)}` : "Not now: hide until…"}</h3>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={`${tap} border`} onClick={() => later(plusDays(today, 1))}>
              Tomorrow
            </button>
            <button type="button" className={`${tap} border`} onClick={() => later(plusDays(today, 7))}>
              In a week
            </button>
            <button type="button" className={`${tap} border`} onClick={() => later(plusDays(today, 14))}>
              In 2 weeks
            </button>
            {list.deferredUntil ? (
              <button type="button" className={`${tap} bg-sky-600 text-white`} onClick={() => later(null)}>
                Bring back now
              </button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <input type="date" className={`${field} flex-1`} min={plusDays(today, 1)} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Hide until" />
            <button type="button" className={`${tap} border`} disabled={!date || date <= today} onClick={() => later(date)}>
              Hide until then
            </button>
          </div>
        </div>

        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!template.trim()) return;
            onSaveTemplate(template.trim());
            setSaved(true);
          }}
        >
          <h3 className="font-semibold">Save as template</h3>
          <div className="flex gap-2">
            <input className={`${field} min-w-0 flex-1`} value={template} maxLength={60} onChange={(e) => { setTemplate(e.target.value); setSaved(false); }} />
            <button type="submit" className={`${tap} border`}>
              {saved ? "Saved ✓" : "Save"}
            </button>
          </div>
          <p className="text-sm opacity-60">Same name replaces that template.</p>
        </form>

        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && name.trim() !== list.name) onRename(name.trim());
            onClose();
          }}
        >
          <h3 className="font-semibold">Rename</h3>
          <div className="flex gap-2">
            <input className={`${field} min-w-0 flex-1`} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            <button type="submit" className={`${tap} border`}>
              Rename
            </button>
          </div>
        </form>

        {onDelete ? (
          confirmDelete ? (
            <button
              type="button"
              className={`${tap} w-full bg-red-600 text-white`}
              onClick={() => {
                onDelete();
                onClose();
              }}
            >
              Delete {list.name} and everything on it
            </button>
          ) : (
            <button type="button" className={`${tap} w-full border border-red-300 text-red-700`} onClick={() => setConfirmDelete(true)}>
              Delete list
            </button>
          )
        ) : null}
      </div>
    </Modal>
  );
}
