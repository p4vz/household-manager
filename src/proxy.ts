import { NextResponse } from "next/server";
import { auth } from "@/core/auth/config";
import { isAllowedEmail, parseAllowlist } from "@/core/auth/allowlist";
import { CONSENT_PATH, isAssistantPath, isCronPath, isPublicPath } from "@/core/auth/public-paths";

/**
 * First gate for every request. Allowlisted Google session, or nothing.
 * Cron paths pass through only with a bearer header and are verified in
 * their handler with a constant-time secret compare.
 */
export const proxy = auth((req) => {
  const { pathname } = req.nextUrl;

  if (isPublicPath(pathname)) return NextResponse.next();

  // Assistant endpoints carry their own credential, checked in the handler.
  if (isAssistantPath(pathname)) return NextResponse.next();

  if (isCronPath(pathname)) {
    return req.headers.get("authorization")?.startsWith("Bearer ")
      ? NextResponse.next()
      : new NextResponse(null, { status: 401 });
  }

  const email = req.auth?.user?.email;
  if (isAllowedEmail(email, parseAllowlist(process.env.ALLOWED_EMAILS))) {
    return NextResponse.next();
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
 * `.well-known/` is skipped: those discovery documents are public and
 * cacheable (`Cache-Control: public`), and running them through auth() would
 * attach Auth.js cookies that a shared cache could store and replay.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|\\.well-known/).*)"],
};
