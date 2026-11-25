import { redirect } from "next/navigation";

// Bank sync now lives in Settings; keep the old link working.
export default function ConnectPage() {
  redirect("/settings#bank-sync");
}
