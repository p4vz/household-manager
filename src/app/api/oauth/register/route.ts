import { clientAddress, rateLimit } from "@/core/net/rate-limit";
import { json, notFound, oauthError, preflight, tooMany } from "@/core/oauth/http";
import { oauthConfig } from "@/core/oauth/policy";
import { OauthError, registerClient } from "@/core/oauth/server";

export const dynamic = "force-dynamic";

/**
 * RFC 7591 dynamic client registration. Open by design (Claude, ChatGPT and
 * Gemini register themselves), but it grants nothing: redirect URIs must be
 * on the allowed hosts, no secret is issued, and nothing is readable until a
 * household member approves on the consent page.
 */
export async function POST(req: Request) {
  if (!oauthConfig()) return notFound();
  if (!rateLimit(`register:${clientAddress(req)}`, 10, 3_600_000) || !rateLimit("register:all", 30, 86_400_000)) return tooMany();
  try {
    const text = (await req.text()).slice(0, 16_384);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OauthError("invalid_client_metadata", "Body must be JSON");
    }
    if (!body || typeof body !== "object") throw new OauthError("invalid_client_metadata", "Body must be a JSON object");
    return json(await registerClient(body), 201);
  } catch (err) {
    if (err instanceof OauthError && err.code === "invalid_redirect_uri") console.warn(`[oauth] refused registration: ${err.message}`);
    return oauthError(err);
  }
}

export const OPTIONS = preflight;
