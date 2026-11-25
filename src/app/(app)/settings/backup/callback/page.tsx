import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { appOrigin } from "@/core/auth/origin";
import { DriveError, finishDriveConnect } from "@/core/backup/drive";

/**
 * Google sends the member back here after "Connect Google Drive". The
 * one-time state (bound to this member) and the PKCE verifier are checked
 * in finishDriveConnect.
 */
export default async function DriveCallbackPage({ searchParams }: PageProps<"/settings/backup/callback">) {
  const user = await requireUserOrRedirect();
  const raw = await searchParams;
  const one = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");

  let error: string | null = null;
  if (one("error")) {
    error = one("error") === "access_denied" ? "Google sign-in was cancelled. Nothing was connected." : "Google sign-in did not finish. Nothing was connected.";
  } else if (!one("code") || !one("state")) {
    error = "This link is missing its sign-in details. Start again from Settings.";
  } else {
    try {
      await finishDriveConnect({ member: user.owner, state: one("state"), code: one("code"), origin: await appOrigin() });
    } catch (err) {
      error = err instanceof DriveError ? err.message : "Could not connect Google Drive. Try again.";
    }
  }
  if (!error) redirect("/settings?backup=connected#backups");
  return (
    <section className="max-w-xl space-y-3 rounded-xl border p-6">
      <h1 className="text-xl font-semibold">Google Drive not connected</h1>
      <p className="text-sm opacity-80">{error}</p>
      <Link href="/settings#backups" className="underline">
        Back to Settings
      </Link>
    </section>
  );
}
