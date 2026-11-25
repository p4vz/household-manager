"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";

type Send = (input: { conversationId: string | null; text: string }) => Promise<{ ok: true; conversationId: string } | { ok: false; error: string }>;

const EXAMPLES = [
  "What did we spend on the house last quarter, and which of it was planned upkeep?",
  "Find transactions with no category and suggest categories.",
  "Merge the duplicate grocery categories.",
  "Which returns are due this week, and did we already get the refund?",
];

export function Composer({ conversationId, send, empty }: { conversationId: string | null; send: Send; empty: boolean }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(value: string) {
    const msg = value.trim();
    if (!msg || pending) return;
    setError(null);
    start(async () => {
      const r = await send({ conversationId, text: msg });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setText("");
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
          placeholder="Ask about money, upkeep, chores, shopping, returns or trips, or ask Claude to clean something up"
          className="min-h-12 flex-1 resize-y rounded-md border bg-background px-3 py-2 text-sm"
          disabled={pending}
        />
        <Button type="submit" disabled={pending || !text.trim()}>
          {pending ? "Thinking…" : "Send"}
        </Button>
      </form>
      {pending && <p className="text-xs opacity-60">Claude is looking through your data. This can take a minute.</p>}
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
