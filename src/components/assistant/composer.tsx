"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { MicButton, PhotoButton, PhotoTextBox, usePhotoText } from "./voice-photo";

type Send = (input: { conversationId: string | null; text: string; photoText: string | null }) => Promise<{ ok: true; conversationId: string } | { ok: false; error: string }>;

const EXAMPLES = [
  "What did we spend on the house last quarter, and which of it was planned upkeep?",
  "Find transactions with no category and suggest categories.",
  "Merge the duplicate grocery categories.",
  "Which returns are due this week, and did we already get the refund?",
  "Add a daily chore for each kid to read 20 minutes, with a 10-day streak goal.",
  "Start a Costco list from the weekly template and add oat milk.",
];

export function Composer({ conversationId, send, empty }: { conversationId: string | null; send: Send; empty: boolean }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const photo = usePhotoText();
  const append = (t: string) => setText((cur) => (cur.trim() ? `${cur.trimEnd()} ${t}` : t).slice(0, 4000));

  function submit(value: string) {
    const photoText = photo.text.trim() || null;
    const msg = value.trim() || (photoText ? "Here's a photo. What should I do with it?" : "");
    if (!msg || pending || photo.busy) return;
    setError(null);
    start(async () => {
      const r = await send({ conversationId, text: msg, photoText });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setText("");
      photo.clear();
      if (r.conversationId !== conversationId) router.push(`/assistant?c=${r.conversationId}`);
      else router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      {empty && (
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((e) => (
            <button key={e} type="button" className="rounded-full border px-3 py-1 text-xs hover:bg-foreground/5" onClick={() => setText(e)}>
              {e}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text);
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit(text);
            }
          }}
          rows={2}
          maxLength={4000}
          placeholder="Ask, or tell Claude to add or change something: chores, lists, events, upkeep, returns…"
          className="min-h-12 flex-1 resize-y rounded-md border bg-background px-3 py-2 text-sm"
          disabled={pending}
        />
        <div className="flex flex-col gap-1">
          <div className="flex gap-1">
            <MicButton onText={append} disabled={pending} className="h-9 w-9 rounded-md border text-base" />
            <PhotoButton onPick={(f) => void photo.pick(f)} disabled={pending || photo.busy} className="h-9 w-9 rounded-md border text-base" />
          </div>
          <Button type="submit" disabled={pending || photo.busy || (!text.trim() && !photo.text.trim())}>
            {pending ? "Thinking…" : "Send"}
          </Button>
        </div>
      </form>
      <PhotoTextBox photo={photo} />
      {pending && <p className="text-xs opacity-60">Claude is looking through your data. This can take a minute.</p>}
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
