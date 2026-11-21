import { json, notFound, preflight } from "@/core/oauth/http";
import { authorizationServerMetadata, oauthConfig } from "@/core/oauth/policy";

export const dynamic = "force-dynamic";

/** RFC 8414 discovery. */
export async function GET() {
  const config = oauthConfig();
  return config ? json(authorizationServerMetadata(config), 200, { "Cache-Control": "public, max-age=3600" }) : notFound();
}

export const OPTIONS = preflight;
