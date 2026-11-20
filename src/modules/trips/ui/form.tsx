/** Small shared bits for trip pages (server components). */
export const inputCls = "h-8 rounded-md border bg-background px-2 text-sm";
export const textareaCls = "min-h-20 rounded-md border bg-background px-2 py-1 text-sm";

export function ErrorBanner({ error }: { error?: string | string[] }) {
  const msg = Array.isArray(error) ? error[0] : error;
  if (!msg) return null;
  return <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{msg}</p>;
}

export function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1 text-sm ${className ?? ""}`}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
