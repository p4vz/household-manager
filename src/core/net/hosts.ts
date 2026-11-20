/**
 * The complete list of hosts this server may call. Anything else is refused
 * before a socket is opened. Add a host here only with a matching entry in
 * docs/SECURITY.md.
 */
export const STATIC_OUTBOUND_HOSTS = [
  // Google sign-in (Auth.js token exchange / userinfo / JWKS)
  "accounts.google.com",
  "oauth2.googleapis.com",
  "openidconnect.googleapis.com",
  "www.googleapis.com",
  // SimpleFIN Bridge
  "bridge.simplefin.org",
  "beta-bridge.simplefin.org",
  // AI providers
  "generativelanguage.googleapis.com",
  "api.anthropic.com",
] as const;

export function allowedHosts(simplefinAccessUrl?: string): Set<string> {
  const hosts = new Set<string>(STATIC_OUTBOUND_HOSTS);
  // The SimpleFIN access URL may point at a different bridge host; allow
  // exactly that host and nothing else.
  if (simplefinAccessUrl) {
    try {
      hosts.add(new URL(simplefinAccessUrl).hostname.toLowerCase());
    } catch {
      /* invalid URL: ignored, the call will fail closed */
    }
  }
  return hosts;
}

export function checkOutboundUrl(url: URL, hosts: Set<string>): void {
  if (url.protocol !== "https:") {
    throw new OutboundBlockedError(`Outbound call must use https: ${url.protocol}`);
  }
  if (!hosts.has(url.hostname.toLowerCase())) {
    throw new OutboundBlockedError(`Outbound host not allowlisted: ${url.hostname}`);
  }
}

export class OutboundBlockedError extends Error {}
