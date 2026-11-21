import { json, notFound, preflight } from "@/core/oauth/http";
import { oauthConfig, protectedResourceMetadata } from "@/core/oauth/policy";

export const dynamic = "force-dynamic";

/** RFC 9728, at the root and at the path-suffixed form (/api/mcp) clients also try. */
export async function GET() {
  const config = oauthConfig();
  return config ? json(protectedResourceMetadata(config), 200, { "Cache-Control": "public, max-age=3600" }) : notFound();
}

export const OPTIONS = preflight;
