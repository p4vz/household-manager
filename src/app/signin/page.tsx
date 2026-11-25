import { redirect } from "next/navigation";
import { signIn } from "@/core/auth/config";
import { currentUser } from "@/core/auth/guard";

export default async function SignInPage({ searchParams }: PageProps<"/signin">) {
  const { error, callbackUrl } = await searchParams;
  // Only the assistant consent screen may be returned to; anything else goes home.
  const target = typeof callbackUrl === "string" && /^\/oauth\/authorize\?[^\\]*$/.test(callbackUrl) ? callbackUrl : "/";
  if (await currentUser()) redirect(target);

  async function signInWithGoogle() {
    "use server";
    await signIn("google", { redirectTo: target });
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <form action={signInWithGoogle} className="w-full max-w-sm space-y-4 rounded-xl border p-8">
        <h1 className="text-xl font-semibold">Household</h1>
        <p className="text-sm opacity-70">Private app. Only invited Google accounts can sign in.</p>
        {error ? (
          <p className="rounded bg-red-500/10 p-2 text-sm text-red-600">
            That account is not allowed to sign in.
          </p>
        ) : null}
        <button type="submit" className="w-full rounded-lg bg-foreground px-4 py-2 text-background">
          Sign in with Google
        </button>
        <p className="text-center text-xs opacity-60">
          <a className="underline" href="/privacy">
            Privacy policy
          </a>
        </p>
      </form>
    </main>
  );
}
