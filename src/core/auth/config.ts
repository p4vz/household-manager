import "server-only";
import NextAuth, { customFetch } from "next-auth";
import Google from "next-auth/providers/google";
import { isAllowedEmail, parseAllowlist } from "./allowlist";
import { outboundFetch } from "@/core/net/outbound";

/**
 * Read the allowlist straight from process.env on every check so a change to
 * ALLOWED_EMAILS takes effect on the next request and also invalidates
 * existing sessions (see the session callback).
 */
const allowlist = () => parseAllowlist(process.env.ALLOWED_EMAILS);

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 14 },
  trustHost: true,
  pages: { signIn: "/signin", error: "/signin" },
  providers: [
    Google({
      // OAuth token/userinfo calls go through the outbound allowlist too.
      [customFetch]: outboundFetch,
      authorization: { params: { prompt: "select_account" } },
    }),
  ],
  callbacks: {
    signIn({ account, profile }) {
      if (account?.provider !== "google") return false;
      if (profile?.email_verified !== true) return false;
      return isAllowedEmail(profile?.email, allowlist());
    },
    jwt({ token }) {
      // A removed address loses access on its next request.
      if (!isAllowedEmail(token.email, allowlist())) return null;
      return token;
    },
    session({ session }) {
      return session;
    },
  },
});
