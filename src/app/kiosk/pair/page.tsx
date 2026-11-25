import { redirect } from "next/navigation";
import { currentKioskDevice } from "@/core/kiosk/devices";
import { PairForm } from "./pair-form";

export const metadata = { title: "Pair kitchen screen" };

/**
 * Public: shows a code box and nothing else. A screen that is already
 * paired goes straight to the kiosk.
 */
export default async function PairPage() {
  if (await currentKioskDevice()) redirect("/kiosk");
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6 rounded-2xl border p-8">
        <h1 className="text-3xl font-semibold">Pair this screen</h1>
        <p className="opacity-80">
          On your phone, open Aprelev Household → Settings → Kitchen kiosk and tap <b>Make pairing code</b>. Type the code here.
        </p>
        <PairForm />
      </div>
    </main>
  );
}
