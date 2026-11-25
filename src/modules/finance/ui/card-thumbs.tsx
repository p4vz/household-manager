"use client";

import { createContext, useContext } from "react";

/**
 * Card pictures next to accounts on long lists (transactions). The pictures
 * travel to the browser once, in the provider, instead of once per row.
 */
const Thumbs = createContext<Record<string, string>>({});

export function CardThumbsProvider({ images, children }: { images: Record<string, string>; children: React.ReactNode }) {
  return <Thumbs.Provider value={images}>{children}</Thumbs.Provider>;
}

export function CardThumb({ accountId, className = "h-5" }: { accountId: string; className?: string }) {
  const src = useContext(Thumbs)[accountId];
  if (!src) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className={`${className} inline-block aspect-[1.586] rounded-sm border object-cover align-middle`} />;
}
