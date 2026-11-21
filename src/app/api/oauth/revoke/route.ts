import { clientAddress, rateLimit } from "@/core/net/rate-limit";
import { notFound, preflight, readForm, tooMany, CORS } from "@/core/oauth/http";
import { oauthConfig } from "@/core/oauth/policy";
import { revokeToken } from "@/core/oauth/server";

export const dynamic = "force-dynamic";

/** RFC 7009. Always 200, as the RFC requires, whether or not the token was known. */
export async function POST(req: Request) {
  if (!oauthConfig()) return notFound();
  if (!rateLimit(`revoke:${clientAddress(req)}`, 30, 600_000)) return tooMany();
  const token = (await readForm(req)).get("token");
  if (token) await revokeToken(token);
  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store", ...CORS } });
}

export const OPTIONS = preflight;
