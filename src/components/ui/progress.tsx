import type * as React from "react";
import { cn } from "@/lib/utils";

/** Horizontal bar; `value` is 0-100 (clamped), `indicatorClassName` sets the fill color. */
function Progress({
  className,
  value,
  indicatorClassName,
  ...props
}: React.ComponentProps<"div"> & { value: number; indicatorClassName?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      data-slot="progress"
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-primary/15", className)}
      {...props}
    >
      <div className={cn("h-full rounded-full bg-primary transition-all", indicatorClassName)} style={{ width: `${pct}%` }} />
    </div>
  );
}

export { Progress };
