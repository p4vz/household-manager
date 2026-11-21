import { clientAddress, rateLimit } from "@/core/net/rate-limit";
import { notFound } from "@/core/oauth/http";
import { MCP_SCOPE, oauthConfig, wwwAuthenticate } from "@/core/oauth/policy";
import { verifyAccessToken } from "@/core/oauth/server";
import { handleMcpRequest } from "@/mcp/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The assistant (MCP) endpoint: Streamable HTTP, read-only tools, OAuth
 * bearer tokens only. A request without a valid token gets 401 with the
 * protected-resource metadata link, which is how Claude, ChatGPT and
 * Gemini find the authorization server.
 */
async function handle(req: Request): Promise<Response> {
  const config = oauthConfig();
  if (!config) return notFound();
  if (!rateLimit(`mcp-ip:${clientAddress(req)}`, 300, 60_000)) return new Response(null, { status: 429, headers: { "Retry-After": "60" } });

  const header = req.headers.get("authorization") ?? "";
  const token = /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : null;
  const caller = await verifyAccessToken(token, config);
  if (!caller) {
    return Response.json(
      { error: "invalid_token", error_description: "Connect this assistant through OAuth" },
      { status: 401, headers: { "WWW-Authenticate": wwwAuthenticate(config, token ? "invalid_token" : undefined), "Cache-Control": "no-store" } },
    );
  }
  if (!caller.scopes.includes(MCP_SCOPE)) {
    return new Response(null, { status: 403, headers: { "WWW-Authenticate": wwwAuthenticate(config, "insufficient_scope") } });
  }
  if (!rateLimit(`mcp-grant:${caller.grantId}`, 120, 60_000)) return new Response(null, { status: 429, headers: { "Retry-After": "60" } });

  // Browsers are not MCP clients here; refuse any cross-site page using a stolen token.
  const origin = req.headers.get("origin");
  if (origin && origin !== config.issuer) return new Response(null, { status: 403 });

  return handleMcpRequest(req, caller);
}

export { handle as GET, handle as POST, handle as DELETE };
