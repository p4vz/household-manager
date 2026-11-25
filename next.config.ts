import type { NextConfig } from "next";

/**
 * Security headers applied to every response. The app has no public API and
 * is never embedded, so framing is denied and the browser may only talk to
 * our own origin. All third-party calls (SimpleFIN, Gemini, Anthropic,
 * Google OAuth token exchange) happen server-side; see docs/SECURITY.md.
 *
 * The Content-Security-Policy is not here: it carries a per-request script
 * nonce, so the proxy sets it (src/proxy.ts, src/core/security/csp.ts).
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The Agent SDK starts Claude Code from its platform package at runtime; keep it out of the bundle.
  serverExternalPackages: ["postgres", "@anthropic-ai/claude-agent-sdk"],
  experimental: {
    // Simplifi CSV history uploads.
    serverActions: { bodySizeLimit: "15mb" },
    proxyClientMaxBodySize: "15mb",
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
