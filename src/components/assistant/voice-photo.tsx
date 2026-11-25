"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Voice and photo input for Ask Claude (the app and the kitchen screen).
 *
 * - Voice: the browser's own speech recognition (Web Speech API) turns
 *   speech into text in the message box, where it can be checked before
 *   sending. Chrome and Safari do the recognition with their maker's speech
 *   service; no audio reaches this app or Claude. Browsers without it (e.g.
 *   Firefox) show no mic button; the phone keyboard's own mic still works.
 * - Photo: text is read on this device (tesseract.js, as on the home page's
 *   upload) and shown for checking. Only that text is sent, scrubbed again
 *   on the server (assistant/inbox.ts withPhotoText); never the picture.
 */

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const MIC_ERRORS: Record<string, string> = {
  "not-allowed": "The microphone is blocked. Allow it for this site in the browser's settings.",
  "service-not-allowed": "Voice typing isn't allowed in this browser.",
  "audio-capture": "No microphone found.",
  network: "Voice typing needs an internet connection.",
};

/** Speech to text. `onText` gets each finished phrase. */
export function useDictation(onText: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const cb = useRef(onText);
  useEffect(() => {
    cb.current = onText;
  }, [onText]);

  useEffect(() => {
    queueMicrotask(() => setSupported(Boolean(recognitionCtor())));
    return () => rec.current?.abort();
  }, []);

  function start() {
    const Ctor = recognitionCtor();
    if (!Ctor || listening) return;
    setError(null);
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    r.continuous = true;
    r.interimResults = false;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) {
          const t = res[0].transcript.trim();
          if (t) cb.current(t);
        }
      }
    };
    r.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") setError(MIC_ERRORS[e.error] ?? "Voice typing stopped. Try again.");
    };
    r.onend = () => {
      setListening(false);
      rec.current = null;
    };
    rec.current = r;
    try {
      r.start();
      setListening(true);
    } catch {
      setError("Voice typing couldn't start. Try again.");
    }
  }

  function stop() {
    rec.current?.stop();
  }

  return { supported, listening, error, start, stop };
}

/** Reads the text in a picture on this device. Empty string when there is none. */
export async function readPhotoText(file: File): Promise<string> {
  const { createWorker, OEM } = await import("tesseract.js");
  const worker = await createWorker("eng", OEM.LSTM_ONLY, { workerPath: "/ocr/worker.min.js", corePath: "/ocr/core", langPath: "/ocr/lang", workerBlobURL: false });
  try {
    const { data } = await worker.recognize(file);
    return data.text.replace(/\n{3,}/g, "\n\n").trim();
  } finally {
    await worker.terminate();
  }
}

export const MAX_PHOTO_CHARS = 4000;

/** Mic toggle. Renders nothing where the browser can't do speech to text. */
export function MicButton({ onText, className, disabled }: { onText: (text: string) => void; className?: string; disabled?: boolean }) {
  const d = useDictation(onText);
  if (!d.supported) return null;
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={d.listening}
        aria-label={d.listening ? "Stop voice typing" : "Speak instead of typing"}
        title={d.listening ? "Stop" : "Speak"}
        className={`${className ?? ""} ${d.listening ? "animate-pulse bg-red-600 text-white" : ""}`}
        onClick={() => (d.listening ? d.stop() : d.start())}
      >
        {d.listening ? "■" : "🎤"}
      </button>
      {d.error ? (
        <span role="alert" className="basis-full text-sm text-red-700">
          {d.error}
        </span>
      ) : null}
    </>
  );
}

/**
 * Attach-a-photo button plus the text read from it, which the person can
 * edit or clear before sending.
 */
export function usePhotoText() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function pick(f: File | undefined) {
    if (!f) return;
    setError(null);
    if (!f.type.startsWith("image/")) {
      setError("Use a photo or a screenshot.");
      return;
    }
    setBusy(true);
    try {
      const read = await readPhotoText(f);
      if (!read) setError("No text found in that picture. Describe it in your message instead.");
      setText((t) => (t ? `${t}\n${read}` : read).slice(0, MAX_PHOTO_CHARS));
    } catch {
      setError("Couldn't read that picture. Type what it says instead.");
    } finally {
      setBusy(false);
    }
  }
  return { text, setText, busy, error, pick, clear: () => setText("") };
}

export function PhotoButton({ onPick, className, disabled }: { onPick: (f: File | undefined) => void; className?: string; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" disabled={disabled} aria-label="Add a photo" title="Add a photo (only its text is sent)" className={className} onClick={() => input.current?.click()}>
        📷
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          onPick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </>
  );
}

export function PhotoTextBox({ photo, className }: { photo: ReturnType<typeof usePhotoText>; className?: string }) {
  if (photo.busy) return <p className={`text-sm opacity-70 ${className ?? ""}`}>Reading the picture on this device…</p>;
  if (!photo.text && !photo.error) return null;
  return (
    <div className={className}>
      {photo.error ? <p className="text-sm text-red-700">{photo.error}</p> : null}
      {photo.text ? (
        <>
          <div className="flex items-center justify-between text-xs opacity-70">
            <span>Text from the photo (only this is sent; delete anything private)</span>
            <button type="button" className="underline" onClick={photo.clear}>
              Remove
            </button>
          </div>
          <textarea
            value={photo.text}
            onChange={(e) => photo.setText(e.target.value.slice(0, MAX_PHOTO_CHARS))}
            rows={4}
            className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
          />
        </>
      ) : null}
    </div>
  );
}
