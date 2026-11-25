import Link from "next/link";
import { signOut } from "@/core/auth/config";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { KitchenModeButton } from "@/components/kitchen-mode-button";
import { MODULE_DEFINITIONS } from "@/modules/registry";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUserOrRedirect();

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/signin" });
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b px-4 py-3 text-sm sm:px-6">
        <Link href="/" className="font-semibold">Household</Link>
        <nav className="order-last flex w-full gap-4 overflow-x-auto whitespace-nowrap sm:order-none sm:w-auto">
          {MODULE_DEFINITIONS.map((m) => (
            <Link key={m.name} href={m.href} className="opacity-80 hover:opacity-100">
              {m.title}
            </Link>
          ))}
          <Link href="/assistant" className="opacity-80 hover:opacity-100">Ask Claude</Link>
          <Link href="/settings" className="opacity-80 hover:opacity-100">Settings</Link>
        </nav>
        <form action={doSignOut} className="ml-auto flex items-center gap-3">
          <KitchenModeButton className="rounded-lg border px-3 py-1.5 font-medium" />
          <span className="opacity-60">{user.owner}</span>
          <button type="submit" className="underline">Sign out</button>
        </form>
      </header>
      <main className="flex-1 p-4 sm:p-6">{children}</main>
    </div>
  );
}
