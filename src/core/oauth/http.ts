import "server-only";
import { OauthError } from "./server";

/**
 * Response helpers for the public OAuth and discovery routes. CORS is open
 * only on these routes: they carry no cookies and answer only to bearer or
 * PKCE proofs, and browser-based MCP clients need to read them.
 */
export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version",
} as const;

export function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...CORS, ...extra } });
}

export function notFound() {
  return new Response(null, { status: 404 });
}

export function preflight() {
  return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Max-Age": "600" } });
}

export function oauthError(err: unknown) {
  if (err instanceof OauthError) return json({ error: err.code, error_description: err.message }, err.status);
  console.error(`[oauth] ${err instanceof Error ? err.message : String(err)}`);
  return json({ error: "server_error", error_description: "Unexpected error" }, 500);
}

export function tooMany() {
  return json({ error: "slow_down", error_description: "Too many requests" }, 429, { "Retry-After": "60" });
}

/** Token and revocation requests are form encoded; accept JSON too. Capped at 8 KB. */
export async function readForm(req: Request): Promise<URLSearchParams> {
  const text = (await req.text()).slice(0, 8192);
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      return new URLSearchParams(Object.entries(obj).filter(([, v]) => typeof v === "string") as [string, string][]);
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(text);
}
