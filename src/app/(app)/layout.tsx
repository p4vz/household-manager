import Image from "next/image";
import Link from "next/link";
import { signOut } from "@/core/auth/config";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { KitchenModeButton } from "@/components/kitchen-mode-button";
import { enterKitchenModeAction } from "../kiosk/pair/actions";
import { MODULE_DEFINITIONS } from "@/modules/registry";
import { AppNav } from "@/components/app-nav";

const NAV = [
  { href: "/", label: "Home" },
  ...MODULE_DEFINITIONS.map((m) => ({ href: m.href, label: m.title })),
  { href: "/assistant", label: "Ask Claude" },
  { href: "/settings", label: "Settings" },
];

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUserOrRedirect();

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/signin" });
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b bg-background text-sm print:hidden">
        <div className="flex items-center gap-x-4 px-4 pt-3 pb-2 sm:px-6 lg:pb-3">
          <Link href="/" className="flex shrink-0 items-center gap-2 font-semibold">
            <Image src="/icons/icon.svg" alt="" unoptimized width={24} height={24} className="h-6 w-6" />
            <span className="hidden min-[420px]:inline">Aprelev Household</span>
            <span className="min-[420px]:hidden">Aprelev</span>
          </Link>
          <AppNav items={NAV} className="hidden min-w-0 lg:block" />
          <form action={doSignOut} className="ml-auto flex shrink-0 items-center gap-3">
            <KitchenModeButton className="rounded-full border px-3 py-1.5 font-medium hover:bg-muted" enter={enterKitchenModeAction} />
            <span className="hidden text-muted-foreground sm:inline">{user.owner}</span>
            <button type="submit" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">Sign out</button>
          </form>
        </div>
        <AppNav items={NAV} className="px-3 pb-2 sm:px-5 lg:hidden" />
      </header>
      <main className="flex-1 p-4 sm:p-6">{children}</main>
    </div>
  );
}
