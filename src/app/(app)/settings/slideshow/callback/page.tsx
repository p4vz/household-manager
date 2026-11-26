import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { appOrigin } from "@/core/auth/origin";
import { SlideshowError, finishPhotosConnect } from "@/modules/family/api";

/**
 * Google sends the member back here after "Choose photos". The one-time
 * state (bound to this member) and the PKCE verifier are checked in
 * finishPhotosConnect, which then opens the Google Photos picker session.
 */
export default async function PhotosCallbackPage({ searchParams }: PageProps<"/settings/slideshow/callback">) {
  const user = await requireUserOrRedirect();
  const raw = await searchParams;
  const one = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");

  let error: string | null = null;
  if (one("error")) {
    error = one("error") === "access_denied" ? "Google sign-in was cancelled. Nothing changed." : "Google sign-in did not finish. Nothing changed.";
  } else if (!one("code") || !one("state")) {
    error = "This link is missing its sign-in details. Start again from Settings.";
  } else {
    try {
      await finishPhotosConnect({ member: user.owner, state: one("state"), code: one("code"), origin: await appOrigin() });
    } catch (err) {
      error = err instanceof SlideshowError ? err.message : "Could not open Google Photos. Try again.";
    }
  }
  if (!error) redirect("/settings?slideshow=pick#slideshow");
  return (
    <section className="max-w-xl space-y-3 rounded-xl border p-6">
      <h1 className="text-xl font-semibold">Google Photos not opened</h1>
      <p className="text-sm opacity-80">{error}</p>
      <Link href="/settings#slideshow" className="underline">
        Back to Settings
      </Link>
    </section>
  );
}
