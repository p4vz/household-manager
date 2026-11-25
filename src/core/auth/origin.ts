import "server-only";
import { headers } from "next/headers";

/**
 * The app's public origin, for redirect URIs handed to Google. AUTH_URL wins
 * when set. Otherwise the request's host is used: a forged Host header can
 * only produce a redirect URI that Google refuses, since Google accepts only
 * the URIs registered on the OAuth client.
 */
export async function appOrigin(): Promise<string> {
  const fixed = process.env.AUTH_URL;
  if (fixed) return new URL(fixed).origin;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto.split(",")[0].trim()}://${host.split(",")[0].trim()}`;
}
