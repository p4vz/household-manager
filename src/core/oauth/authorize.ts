import "server-only";
import { getClient } from "./server";
import { MCP_SCOPE, assistantName, grantedScopes, isAllowedRedirectUri, isValidChallenge, resourceMatches, type OauthConfig } from "./policy";

export type AuthorizeParams = Partial<
  Record<"response_type" | "client_id" | "redirect_uri" | "code_challenge" | "code_challenge_method" | "scope" | "state" | "resource", string>
>;

export const MAX_STATE = 8192;

export type CheckedRequest = {
  clientId: string;
  clientName: string;
  /** Claude, ChatGPT or Gemini, from the redirect host; else the registered name. */
  assistant: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  state: string | null;
};

export type AuthorizeCheck =
  | { kind: "ok"; request: CheckedRequest }
  /** Client or redirect URI cannot be trusted: show the error, never redirect. */
  | { kind: "fatal"; message: string }
  /** Trusted redirect, bad request: send the error back to the client. */
  | { kind: "redirect"; url: string };

/** Build the redirect back to the client, with RFC 9207 `iss` on every response. */
export function clientRedirect(redirectUri: string, params: Record<string, string | null>, config: OauthConfig): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  url.searchParams.set("iss", config.issuer);
  return url.toString();
}

export async function checkAuthorizeRequest(p: AuthorizeParams, config: OauthConfig): Promise<AuthorizeCheck> {
  if (!p.client_id || !p.redirect_uri) return { kind: "fatal", message: "The request is missing a client or redirect URI." };
  const client = await getClient(p.client_id);
  if (!client) return { kind: "fatal", message: "That application is not registered with this server." };
  // Exact match only. A prefix match is how redirect hijacking happens.
  if (!client.redirectUris.includes(p.redirect_uri)) {
    return { kind: "fatal", message: "That redirect URI was not registered by this application." };
  }
  // Checked again here, not only at registration, so tightening the list
  // also stops clients that registered before.
  if (!isAllowedRedirectUri(p.redirect_uri)) {
    console.warn(`[oauth] refused authorize redirect: ${p.redirect_uri.slice(0, 200)}`);
    return { kind: "fatal", message: "That redirect URI is not allowed by this server." };
  }
  // State goes back byte for byte (Gemini's is ~1,400 characters). Refuse
  // rather than silently drop one that is absurdly long.
  if (p.state !== undefined && p.state.length > MAX_STATE) {
    return { kind: "fatal", message: "The state parameter is too long." };
  }
  const state = p.state ?? null;
  const fail = (error: string, description: string): AuthorizeCheck => ({
    kind: "redirect",
    url: clientRedirect(p.redirect_uri!, { error, error_description: description, state }, config),
  });
  if (p.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");
  if ((p.code_challenge_method ?? "") !== "S256" || !isValidChallenge(p.code_challenge)) {
    return fail("invalid_request", "PKCE with S256 is required");
  }
  const scopes = grantedScopes(p.scope);
  if (!scopes) return fail("invalid_scope", `Only ${MCP_SCOPE} is available`);
  if (!resourceMatches(p.resource, config)) return fail("invalid_target", "Resource is not this server");
  return {
    kind: "ok",
    request: {
      clientId: client.clientId,
      clientName: client.name,
      assistant: assistantName(p.redirect_uri, client.name),
      redirectUri: p.redirect_uri,
      codeChallenge: p.code_challenge!,
      scope: scopes.join(" "),
      resource: config.resource,
      state,
    },
  };
}
