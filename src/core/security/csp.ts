/**
 * Content-Security-Policy for every response, built per request in the
 * proxy (src/proxy.ts). Scripts run only if they carry this request's nonce
 * ('strict-dynamic' lets those scripts load the app's own chunks), so an
 * injected <script> or inline event handler is refused by the browser.
 *
 * Next.js reads the nonce from the request's CSP header while rendering and
 * stamps it on its own scripts, which is why every page renders per request
 * (see the root layout).
 *
 * Styles keep 'unsafe-inline': Recharts and next/font set style attributes,
 * which a nonce cannot cover. Adding a style nonce would make browsers ignore
 * 'unsafe-inline' and break the charts.
 */

/** Hosts the assistant consent form may redirect to (see DEFAULT_REDIRECT_HOSTS in src/core/oauth/policy.ts). */
const FORM_ACTION = [
  "'self'",
  "https://accounts.google.com",
  "https://claude.ai",
  "https://claude.com",
  "https://chatgpt.com",
  "https://oauth-redirect.googleusercontent.com",
  "https://oauth-redirect-sandbox.googleusercontent.com",
  "https://oauth-redirect-test.googleusercontent.com",
  "http://localhost:*",
  "http://127.0.0.1:*",
];

/** 128 random bits, base64. Fresh for every request. */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function contentSecurityPolicy(nonce: string, isDev = process.env.NODE_ENV !== "production"): string {
  if (!/^[A-Za-z0-9+/]{22}==$/.test(nonce)) throw new Error("CSP nonce must come from createNonce()");
  return [
    "default-src 'self'",
    // React needs eval in development only, for its error overlays.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "script-src-attr 'none'",
    // 'strict-dynamic' ignores 'self' for scripts, so the service worker
    // (public/sw.js) needs its own directive.
    "worker-src 'self'",
    "manifest-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://lh3.googleusercontent.com",
    "font-src 'self'",
    `connect-src 'self'${isDev ? " ws:" : ""}`,
    `form-action ${FORM_ACTION.join(" ")}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ");
}

/** OCR assets (public/ocr/): the in-browser screenshot reader's worker scripts and language data. */
export const OCR_ASSET_PREFIX = "/ocr/";

/**
 * Policy for the OCR worker scripts. A dedicated worker runs under the CSP of
 * its own script response, and Tesseract compiles WebAssembly and loads its
 * core with importScripts, both from this origin only. Pages never get
 * 'wasm-unsafe-eval'; only these static files do.
 */
export function ocrAssetPolicy(): string {
  return ["default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'"].join("; ");
}
