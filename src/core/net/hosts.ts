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
  // Gmail, read-only, for return emails (family/mail.ts)
  "gmail.googleapis.com",
  // SimpleFIN Bridge
  "bridge.simplefin.org",
  "beta-bridge.simplefin.org",
  // AI providers
  "generativelanguage.googleapis.com",
  "api.anthropic.com",
  // Trips: keyless reference data (no credentials are ever sent)
  "geocoding-api.open-meteo.com",
  "api.open-meteo.com",
  "en.wikipedia.org",
  "overpass-api.de",
  // House upkeep: CPSC product recalls (keyless; only a product phrase is sent)
  "www.saferproducts.gov",
  // Car upkeep: NHTSA vehicle recalls (keyless; only make, model and year are sent)
  "api.nhtsa.gov",
] as const;

export const OUTBOUND_HOSTS: ReadonlySet<string> = new Set<string>(STATIC_OUTBOUND_HOSTS);

export function checkOutboundUrl(url: URL, hosts: ReadonlySet<string> = OUTBOUND_HOSTS): void {
  if (url.protocol !== "https:") {
    throw new OutboundBlockedError(`Outbound call must use https: ${url.protocol}`);
  }
  if (url.port !== "" && url.port !== "443") {
    throw new OutboundBlockedError(`Outbound call on non-standard port: ${url.port}`);
  }
  if (!hosts.has(url.hostname.toLowerCase())) {
    throw new OutboundBlockedError(`Outbound host not allowlisted: ${url.hostname}`);
  }
}

export class OutboundBlockedError extends Error {}
