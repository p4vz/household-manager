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
