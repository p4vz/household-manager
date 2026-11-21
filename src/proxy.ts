import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { auth } from "@/core/auth/config";
import { isAllowedEmail, parseAllowlist } from "@/core/auth/allowlist";
import { CONSENT_PATH, isAssistantPath, isCronPath, isPublicPath } from "@/core/auth/public-paths";
import { contentSecurityPolicy, createNonce } from "@/core/security/csp";

const CSP = "Content-Security-Policy";

/**
 * Let the request through with this request's CSP on it. Next.js reads the
 * nonce from the request header while rendering and puts it on its scripts.
 */
function pass(req: NextRequest, policy: string): NextResponse {
  const headers = new Headers(req.headers);
  headers.set(CSP, policy);
  return NextResponse.next({ request: { headers } });
}

/**
 * First gate for every request. Allowlisted Google session, or nothing.
 * Cron paths pass through only with a bearer header and are verified in
 * their handler with a constant-time secret compare.
 */
const gate = (policy: string) =>
  auth((req) => {
    const { pathname } = req.nextUrl;

    if (isPublicPath(pathname)) return pass(req, policy);

    if (isCronPath(pathname)) {
      return req.headers.get("authorization")?.startsWith("Bearer ")
        ? pass(req, policy)
        : new NextResponse(null, { status: 401 });
    }

    const email = req.auth?.user?.email;
    if (isAllowedEmail(email, parseAllowlist(process.env.ALLOWED_EMAILS))) {
      return pass(req, policy);
    }

    if (pathname.startsWith("/api/")) {
      return new NextResponse(null, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/signin";
    url.search = "";
    if (pathname === CONSENT_PATH) url.searchParams.set("callbackUrl", `${CONSENT_PATH}${req.nextUrl.search}`);
    return NextResponse.redirect(url);
  });

/**
 * Every response gets a CSP with a fresh nonce (src/core/security/csp.ts).
 *
 * Assistant endpoints carry their own credential, checked in the handler.
 * They bypass Auth.js entirely: its wrapper sets CSRF and callback-url
 * cookies, which must not ride on the publicly cached discovery documents.
 */
export async function proxy(req: NextRequest, event: NextFetchEvent): Promise<Response> {
  const policy = contentSecurityPolicy(createNonce());
  const res = isAssistantPath(req.nextUrl.pathname)
    ? pass(req, policy)
    : // auth() is overloaded for route handlers too; in the proxy Next passes (request, event).
      await (gate(policy) as unknown as (r: NextRequest, e: NextFetchEvent) => Promise<Response>)(req, event);
  res.headers.set(CSP, policy);
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
