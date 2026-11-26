import "server-only";
import { checkOutboundUrl } from "./hosts";

/**
 * The only way server code may reach the network. Enforces https and the
 * host allowlist, and refuses redirects so an allowed host cannot bounce a
 * request (and its credentials) somewhere else. A test fails the build if
 * `fetch(` appears anywhere else under src/.
 */
export const outboundFetch: typeof fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  checkOutboundUrl(url);
  return fetch(input, { ...init, redirect: "error" });
};

/**
 * For keyless public GETs only (calendar feeds): follows up to `max`
 * redirects itself, each one to an https host on the allowlist, so a public
 * feed that moves to another allowed URL still works. Never use it for calls
 * that carry credentials.
 */
export async function outboundPublicGet(url: string, init: { headers?: Record<string, string> } = {}, max = 3): Promise<Response> {
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    checkOutboundUrl(current);
    const res = await fetch(current, { method: "GET", headers: init.headers, redirect: "manual" });
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
    const location = res.headers.get("location");
    if (!location || hop >= max) throw new Error(`too many redirects (last to ${location ?? "nowhere"})`);
    current = new URL(location, current);
  }
}

/** A readable reason for a failed fetch: undici's "fetch failed" hides the real one in `cause`. */
export function fetchErrorReason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause as { code?: string; message?: string } | undefined;
  const detail = cause?.code ?? cause?.message;
  return detail && !err.message.includes(detail) ? `${err.message} (${detail})` : err.message;
}
