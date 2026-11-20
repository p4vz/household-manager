# Security boundaries

Inside the app, modules share data freely (see ARCHITECTURE.md). At the
edge of the app, everything is closed by default. This page is the complete
list of what may come in and what may go out. Changing any of it needs an
update here and in the tests that enforce it.

## Who can get in

- **Google sign-in only**, via Auth.js v5. No passwords, no other providers.
- **Two-address allowlist.** `ALLOWED_EMAILS` holds exactly the household's
  two Gmail addresses. The check is an exact, case-insensitive match on the
  full address (no domains, no `+` aliases) and Google must report the
  address as verified.
- The allowlist is checked at every layer:
  1. Auth.js `signIn` callback refuses the sign-in.
  2. Auth.js `jwt` callback drops an existing session whose address is no
     longer listed, on its next request.
  3. `src/proxy.ts` refuses every request without an allowlisted session
     (redirect to `/signin` for pages, `401` for `/api/*`).
  4. Every page calls `requireUserOrRedirect()`, and every Server Action is
     built with `authedAction()`, which calls `requireUser()`. Server Actions
     are POST endpoints in Next.js, so the proxy alone is not trusted.
- Household members are identified to the rest of the system as `User 1` /
  `User 2` (by allowlist position), never by name.

## What is reachable over HTTP

| Path | Who | How it is protected |
| --- | --- | --- |
| `/signin` | anyone | shows the Google button, nothing else |
| `/api/auth/*` | anyone | Auth.js OAuth flow; allowlist enforced in callbacks |
| `/api/cron/simplefin-sync`, `/api/cron/monthly-advisor`, `/api/cron/card-catalog` | Railway cron only | `Authorization: Bearer $CRON_SECRET`, constant-time compare, fails closed if the secret is missing or short |
| everything else | allowlisted users | session + allowlist (proxy and in-handler) |

There is **no public API**. The module API and the event bus are plain
in-process function calls; no route, queue or socket exposes them.
`tests/boundaries.test.ts` fails CI if a route handler appears outside
`/api/auth` and `/api/cron`, or a cron route skips the secret check.

## What the server may call

All outbound traffic goes through `src/core/net/outbound.ts`, which requires
https on port 443, checks the host against the list below, and refuses
redirects. CI
fails if `fetch(` is used anywhere else.

| Host | Why |
| --- | --- |
| `accounts.google.com`, `oauth2.googleapis.com`, `openidconnect.googleapis.com`, `www.googleapis.com` | Google sign-in |
| `bridge.simplefin.org`, `beta-bridge.simplefin.org` | bank sync |
| `generativelanguage.googleapis.com` | Gemini |
| `api.anthropic.com` | Claude |
| `geocoding-api.open-meteo.com`, `api.open-meteo.com` | trips: place lookup and weather forecast (keyless) |
| `en.wikipedia.org` | trips: article summary that grounds generated trivia (keyless) |
| `overpass-api.de` | trips: gluten-free venues tagged in OpenStreetMap (keyless) |

The trips hosts receive only a place name or coordinates. No household
data, names or credentials are sent to them.

**Card catalog refresh adds no host.** Keeping card terms current needs
the public web, but the search runs inside the AI provider (Gemini's Google
Search grounding, Claude's web search tool) as part of the normal
`generativelanguage.googleapis.com` / `api.anthropic.com` call. This server
never connects to issuer or review sites. What goes out is the card's
public product name and the terms already on file, nothing about the
household. Answers are only stored if at least one cited page is on the
issuer's own domain (`sourceDomains` per card, which Claude's search is
also restricted to).

The browser is held to the same origin by the Content-Security-Policy in
`next.config.ts` (`connect-src 'self'`, `frame-ancestors 'none'`). The site
also sends HSTS, `X-Frame-Options: DENY`, `nosniff`, and `noindex`.

## Secrets

`DATABASE_URL`, `AUTH_SECRET`, `AUTH_GOOGLE_SECRET`, `CRON_SECRET`,
`SIMPLEFIN_ACCESS_URL`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` and `DOC_VAULT_KEY` are read
only by server code. Files that read them import `server-only`, so a Client
Component importing them breaks the build. No variable uses the
`NEXT_PUBLIC_` prefix (CI checks this). Secrets live in Railway variables,
never in the repo (`.env*` is git-ignored except `.env.example`).

The SimpleFIN access URL is the one secret the app obtains at runtime. If
`SIMPLEFIN_ACCESS_URL` is set it is used as is; otherwise the URL claimed on
the setup screen is stored in `core_settings` encrypted with AES-256-GCM
under a key derived from `AUTH_SECRET` (HKDF). It is never sent to the
browser. Rotating `AUTH_SECRET` means reconnecting SimpleFIN.

## Bank sync limits

SimpleFIN is contacted at most twice a day. Railway cron calls
`/api/cron/simplefin-sync` hourly; the handler only proceeds in the 7 AM and
7 PM hours of `HOUSEHOLD_TIMEZONE`, and refuses to run again within 4 hours
of the last run whatever the trigger.

## Card catalog refresh limits

Railway cron calls `/api/cron/card-catalog` hourly; it only works in the
6 AM hour of `HOUSEHOLD_TIMEZONE` and checks at most 6 cards per day (two
AI calls each, the first with up to 5 searches). Cards the household holds
are checked weekly, others monthly, rotating-category cards every 2 days
until the quarter's categories are on file, and a failed check is not
retried for a day.

## What the AI providers see

Before anything goes to Gemini or Claude:

1. **Field whitelist.** `toLlmTransaction()` copies only card display name,
   account name, owner label (`User 1` / `User 2` / `Joint`), date,
   merchant, category and amount. Account numbers, masks, routing numbers,
   institution ids and raw bank payloads are never copied.
2. **Text scrub.** Every string is scrubbed of 4+ digit sequences (including
   masked and grouped forms like `****1234` or `4111 1111 ...`) and of the
   names in `HOUSEHOLD_LEGAL_NAMES`.
3. **Type gate.** `runStructured()` only accepts a `Sanitized<T>` payload,
   which can only be produced by the sanitizer.

Both providers receive the identical prompt and must answer with JSON that
matches a Zod schema.

Trip features (trivia, quizzes, hunts, allergy cards, packing suggestions)
send place names, Wikipedia summaries, packing item names and dietary flags,
through `sanitizeReferencePayload()`: legal names, masked numbers and digit
runs of 6+ are removed, while years survive. Traveller names, documents and
bookings are never sent.

## Documents vault

Trip documents (passports, insurance, tickets) are encrypted with
AES-256-GCM under `DOC_VAULT_KEY` before they are written, and only the last
four characters of a document number and the expiry are stored in the
clear. The key is separate from `AUTH_SECRET` so rotating sign-in secrets
never destroys files. Without the key, uploads are refused rather than
stored unencrypted. Files are decrypted only inside an `authedAction` and
returned to the member who asked; there is no download URL.
