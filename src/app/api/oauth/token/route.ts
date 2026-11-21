import { clientAddress, rateLimit } from "@/core/net/rate-limit";
import { json, notFound, oauthError, preflight, readForm, tooMany } from "@/core/oauth/http";
import { oauthConfig } from "@/core/oauth/policy";
import { OauthError, exchangeCode, refreshAccess } from "@/core/oauth/server";

export const dynamic = "force-dynamic";

/** Authorization-code (PKCE S256) and refresh-token grants for public clients. */
export async function POST(req: Request) {
  const config = oauthConfig();
  if (!config) return notFound();
  if (!rateLimit(`token:${clientAddress(req)}`, 60, 600_000)) return tooMany();
  try {
    const form = await readForm(req);
    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      const code = form.get("code");
      const verifier = form.get("code_verifier");
      const clientId = form.get("client_id");
      if (!code || !verifier || !clientId) throw new OauthError("invalid_request", "code, code_verifier and client_id are required");
      return json(
        await exchangeCode({ code, verifier, clientId, redirectUri: form.get("redirect_uri"), resource: form.get("resource") }, config),
      );
    }
    if (grant === "refresh_token") {
      const refreshToken = form.get("refresh_token");
      if (!refreshToken) throw new OauthError("invalid_request", "refresh_token is required");
      return json(await refreshAccess({ refreshToken, clientId: form.get("client_id") }));
    }
    throw new OauthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported");
  } catch (err) {
    return oauthError(err);
  }
}

export const OPTIONS = preflight;
