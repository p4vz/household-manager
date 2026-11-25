import Link from "next/link";
import { signOut } from "@/core/auth/config";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { MODULE_DEFINITIONS } from "@/modules/registry";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUserOrRedirect();

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/signin" });
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center gap-6 border-b px-6 py-3 text-sm">
        <Link href="/" className="font-semibold">Household</Link>
        <nav className="flex gap-4">
          {MODULE_DEFINITIONS.map((m) => (
            <Link key={m.name} href={m.href} className="opacity-80 hover:opacity-100">
              {m.title}
            </Link>
          ))}
          <Link href="/assistant" className="opacity-80 hover:opacity-100">Ask Claude</Link>
          <Link href="/settings" className="opacity-80 hover:opacity-100">Settings</Link>
        </nav>
        <form action={doSignOut} className="ml-auto flex items-center gap-3">
          <span className="opacity-60">{user.owner}</span>
          <button type="submit" className="underline">Sign out</button>
        </form>
      </header>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
