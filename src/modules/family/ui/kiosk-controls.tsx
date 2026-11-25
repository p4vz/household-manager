"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  enterFullscreen,
  exitFullscreen,
  fullscreenSupported,
  isFullscreen,
  rememberKitchenFullscreen,
  wantsKitchenFullscreen,
} from "@/lib/fullscreen";
import { ChangesetCard, type ChangesetCardData } from "@/components/assistant/changeset-card";
import { MicButton, PhotoButton, PhotoTextBox, usePhotoText } from "@/components/assistant/voice-photo";
import { ErrorNote, Modal, tap } from "./kit";

const btn = "min-h-12 min-w-12 rounded-xl border px-3 text-lg font-medium";

export type AdultControls = {
  /** ISO time adult mode ends on this screen, or null when locked. */
  until: string | null;
  unlock: (input: { pin: string }) => Promise<{ ok: true; until: string } | { ok: false; error: string }>;
  lock: (input: Record<string, never>) => Promise<void>;
  exit: (input: Record<string, never>) => Promise<void>;
  /** Ask Claude about, or change, what's on this screen (adult mode only). */
  ask: (input: {
    history: ChatTurn[];
    question: string;
    photoText: string | null;
  }) => Promise<{ answer: string | null; changes: ChangesetCardData | null; error: string | null }>;
  /** Apply, discard or undo what Claude changed. */
  change: (input: {
    action: "apply" | "discard" | "undo" | "undo_one";
    id: string;
    changesetId: string;
  }) => Promise<{ changes: ChangesetCardData | null; error: string | null }>;
};

type ChatTurn = { role: "user" | "assistant"; text: string };
type ShownTurn = ChatTurn & { changes?: ChangesetCardData | null };

/**
 * Kiosk header controls:
 * - Adult mode: kids use this screen, so deleting events, finishing upkeep,
 *   moving returns along and leaving kitchen mode need the adult PIN. It
 *   lasts five minutes on the server, or until Lock.
 * - Full screen on/off. Browsers drop full screen on every reload (the
 *   watchdog's, or the nightly one) and only allow it again after a tap, so
 *   once it was switched on, the next tap anywhere turns it back on. Leaving
 *   full screen doesn't leave the kitchen screen: the browser stays locked
 *   to /kiosk.
 */
export function KioskControls({ adult }: { adult: AdultControls }) {
  const [full, setFull] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    // Read browser-only state after mount (not available during SSR).
    const sync = () => setFull(isFullscreen());
    queueMicrotask(() => {
      setSupported(fullscreenSupported());
      sync();
    });
    const restore = () => {
      if (wantsKitchenFullscreen() && !isFullscreen()) void enterFullscreen();
    };
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    window.addEventListener("pointerdown", restore, { capture: true });
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
      window.removeEventListener("pointerdown", restore, { capture: true });
    };
  }, []);

  return (
    <>
      <AdultMode {...adult} />
      {supported ? (
        <button
          type="button"
          className={btn}
          aria-label={full ? "Leave full screen" : "Full screen"}
          title={full ? "Leave full screen" : "Full screen"}
          onClick={async (e) => {
            // This tap must not also trigger the restore listener's re-entry.
            e.stopPropagation();
            if (isFullscreen()) {
              rememberKitchenFullscreen(false);
              await exitFullscreen();
            } else {
              rememberKitchenFullscreen(true);
              await enterFullscreen();
            }
          }}
        >
          {full ? "🗗" : "⛶"}
        </button>
      ) : null}
    </>
  );
}

function AdultMode({ until, unlock, lock, exit, ask, change }: AdultControls) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [chatting, setChatting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [pending, start] = useTransition();
  const end = until ? Date.parse(until) : 0;
  const left = end - now;
  const on = left > 0;

  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      // Ran out: the server already refuses adult actions; show the locked screen.
      if (n >= Date.parse(until)) {
        clearInterval(t);
        router.refresh();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [until, router]);

  if (!on) {
    return (
      <>
        <button type="button" className={btn} onClick={() => setAsking(true)} title="Unlock adult controls with the adult PIN">
          🔒 Adult
        </button>
        {asking ? (
          <PinPad
            title="Adult mode"
            onClose={() => setAsking(false)}
            submit={async (pin) => {
              const res = await unlock({ pin });
              if (!res.ok) return res.error;
              setNow(Date.now());
              setAsking(false);
              router.refresh();
              return null;
            }}
          />
        ) : null}
      </>
    );
  }

  const mins = Math.floor(left / 60_000);
  const secs = Math.floor((left % 60_000) / 1000);
  return (
    <>
      <span className="flex min-h-12 items-center rounded-xl bg-amber-100 px-3 text-lg font-medium text-amber-900">
        🔓 Adult · {mins}:{String(secs).padStart(2, "0")}
      </span>
      <button
        type="button"
        disabled={pending}
        className={`${btn} border-amber-600`}
        onClick={() =>
          start(async () => {
            await lock({});
            router.refresh();
          })
        }
      >
        Lock
      </button>
      <button type="button" className={`${btn} border-violet-600 text-violet-800`} onClick={() => setChatting(true)}>
        💬 Ask Claude
      </button>
      <button type="button" className={btn} onClick={() => setLeaving(true)}>
        Exit kitchen mode
      </button>
      {chatting ? <KitchenChat ask={ask} change={change} onClose={() => setChatting(false)} /> : null}
      {leaving ? (
        <Modal title="Exit kitchen mode?" onClose={() => setLeaving(false)}>
          <p className="mb-4">
            This screen gets unpaired and becomes an ordinary browser again. To use it as the kitchen screen later, tap Kitchen mode in the app or pair it
            with a code from Settings.
          </p>
          <button
            type="button"
            disabled={pending}
            className={`${tap} w-full bg-red-600 text-white disabled:opacity-50`}
            onClick={() =>
              start(async () => {
                await exit({});
                rememberKitchenFullscreen(false);
                await exitFullscreen().catch(() => undefined);
                window.location.assign("/signin");
              })
            }
          >
            Exit kitchen mode
          </button>
        </Modal>
      ) : null}
    </>
  );
}

/** Big digit buttons for a touch screen; the PIN is never shown. */
function PinPad({ title, onClose, submit }: { title: string; onClose: () => void; submit: (pin: string) => Promise<string | null> }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (pin.length < 4 || busy) return;
    setBusy(true);
    try {
      const err = await submit(pin);
      if (err) {
        setError(err);
        setPin("");
      }
    } catch {
      setError("That didn't work. Try again.");
      setPin("");
    } finally {
      setBusy(false);
    }
  };
  const key = "min-h-16 rounded-xl border text-2xl font-semibold active:scale-95 transition-transform select-none";
  return (
    <Modal title={title} onClose={onClose}>
      <p className="mb-3 opacity-80">Type the adult PIN. Adult controls stay on for 5 minutes.</p>
      <div className="mb-3 flex h-12 items-center justify-center gap-3 text-3xl" aria-label={`${pin.length} digits typed`}>
        {pin.length === 0 ? <span className="text-base opacity-50">PIN</span> : "•".repeat(pin.length)}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button key={d} type="button" className={key} onClick={() => setPin((p) => (p.length < 8 ? p + d : p))}>
            {d}
          </button>
        ))}
        <button type="button" className={key} aria-label="Delete digit" onClick={() => setPin((p) => p.slice(0, -1))}>
          ⌫
        </button>
        <button type="button" className={key} onClick={() => setPin((p) => (p.length < 8 ? `${p}0` : p))}>
          0
        </button>
        <button type="button" disabled={pin.length < 4 || busy} className={`${key} bg-sky-600 text-white disabled:opacity-50`} onClick={go}>
          {busy ? "…" : "OK"}
        </button>
      </div>
      <div className="mt-3">
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}

const SUGGESTIONS = [
  "What's on this week?",
  "Who still has chores today?",
  "Add milk and eggs to the Costco list",
  "Add a dentist appointment next Tuesday at 3",
];

/**
 * Ask Claude about, or change, what's on the kitchen screen. The
 * conversation lives only here: closing the box or adult mode running out
 * forgets it. Changes are kept, with Undo here and in the phone app.
 */
function KitchenChat({ ask, change, onClose }: { ask: AdultControls["ask"]; change: AdultControls["change"]; onClose: () => void }) {
  const [turns, setTurns] = useState<ShownTurn[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const photo = usePhotoText();
  const send = async (question: string) => {
    const photoText = photo.text.trim() || null;
    const q = question.trim() || (photoText ? "What's in this photo? Add anything that belongs on the screen." : "");
    if (!q || busy || photo.busy) return;
    setBusy(true);
    setError(null);
    setText("");
    photo.clear();
    const history: ChatTurn[] = turns.map(({ role, text: t }) => ({ role, text: t }));
    setTurns((t) => [...t, { role: "user", text: photoText ? `${q} 📷` : q }]);
    try {
      const r = await ask({ history: history.slice(-20), question: q.slice(0, 500), photoText });
      if (r.answer) setTurns((t) => [...t, { role: "assistant", text: r.answer!, changes: r.changes }]);
      else setError(r.error ?? "Claude couldn't answer. Try again.");
    } catch {
      setError("Claude couldn't answer. Adult mode may have ended.");
    } finally {
      setBusy(false);
    }
  };
  const act = (changesetId: string, action: "apply" | "discard" | "undo" | "undo_one") => async (input: { id: string }) => {
    const r = await change({ action, id: input.id, changesetId });
    if (r.error) throw new Error(r.error);
    setTurns((all) => all.map((t) => (t.changes?.id === changesetId ? { ...t, changes: r.changes } : t)));
  };
  return (
    <Modal title="💬 Ask Claude" onClose={onClose}>
      <p className="mb-2 text-sm opacity-70">Calendar, chores, shopping, returns and upkeep only. Claude can add and change things here; you can undo.</p>
      <div className="mb-3 max-h-[50vh] space-y-2 overflow-y-auto">
        {turns.length === 0 ? (
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" className={`${tap} border text-base`} onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        ) : null}
        {turns.map((t, i) => (
          <div key={i}>
            <div
              className={`whitespace-pre-wrap rounded-xl px-3 py-2 text-lg ${t.role === "user" ? "ml-10 bg-sky-100 text-sky-950" : "mr-10 bg-slate-100 dark:bg-slate-800"}`}
            >
              {t.text}
            </div>
            {t.changes ? (
              <div className="mr-10">
                <ChangesetCard
                  set={t.changes}
                  actions={{
                    apply: act(t.changes.id, "apply"),
                    discard: act(t.changes.id, "discard"),
                    undoOne: act(t.changes.id, "undo_one"),
                    undoAll: act(t.changes.id, "undo"),
                  }}
                />
              </div>
            ) : null}
          </div>
        ))}
        {busy ? <div className="mr-10 rounded-xl bg-slate-100 px-3 py-2 text-lg opacity-70 dark:bg-slate-800">Thinking…</div> : null}
      </div>
      <ErrorNote error={error} />
      <PhotoTextBox photo={photo} className="mb-2" />
      <form
        className="mt-2 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={500}
          placeholder="Ask, or say what to add or change…"
          className="min-h-12 flex-1 rounded-xl border px-3 text-lg"
          autoFocus
        />
        <MicButton onText={(t) => setText((cur) => (cur.trim() ? `${cur.trimEnd()} ${t}` : t).slice(0, 500))} disabled={busy} className={`${tap} border text-xl`} />
        <PhotoButton onPick={(f) => void photo.pick(f)} disabled={busy || photo.busy} className={`${tap} border text-xl`} />
        <button type="submit" disabled={busy || photo.busy || (!text.trim() && !photo.text.trim())} className={`${tap} bg-violet-600 text-white disabled:opacity-50`}>
          Ask
        </button>
      </form>
    </Modal>
  );
}
