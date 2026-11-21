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
| `/api/mcp` | assistants a member approved | OAuth bearer token (see "Assistant access"); 404 unless `MCP_ENABLED=true` |
| `/api/oauth/register`, `/api/oauth/token`, `/api/oauth/revoke` | assistant apps | registration grants nothing; token needs a PKCE proof or refresh token; rate limited; 404 unless enabled |
| `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/.well-known/openid-configuration` | anyone | public discovery metadata only; 404 unless enabled |
| `/oauth/authorize` | allowlisted users | consent screen; session + allowlist like any page |
| everything else | allowlisted users | session + allowlist (proxy and in-handler) |

Apart from the read-only assistant endpoint below, there is **no public API**. The module API and the event bus are plain
in-process function calls; no route, queue or socket exposes them.
`tests/boundaries.test.ts` fails CI if a route handler appears outside
`/api/auth`, `/api/cron` and the reviewed assistant routes, if a cron route
skips the secret check, or if an assistant route can answer while the
feature is off.

## Assistant access (MCP)

Claude, ChatGPT and Gemini can be connected as custom connectors to a
read-only MCP endpoint at `/api/mcp`. Setup steps are in `docs/MCP.md`.

**Off by default.** Every assistant route answers 404 unless
`MCP_ENABLED=true` and `AUTH_URL` is the app's https origin. The issuer and
resource URLs come only from `AUTH_URL`, never from a Host header.

**Who can connect.** Remote assistants cannot send a fixed header, so the
app runs a small OAuth 2.1 authorization server (`src/core/oauth`):

- Clients register themselves (RFC 7591). Registration is open but grants
  nothing: no secret is issued (public clients), redirect URIs must be https
  on `claude.ai`, `claude.com`, `chatgpt.com`,
  `oauth-redirect{,-sandbox,-test}.googleusercontent.com` (Gemini; path must start with `/r/` or `/a/`), plus `MCP_EXTRA_REDIRECT_HOSTS`,
  or http on loopback for desktop clients. Exact-match redirect URIs only.
  At most 50 clients; clients nobody approved within a day are deleted.
- Access is granted only on `/oauth/authorize`, by an allowlisted member
  signed in with Google, who sees the assistant's name and redirect host.
  The consent action re-validates every field.
- Authorization code flow with PKCE S256 only. Codes live 5 minutes, are
  single use (redeeming one twice revokes what it produced), are bound to
  client, redirect URI and resource (RFC 8707), and carry `iss` (RFC 9207).
- Access tokens live 1 hour. Refresh tokens live 30 days, sliding, and are
  not rotated because Gemini requires the same refresh token back. Codes and
  tokens are 256-bit random values stored only as SHA-256 hashes.
- The member's address is re-checked against `ALLOWED_EMAILS` on every MCP
  call and refresh, so removing an address cuts off its assistants at once.
  Settings lists connected assistants with Disconnect / Disconnect all.
- Rate limits (in memory): registration 10 per hour per address and 30 per
  day in total; token 60 per 10 minutes per address; MCP 300 per minute per
  address and 120 per minute per connection. Requests with a browser
  `Origin` other than the app are refused (DNS rebinding).
- CORS is open (`*`) only on discovery, registration, token and revocation:
  they use no cookies. `/api/mcp` sends no CORS headers.

**The rule (always, whatever is ticked).** Never share account numbers,
card numbers, routing numbers, crypto wallet addresses, or any other
sensitive identifier (passport, Social Security, confirmation and booking
codes, email addresses, phone numbers). Full names are shared only in a
limited capacity and only when making a purchase approved by User 1 and/or
User 2, and are never stored in memory. The assistant endpoint cannot make
purchases, so it never shares full names at all. The rule is shown on the
consent screen and in Settings, sent to every assistant in the server
instructions (with "do not save names or identifiers to memory"), and
enforced in code:

1. Tools copy whitelisted fields only (no ids, masks, institution data,
   confirmation numbers, documents, birthdates).
2. `forAssistant()` drops any key that looks like an identifier
   (`accountNumber`, `iban`, `wallet`, `confirmation`, `email`, `phone`,
   `fullName`, `address`, `token`, ...).
3. Every string is scrubbed (`scrubIdentifiers()` in `core/ai/sanitize.ts`,
   also applied to everything sent to Gemini and Claude): masked and long
   digit runs, crypto wallet addresses (EVM, bech32, base58, other long
   key-like tokens), IBANs, email addresses and booking/confirmation-style
   codes (flight numbers such as `UA1234` survive), plus the household's
   legal names and every name in the trips travellers list.

**Per-assistant permissions.** Each connection has its own checklist,
grouped by app section (Travel, Financial manager, House upkeep, Calendar;
see `core/oauth/permissions.ts`). It is chosen on the consent screen and can
be changed any time in Settings; changes apply on the assistant's next call.
Only tools whose permissions were all granted are advertised or callable,
and fields that need a further permission (sign-up progress, individual
purchases in the audit, booking details in an itinerary) are left out
without it. Defaults: travel and card features on; aggregate spending,
transactions, income, balances, house upkeep and calendar off. Crypto is
listed but unavailable (not tracked yet). Grants made before permissions
existed get the defaults.

**What assistants can do.** One scope, `household:read`. Every tool is
read-only (`readOnlyHint`), calls module `api.ts` functions only, and is
stateless: a fresh MCP server per request, no sessions. Nothing is booked,
paid or changed. Tools: cards and benefits, best card for purchases or
bookings, sign-up bonus progress, points left on the table, cards worth
adding, catalog card terms, trips, itinerary, trip card plan, booking
checklist, and (off by default) spending summary, income and savings,
transactions, account balances, house upkeep tasks, upcoming events.

**What assistants see.** The same rules as the AI providers. Answers are
built field by field from card nicknames, owner labels (`User 1` /
`User 2` / `Joint`), dates, merchants, categories and amounts, then every
string is scrubbed of legal names and digit runs (4+ for finance answers,
6+ for trip answers, so years survive) in `src/mcp/sanitize.ts`. Account
ids, masks, institution data, confirmation numbers, booking URLs, documents
and traveller names are never included. The assistant's own provider
(Anthropic, OpenAI, Google) receives these answers under the member's
account with that provider.

**New attack surface, for review:** open client registration (spam is
bounded by the caps above); the consent page as a phishing target (a
member must be signed in and click Approve; it names the redirect host);
bearer token theft from an assistant provider (read-only, 1-hour access,
revocable in Settings); and prompt injection through stored text such as
merchant names or trip notes reaching an assistant (tools cannot write, so
the worst case is a misleading answer, not a change).

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
