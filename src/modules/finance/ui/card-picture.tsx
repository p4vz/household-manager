"use client";

import { startTransition, useActionState, useRef, useState } from "react";

type State = null | { ok: true } | { ok: false; error: string };

const MAX_SIDE = 900;

/**
 * Shrinks the photo in the browser and re-encodes it as JPEG. Re-encoding
 * drops the photo's metadata (location, camera), and the smaller file keeps
 * the Accounts page light.
 */
export async function shrink(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not read the picture"))), "image/jpeg", 0.85),
  );
}

export function CardPictureUpload({
  accountId,
  hasPicture,
  upload,
  disabled,
}: {
  accountId: string;
  hasPicture: boolean;
  upload: (prev: State, form: FormData) => Promise<State>;
  disabled?: boolean;
}) {
  const [state, run, pending] = useActionState(upload, null);
  const [localError, setLocalError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function onPick(file: File | undefined) {
    if (!file) return;
    setLocalError(null);
    try {
      const blob = await shrink(file);
      const form = new FormData();
      form.set("accountId", accountId);
      form.set("file", new File([blob], "card.jpg", { type: "image/jpeg" }));
      startTransition(() => run(form));
    } catch {
      setLocalError("Could not read that picture. Try a JPEG or PNG.");
    } finally {
      if (input.current) input.current.value = "";
    }
  }

  const error = localError ?? (state && !state.ok ? state.error : null);
  return (
    <div className="space-y-1 text-xs">
      <label className={`inline-block cursor-pointer rounded border px-2 py-1 ${disabled || pending ? "pointer-events-none opacity-50" : ""}`}>
        {pending ? "Saving…" : hasPicture ? "Replace picture" : "Add picture"}
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic"
          className="sr-only"
          disabled={disabled || pending}
          onChange={(e) => onPick(e.target.files?.[0])}
        />
      </label>
      {error ? <p className="text-destructive">{error}</p> : null}
    </div>
  );
}
