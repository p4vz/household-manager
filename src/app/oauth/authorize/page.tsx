import { redirect } from "next/navigation";
import { currentUser } from "@/core/auth/guard";
import { checkAuthorizeRequest, type AuthorizeParams } from "@/core/oauth/authorize";
import { oauthConfig } from "@/core/oauth/policy";
import { hostOf } from "@/core/oauth/server";
import { decideAuthorization } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connect an assistant" };

const FIELDS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "scope", "state", "resource"] as const;

/**
 * Consent screen. The proxy already requires an allowlisted session; the
 * page checks again and sends anyone else through Google sign-in first.
 */
export default async function AuthorizePage({ searchParams }: PageProps<"/oauth/authorize">) {
  const config = oauthConfig();
  if (!config) return <Message title="Assistant access is off" body="Set MCP_ENABLED=true and AUTH_URL to turn it on." />;

  const raw = await searchParams;
  const params: AuthorizeParams = {};
  for (const f of FIELDS) {
    const v = raw[f];
    if (typeof v === "string") params[f] = v;
  }

  const user = await currentUser();
  if (!user) {
    const self = `/oauth/authorize?${new URLSearchParams(params as Record<string, string>).toString()}`;
    redirect(`/signin?callbackUrl=${encodeURIComponent(self)}`);
  }

  const check = await checkAuthorizeRequest(params, config);
  if (check.kind === "fatal") return <Message title="This request cannot be approved" body={check.message} />;
  if (check.kind === "redirect") redirect(check.url);
  const r = check.request;

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <form action={decideAuthorization} className="w-full max-w-md space-y-4 rounded-xl border p-8">
        <h1 className="text-xl font-semibold">Connect {r.clientName}?</h1>
        <p className="text-sm opacity-80">
          An assistant at <strong>{hostOf(r.redirectUri)}</strong> is asking to read your household data as{" "}
          <strong>{user.owner}</strong>. Only approve if you just started connecting it yourself.
        </p>
        <div className="space-y-1 text-sm">
          <p className="font-medium">It will be able to read:</p>
          <ul className="list-disc space-y-1 pl-5 opacity-80">
            <li>Your credit cards by nickname, their reward rates, credits, perks and sign-up bonus progress</li>
            <li>Card advice for purchases and bookings, and the points-left-on-the-table summary</li>
            <li>Your trips and itineraries (no confirmation numbers, documents or traveller names)</li>
          </ul>
          <p className="pt-1 opacity-70">
            It cannot change anything, and never sees account numbers or legal names. You can disconnect it any time in Settings.
          </p>
        </div>
        {FIELDS.map((f) =>
          params[f] !== undefined ? <input key={f} type="hidden" name={f} value={params[f]} /> : null,
        )}
        <div className="flex gap-2">
          <button type="submit" name="decision" value="approve" className="rounded-lg bg-foreground px-4 py-2 text-background">
            Approve
          </button>
          <button type="submit" name="decision" value="deny" className="rounded-lg border px-4 py-2">
            Deny
          </button>
        </div>
      </form>
    </main>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md space-y-2 rounded-xl border p-8">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-sm opacity-80">{body}</p>
      </div>
    </main>
  );
}
