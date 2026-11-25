import Link from "next/link";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { appOrigin } from "@/core/auth/origin";
import { MailConnectError, finishMailConnect, memberFromLabel, scanMemberMailboxes } from "@/modules/family/api";

/**
 * Google sends the member back here after "Connect Gmail". The one-time
 * state (bound to this member) and PKCE verifier are checked in
 * finishMailConnect; the first scan then runs in the background.
 */
export default async function GmailCallbackPage({ searchParams }: PageProps<"/settings/email/callback">) {
  const user = await requireUserOrRedirect();
  const member = memberFromLabel(user.owner);
  const raw = await searchParams;
  const one = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");

  let error: string | null = null;
  if (one("error")) {
    error = one("error") === "access_denied" ? "Google sign-in was cancelled. Nothing was connected." : "Google sign-in did not finish. Nothing was connected.";
  } else if (!one("code") || !one("state")) {
    error = "This link is missing its sign-in details. Start again from Settings.";
  } else {
    try {
      await finishMailConnect({ member, state: one("state"), code: one("code"), origin: await appOrigin() });
    } catch (err) {
      error = err instanceof MailConnectError ? err.message : "Could not connect that mailbox. Try again.";
    }
  }
  if (!error) {
    after(() => scanMemberMailboxes(member).then(() => undefined, () => undefined));
    redirect("/settings?mail=connected#email");
  }
  return (
    <section className="max-w-xl space-y-3 rounded-xl border p-6">
      <h1 className="text-xl font-semibold">Gmail not connected</h1>
      <p className="text-sm opacity-80">{error}</p>
      <Link href="/settings#email" className="underline">
        Back to Settings
      </Link>
    </section>
  );
}
