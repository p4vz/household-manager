"use client";

import { useRouter } from "next/navigation";
import { enterFullscreen, rememberKitchenFullscreen } from "@/lib/fullscreen";

/**
 * Switches this device to the kitchen screen: full screen (hiding the
 * browser's address and tab bars, which Chrome in Samsung DeX shows even for
 * an installed app) and the /kiosk view. A signed-in parent can open /kiosk
 * directly; the kiosk offers one-tap pairing so it keeps working after
 * signing out. Where full screen isn't allowed it still opens the view.
 */
export function KitchenModeButton({ className, label = "Kitchen mode" }: { className?: string; label?: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        rememberKitchenFullscreen(true);
        // Ask while still inside the tap; the client-side navigation keeps the page in full screen.
        await enterFullscreen();
        router.push("/kiosk");
      }}
    >
      🍳 {label}
    </button>
  );
}
