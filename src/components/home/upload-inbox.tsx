"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { UploadReading } from "@/assistant/inbox";

type Result = { error: string | null };
type Match = { id: string; date: string; merchant: string; amount: number };

export type UploadActions = {
  read: (input: { text: string; note: string; fileName: string | null; fileKind: "image" | "pdf" | "text" }) => Promise<{ reading: UploadReading | null; error: string | null }>;
  fileEvent: (input: UploadReading["events"][number]) => Promise<Result>;
  fileReturn: (input: UploadReading["returns"][number]) => Promise<Result>;
  receiptMatches: (input: { total: number; date: string }) => Promise<{ matches: Match[]; error: string | null }>;
  noteOnTransaction: (input: { id: string; note: string }) => Promise<Result>;
  fileCarDue: (input: { carId: string; kind: UploadReading["carDue"][number]["kind"]; dueDate: string }) => Promise<Result>;
  fileUpkeep: (input: { title: string; dueDate: string; recurrenceDays: number | null; parts: string | null }) => Promise<Result>;
  fileBinder: (form: FormData) => Promise<Result & { href: string | null }>;
};

const field = "min-h-10 w-full rounded-lg border bg-transparent px-2 text-sm";
const button = "min-h-10 rounded-lg border px-3 text-sm disabled:opacity-50";
const primary = "min-h-10 rounded-lg bg-foreground px-3 text-sm text-background disabled:opacity-50";

const CAR_LABELS: Record<UploadReading["carDue"][number]["kind"], string> = {
  registration: "Registration",
  inspection: "Safety inspection",
  emissions: "Emissions",
  insurance: "Insurance",
  other: "Other paperwork",
};
const BINDER_LABELS: Record<NonNullable<UploadReading["binder"]>["kind"], string> = {
  manual: "Manual",
  warranty: "Warranty",
  insurance: "Insurance",
  property_tax: "Property tax",
  receipt: "Receipt",
  other: "Other paper",
};

/**
 * "Drop anything here" on the home page. A photo is read on this device
 * (Tesseract OCR, assets in /ocr); the picture is never uploaded. The text
 * appears in the box so the member can check it and delete anything private.
 * A PDF is not read: only its name and the member's note are sent. Claude
 * suggests where it goes, and nothing is saved until the member taps Add.
 */
export function UploadInbox({ actions, cars, today }: { actions: UploadActions; cars: { id: string; name: string }[]; today: string }) {
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<{ name: string; kind: "image" | "pdf"; preview: string | null; original: File } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState<UploadReading | null>(null);
  const [round, setRound] = useState(0);
  const pickRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => {
    if (file?.preview) URL.revokeObjectURL(file.preview);
  }, [file]);

  function reset() {
    setText("");
    setNote("");
    setFile(null);
    setStatus(null);
    setError(null);
    setReading(null);
    setRound((r) => r + 1);
  }

  async function onFile(f: File) {
    setError(null);
    setReading(null);
    if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
      setFile({ name: f.name, kind: "pdf", preview: null, original: f });
      setStatus("PDFs aren't read here. Say what it is below (optional), then tap Ask Claude.");
      return;
    }
    if (!f.type.startsWith("image/")) {
      setError("Use a photo, a screenshot or a PDF.");
      return;
    }
    setFile({ name: f.name, kind: "image", preview: URL.createObjectURL(f), original: f });
    setBusy(true);
    setStatus("Reading the picture on this device…");
    try {
      const { createWorker, OEM } = await import("tesseract.js");
      const worker = await createWorker("eng", OEM.LSTM_ONLY, { workerPath: "/ocr/worker.min.js", corePath: "/ocr/core", langPath: "/ocr/lang", workerBlobURL: false });
      try {
        const { data } = await worker.recognize(f);
        const read = data.text.replace(/\n{3,}/g, "\n\n").trim();
        setText((t) => (t ? `${t}\n${read}` : read).slice(0, 6000));
        setStatus(read ? "Check the text, delete anything private, then tap Ask Claude." : null);
        if (!read) setError("No text found in that picture. Type what it is in the note instead.");
      } finally {
        await worker.terminate();
      }
    } catch {
      setStatus(null);
      setError("Couldn't read that picture. Paste the text or type a note instead.");
    } finally {
      setBusy(false);
    }
  }

  async function ask() {
    setError(null);
    setBusy(true);
    setStatus("Claude is reading it…");
    try {
      const res = await actions.read({ text, note, fileName: file?.name ?? null, fileKind: file?.kind ?? "text" });
      setReading(res.reading);
      setStatus(null);
      setError(res.error);
      setRound((r) => r + 1);
    } catch {
      setStatus(null);
      setError("That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const nothing =
    reading &&
    !reading.events.length &&
    !reading.returns.length &&
    !reading.receipt &&
    !reading.binder &&
    !reading.carDue.length &&
    !reading.upkeep.length &&
    !reading.newCard;

  return (
    <section className="space-y-3 rounded-xl border p-4" aria-labelledby="upload-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="upload-heading" className="text-lg font-medium">
          Drop anything here
        </h2>
        <p className="text-xs opacity-60">School flyers, receipts, manuals, warranties, registrations, emails</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={busy} onClick={() => cameraRef.current?.click()}>
          📷 Take a photo
        </button>
        <button type="button" className={button} disabled={busy} onClick={() => pickRef.current?.click()}>
          📎 Choose a picture or PDF
        </button>
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (f) void onFile(f);
          }}
        />
        <input
          ref={pickRef}
          type="file"
          accept="image/*,application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (f) void onFile(f);
          }}
        />
        {file || text || reading ? (
          <button type="button" className={button} disabled={busy} onClick={reset}>
            Start over
          </button>
        ) : null}
      </div>

      {file ? (
        <div className="flex items-center gap-3 text-sm">
          {file.preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={file.preview} alt="" className="h-16 w-16 rounded-lg border object-cover" />
          ) : (
            <span className="flex h-16 w-16 items-center justify-center rounded-lg border text-2xl">📄</span>
          )}
          <span className="break-all opacity-80">{file.name}</span>
        </div>
      ) : null}

      {file?.kind !== "pdf" ? (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 6000))}
          rows={text ? 5 : 2}
          placeholder="Or paste an email or a message here"
          className={`${field} py-2`}
        />
      ) : null}
      <input value={note} onChange={(e) => setNote(e.target.value.slice(0, 500))} placeholder="Note for Claude (optional), e.g. 'dishwasher manual' or 'Leo's school'" className={field} />

      <button type="button" className={primary} disabled={busy || (text.trim().length < 3 && note.trim().length < 3 && !file)} onClick={ask}>
        ✨ Ask Claude what to do with it
      </button>
      {status ? <p className="text-sm opacity-80">{status}</p> : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {reading ? (
        <div key={round} className="space-y-3 border-t pt-3">
          <p className="text-sm">
            <span className="opacity-60">Claude thinks this is:</span> <strong>{reading.what}</strong>
          </p>
          {reading.events.map((e, i) => (
            <EventSuggestion key={`e${i}`} initial={e} action={actions.fileEvent} />
          ))}
          {reading.returns.map((r, i) => (
            <ReturnSuggestion key={`r${i}`} initial={r} action={actions.fileReturn} />
          ))}
          {reading.receipt ? <ReceiptSuggestion initial={reading.receipt} today={today} actions={actions} /> : null}
          {reading.carDue.map((c, i) => (
            <CarSuggestion key={`c${i}`} initial={c} cars={cars} action={actions.fileCarDue} />
          ))}
          {reading.upkeep.map((u, i) => (
            <UpkeepSuggestion key={`u${i}`} initial={u} today={today} action={actions.fileUpkeep} />
          ))}
          {reading.binder ? <BinderSuggestion initial={reading.binder} file={file?.original ?? null} action={actions.fileBinder} /> : null}
          {reading.newCard ? (
            <Suggestion title="New credit card">
              <p className="text-xs opacity-70">
                Add it in Accounts with a photo of the front, number covered. Claude reads the card name there and shows its current benefits.
              </p>
              <Link href="/finance/accounts" className={`${button} inline-flex items-center`}>
                Add a card you just opened
              </Link>
            </Suggestion>
          ) : null}
          {reading.advice ? <p className="text-sm opacity-80">💡 {reading.advice}</p> : null}
          {nothing && !reading.advice ? <p className="text-sm opacity-70">Claude didn&apos;t find anything to add. Add a note saying what it is and try again.</p> : null}
          <p className="text-xs opacity-60">
            Pictures are read on this device and not uploaded unless you file them in the home binder. Card, account, order and phone numbers are removed before the text goes to Claude.
          </p>
        </div>
      ) : null}
    </section>
  );
}

function Suggestion({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="text-sm font-semibold">{title}</div>
      {children}
    </div>
  );
}

/** Add button with its own saving / saved / error state. */
function useFiling() {
  const [state, setState] = useState<{ busy: boolean; done: boolean; error: string | null }>({ busy: false, done: false, error: null });
  async function run(fn: () => Promise<Result>) {
    setState({ busy: true, done: false, error: null });
    try {
      const res = await fn();
      setState({ busy: false, done: !res.error, error: res.error });
    } catch {
      setState({ busy: false, done: false, error: "That didn't save. Try again." });
    }
  }
  return { ...state, run };
}

function FileButton({ label, filing, onClick, doneText, doneHref }: { label: string; filing: ReturnType<typeof useFiling>; onClick: () => void; doneText: string; doneHref: string }) {
  if (filing.done)
    return (
      <p className="text-sm text-green-700">
        ✓ {doneText}{" "}
        <Link href={doneHref} className="underline">
          Open
        </Link>
      </p>
    );
  return (
    <div className="space-y-1">
      <button type="button" className={primary} disabled={filing.busy} onClick={onClick}>
        {filing.busy ? "Saving…" : label}
      </button>
      {filing.error ? <p className="text-sm text-red-600">{filing.error}</p> : null}
    </div>
  );
}

function EventSuggestion({ initial, action }: { initial: UploadReading["events"][number]; action: UploadActions["fileEvent"] }) {
  const [e, setE] = useState(initial);
  const filing = useFiling();
  const set = (patch: Partial<typeof e>) => setE((x) => ({ ...x, ...patch }));
  return (
    <Suggestion title="📅 Calendar event">
      <div className="grid gap-2 sm:grid-cols-2">
        <input aria-label="Event" className={`${field} sm:col-span-2`} value={e.title} maxLength={120} onChange={(x) => set({ title: x.target.value })} />
        <input aria-label="Date" type="date" className={field} value={e.date} onChange={(x) => set({ date: x.target.value })} />
        <input aria-label="Last day" type="date" className={field} value={e.endDate ?? ""} onChange={(x) => set({ endDate: x.target.value || null })} />
        <input aria-label="Starts" type="time" className={field} value={e.startTime ?? ""} onChange={(x) => set({ startTime: x.target.value || null })} />
        <input aria-label="Ends" type="time" className={field} value={e.endTime ?? ""} onChange={(x) => set({ endTime: x.target.value || null })} />
        <input aria-label="Where" placeholder="Where" className={`${field} sm:col-span-2`} value={e.location ?? ""} maxLength={200} onChange={(x) => set({ location: x.target.value || null })} />
        <input aria-label="Notes" placeholder="Notes" className={`${field} sm:col-span-2`} value={e.notes ?? ""} maxLength={400} onChange={(x) => set({ notes: x.target.value || null })} />
      </div>
      <FileButton label="Add to the family calendar" filing={filing} onClick={() => filing.run(() => action(e))} doneText="On the calendar." doneHref="/calendar" />
    </Suggestion>
  );
}

function ReturnSuggestion({ initial, action }: { initial: UploadReading["returns"][number]; action: UploadActions["fileReturn"] }) {
  const [r, setR] = useState(initial);
  const filing = useFiling();
  return (
    <Suggestion title="↩️ Return">
      <div className="grid gap-2 sm:grid-cols-3">
        <input aria-label="Store" className={field} value={r.store} maxLength={40} onChange={(x) => setR({ ...r, store: x.target.value })} />
        <input aria-label="Item" className={field} value={r.itemName} maxLength={80} onChange={(x) => setR({ ...r, itemName: x.target.value })} />
        <input aria-label="Return by" type="date" className={field} value={r.returnDeadline ?? ""} onChange={(x) => setR({ ...r, returnDeadline: x.target.value || null })} />
      </div>
      <FileButton label="Add to returns" filing={filing} onClick={() => filing.run(() => action(r))} doneText="Added to returns." doneHref="/family" />
    </Suggestion>
  );
}

function ReceiptSuggestion({ initial, today, actions }: { initial: NonNullable<UploadReading["receipt"]>; today: string; actions: UploadActions }) {
  const [total, setTotal] = useState(initial.total?.toFixed(2) ?? "");
  const [date, setDate] = useState(initial.date ?? today);
  const [note, setNote] = useState(initial.note || `${initial.merchant} receipt`);
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filing = useFiling();
  const [noted, setNoted] = useState<string | null>(null);

  async function find() {
    const amount = Number(total);
    if (!(amount > 0)) return setError("Enter the total first.");
    setBusy(true);
    setError(null);
    try {
      const res = await actions.receiptMatches({ total: amount, date });
      setMatches(res.matches);
      setError(res.error);
    } catch {
      setError("Couldn't look up bank charges.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Suggestion title={`🧾 Receipt: ${initial.merchant}`}>
      <div className="grid gap-2 sm:grid-cols-3">
        <input aria-label="Total" inputMode="decimal" placeholder="Total" className={field} value={total} onChange={(x) => setTotal(x.target.value)} />
        <input aria-label="Date" type="date" className={field} value={date} onChange={(x) => setDate(x.target.value)} />
        <input aria-label="Note" className={field} value={note} maxLength={200} onChange={(x) => setNote(x.target.value)} />
      </div>
      {!matches ? (
        <button type="button" className={button} disabled={busy} onClick={find}>
          {busy ? "Looking…" : "Find the bank charge and add this note"}
        </button>
      ) : matches.length === 0 ? (
        <p className="text-sm opacity-70">No bank charge of about that amount within 10 days on accounts you can see. It may not have synced yet.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {matches.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2">
              <span className="tabular-nums">{m.date}</span>
              <span>{m.merchant}</span>
              <span className="tabular-nums opacity-70">${Math.abs(m.amount).toFixed(2)}</span>
              {noted === m.id && filing.done ? (
                <span className="text-green-700">✓ Note added</span>
              ) : (
                <button
                  type="button"
                  className={button}
                  disabled={filing.busy || !note.trim()}
                  onClick={() => {
                    setNoted(m.id);
                    void filing.run(() => actions.noteOnTransaction({ id: m.id, note }));
                  }}
                >
                  Add note here
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error || filing.error ? <p className="text-sm text-red-600">{error ?? filing.error}</p> : null}
    </Suggestion>
  );
}

function CarSuggestion({ initial, cars, action }: { initial: UploadReading["carDue"][number]; cars: { id: string; name: string }[]; action: UploadActions["fileCarDue"] }) {
  const guess = cars.find((c) => initial.car && c.name.toLowerCase() === initial.car.toLowerCase())?.id ?? (cars.length === 1 ? cars[0].id : "");
  const [carId, setCarId] = useState(guess);
  const [dueDate, setDueDate] = useState(initial.dueDate);
  const filing = useFiling();
  return (
    <Suggestion title={`🚗 Car: ${CAR_LABELS[initial.kind]}`}>
      {cars.length === 0 ? (
        <p className="text-sm">
          Add your cars in{" "}
          <Link href="/maintenance#vehicles" className="underline">
            Home maintenance
          </Link>{" "}
          first, then try again. Due {initial.dueDate}.
        </p>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <select aria-label="Car" className={field} value={carId} onChange={(x) => setCarId(x.target.value)}>
              <option value="">Which car?</option>
              {cars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input aria-label="Due" type="date" className={field} value={dueDate} onChange={(x) => setDueDate(x.target.value)} />
          </div>
          <FileButton
            label="Set the due date"
            filing={filing}
            onClick={() => (carId ? filing.run(() => action({ carId, kind: initial.kind, dueDate })) : undefined)}
            doneText="Saved in car upkeep."
            doneHref="/maintenance#vehicles"
          />
        </>
      )}
    </Suggestion>
  );
}

function UpkeepSuggestion({ initial, today, action }: { initial: UploadReading["upkeep"][number]; today: string; action: UploadActions["fileUpkeep"] }) {
  const [u, setU] = useState({ ...initial, dueDate: initial.dueDate ?? today });
  const filing = useFiling();
  return (
    <Suggestion title="🔧 Upkeep item">
      <div className="grid gap-2 sm:grid-cols-2">
        <input aria-label="Work" className={`${field} sm:col-span-2`} value={u.title} maxLength={120} onChange={(x) => setU({ ...u, title: x.target.value })} />
        <input aria-label="Next due" type="date" className={field} value={u.dueDate} onChange={(x) => setU({ ...u, dueDate: x.target.value })} />
        <input
          aria-label="Repeat every (days)"
          type="number"
          min={1}
          max={3650}
          placeholder="Repeat every (days)"
          className={field}
          value={u.recurrenceDays ?? ""}
          onChange={(x) => setU({ ...u, recurrenceDays: x.target.value ? Number(x.target.value) : null })}
        />
        <input aria-label="Parts" placeholder="Parts needed" className={`${field} sm:col-span-2`} value={u.parts ?? ""} maxLength={300} onChange={(x) => setU({ ...u, parts: x.target.value || null })} />
      </div>
      <FileButton label="Add to upkeep" filing={filing} onClick={() => filing.run(() => action(u))} doneText="Added to upkeep." doneHref="/maintenance#items" />
    </Suggestion>
  );
}

const MAX_BINDER_BYTES = 8 * 1024 * 1024;

function BinderSuggestion({ initial, file, action }: { initial: NonNullable<UploadReading["binder"]>; file: File | null; action: UploadActions["fileBinder"] }) {
  const [b, setB] = useState(initial);
  const [state, setState] = useState<{ busy: boolean; href: string | null; error: string | null }>({ busy: false, href: null, error: null });
  const tooBig = file != null && file.size > MAX_BINDER_BYTES;

  async function save() {
    if (!file) return;
    setState({ busy: true, href: null, error: null });
    const form = new FormData();
    form.set("title", b.title);
    form.set("category", b.kind);
    form.set("expiresOn", b.expiresOn ?? "");
    form.set("file", file);
    try {
      const res = await action(form);
      setState({ busy: false, href: res.href, error: res.error });
    } catch {
      setState({ busy: false, href: null, error: "That didn't save. Try again." });
    }
  }

  return (
    <Suggestion title={`📁 Home binder: ${BINDER_LABELS[b.kind]}`}>
      <div className="grid gap-2 sm:grid-cols-3">
        <input aria-label="Title" className={`${field} sm:col-span-3`} value={b.title} maxLength={120} onChange={(x) => setB({ ...b, title: x.target.value })} />
        <select aria-label="Kind" className={field} value={b.kind} onChange={(x) => setB({ ...b, kind: x.target.value as typeof b.kind })}>
          {Object.entries(BINDER_LABELS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <span className="shrink-0 opacity-70">Ends / due</span>
          <input aria-label="Ends or due" type="date" className={field} value={b.expiresOn ?? ""} onChange={(x) => setB({ ...b, expiresOn: x.target.value || null })} />
        </label>
      </div>
      {state.href ? (
        <p className="text-sm text-green-700">
          ✓ Filed in the binder.{" "}
          <Link href={state.href} className="underline">
            Open
          </Link>
        </p>
      ) : !file ? (
        <p className="text-sm">
          Take a photo or choose the file above to keep it, or add it in the{" "}
          <Link href="/maintenance/binder" className="underline">
            home binder
          </Link>
          .
        </p>
      ) : tooBig ? (
        <p className="text-sm text-red-600">That file is larger than 8 MB. Store a compressed scan instead.</p>
      ) : (
        <>
          <button type="button" className={primary} disabled={state.busy || !b.title.trim()} onClick={save}>
            {state.busy ? "Saving…" : `Keep ${file.name.length > 30 ? "this file" : file.name} in the binder`}
          </button>
          <p className="text-xs opacity-70">The file is uploaded and stored encrypted. Ending or due dates become reminders in Home maintenance.</p>
        </>
      )}
      {state.error ? <p className="text-sm text-red-600">{state.error}</p> : null}
    </Suggestion>
  );
}
