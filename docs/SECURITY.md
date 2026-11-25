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
| `/kiosk/pair` | anyone | a code box; its one action trades a one-time pairing code for a kiosk cookie (see "Kitchen kiosk") |
| `/kiosk` | allowlisted users or a paired kiosk device | session, or a device token checked against the database by the page and every kiosk action |
| `/api/auth/*` | anyone | Auth.js OAuth flow; allowlist enforced in callbacks |
| `/manifest.webmanifest`, `/kiosk.webmanifest`, `/sw.js`, `/offline.html`, `/kiosk-offline.html`, `/icons/*` | anyone | static PWA files with no household data; the service worker caches only these and Next.js build files, never pages or data |
| `/api/cron/simplefin-sync`, `/api/cron/monthly-advisor`, `/api/cron/card-catalog`, `/api/cron/family-hub` | Railway cron only | `Authorization: Bearer $CRON_SECRET`, constant-time compare, fails closed if the secret is missing or short |
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

## Private accounts between members

Each finance account is Joint, Pavel's (`user1`) or Raisa's (`user2`). In
Finance a member sees joint accounts and their own: dashboard, transactions,
drill-downs, budgets (kept per member), rewards audit, sign-up bonuses, the
AI advisor (one report per member) and trip card advice. Assistants (MCP)
answer as the member who connected them, with the same limits. The rule lives
in `src/modules/finance/access.ts`, and every read in `finance/api.ts` takes the
viewer as its first argument. Writes naming an account (owner, names, card
rules, catalog links, pictures) are refused for the other member's accounts.

The Accounts page lists every account to both members (official name,
nickname, owner, type, picture) so each knows what exists; balances show
only for accounts the viewer can see. New accounts start private: bank-sync
accounts belong to whoever linked SimpleFIN (User 1 when the access URL comes
from the environment), CSV-created ones to whoever imported them. Mark an
account Joint to share it.

Not covered: Settings shows the household's total transaction count, and
annual-fee reminders on the shared calendar name the card and fee.

Card pictures are encrypted with DOC_VAULT_KEY like trip documents, are
re-encoded in the browser first (dropping photo metadata), are limited to
600 KB of JPEG, PNG or WebP (checked by file signature), and are only
decrypted to render the Accounts page. They never reach an AI provider or an
assistant. Account and card numbers, even masked ones, are stripped from
bank names and typed names before they are stored.

## Kitchen kiosk

The kitchen wall screen (a Samsung DeX device in kiosk browser mode) is
shared by the whole family, so it does not sign in with a household Google
account. Pavel chose a paired device token (2026-11-23):

- **Pairing.** A signed-in member taps "Make pairing code" in Settings and
  types the code at `/kiosk/pair` on the screen. Codes are 8 characters
  from a 31-letter alphabet (about 40 bits), live 10 minutes, work once
  (checked and consumed in one UPDATE), and at most 3 are open. Code entry
  is rate limited to 5 tries per 10 minutes per address and 30 per hour in
  total. Only SHA-256 hashes of codes are stored.
- **Device token.** Pairing sets a 256-bit random token as the `hm_kiosk`
  cookie: httpOnly, `Secure` in production, `SameSite=Strict`, path
  `/kiosk`, one year. The database keeps only its SHA-256 hash
  (`core_kiosk_devices`). Settings lists paired screens with "Unpair",
  which revokes the token on its next request.
- **What it opens.** The proxy honours the cookie only for the exact path
  `/kiosk` (the page and its Server Actions, which post to that path);
  every other path still needs an allowlisted Google session. The page and
  each kiosk action (`kioskAction()` in `core/actions/kiosk-action.ts`)
  verify the token against the database. All other actions use
  `authedAction()`, which a kiosk cookie never satisfies, so posting another
  page's action id to `/kiosk` is refused.
- **What the kiosk can do.** Read: family Google calendars, household
  calendar entries other than finance reminders, chores, shopping, returns,
  upkeep due in two weeks. Write: tick or un-tick a chore, add a one-time
  chore; on shopping lists add, tick and drag items, add lists (blank or
  from a template) and stores, reorder, rename, put a list off until a
  date and save a list as a template; add a return or move
  its status, mark an upkeep task done, refresh the calendar, and add,
  edit or delete events on the family Google calendar (the spec asks for
  this on the wall screen; Google keeps deleted events for 30 days).
  Deleting anything else (including shopping items, stores, lists and
  templates), adding kids or recurring chores, and every finance, trips and
  settings page stay member-only. `tests/boundaries.test.ts` checks this.
- **Risk accepted.** Anyone standing at the screen can use those kiosk
  actions, and someone who takes the device can keep using the kiosk until
  it is unpaired. Return notes and order references are shown on the wall,
  so text holding a card-number-shaped number (13 to 19 digits passing the
  Luhn check) is refused.

### Kiosk setup and self-recovery

The screen runs without a paid kiosk browser: open `/kiosk` in Chrome on
the DeX phone, pair it, then "Add to Home screen". It installs as its own
app ("Kitchen", `public/kiosk.webmanifest`: start `/kiosk`, full screen,
landscape) and shares Chrome's cookies, so the pairing carries over. Pin
it with Android's App pinning and turn on "Stay awake while charging".

`useKioskWatchdog()` keeps it alive unattended (rules in
`src/modules/family/ui/watchdog.ts`): it reloads when fresh renders stop
for 3 minutes while the server still answers, once when the connection
comes back, and once a night at 3 AM. While offline it never reloads; it
pings a static file with backoff (15 s up to 5 min) and shows "Offline,
reconnecting". At most 3 watchdog reloads per 15 minutes. If the page is
opened with no connection, the service worker serves
`/kiosk-offline.html`, which retries `/kiosk` every 30 s by itself.

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
limited capacity and only when making a purchase approved by Pavel and/or
Raisa, and are never stored in memory. The assistant endpoint cannot make
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

**Booking codes, the one opt-in exception.** Pavel asked for a way to let
an assistant read a trip's confirmation codes. A code reaches an assistant
only when both switches are on: the connection's "Booking confirmation
codes" permission (`travel.booking_codes`, off by default) and the trip's
own "Share booking codes with assistants" switch on its overview page (off
by default). Even then only `get_trip`'s `bookingCode` field carries it: the
tool wraps the stored value in `SharedBookingCode`, and `forAssistant()`
passes it unscrubbed only if it is shaped like a booking code (3-24 letters,
digits and dashes; not 13+ digits, an IBAN, a wallet or an email), so a card
number typed into the field is still redacted. Notes and every other field
keep the full scrub. Without both switches the step says `codeInApp: true`.

Every trip step an assistant sees (`get_trip`, `booking_checklist`,
`trip_card_plan`) carries a `link` to its card on the itinerary page
(`/trips/<trip>/itinerary#step-<id>`), which needs a normal sign-in, so an
assistant can point to a code without reading it. Links are wrapped in
`AppLink` and pass only when they match that exact shape.

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
| `accounts.google.com`, `oauth2.googleapis.com`, `openidconnect.googleapis.com`, `www.googleapis.com` | Google sign-in; Google Calendar (two-way family calendar sync, `calendar.events`) |
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

The browser is held to the same origin by the Content-Security-Policy
(`connect-src 'self'`, `frame-ancestors 'none'`). The site also sends HSTS,
`X-Frame-Options: DENY`, `nosniff`, and `noindex` (`next.config.ts`).

**No inline scripts.** The proxy (`src/proxy.ts`) builds the CSP for every
request with a fresh 128-bit nonce (`src/core/security/csp.ts`):
`script-src 'self' 'nonce-…' 'strict-dynamic'` and `script-src-attr 'none'`.
Next.js reads the nonce from the request header and stamps it on its own
scripts, so an injected `<script>` or `onerror=` handler is refused by the
browser. That is why every page renders per request (`await connection()` in
the root layout); a page prerendered at build time would have no nonce and
would not run. Styles keep `'unsafe-inline'` because Recharts and next/font
use style attributes, which a nonce cannot cover; inline styles cannot run
code. Development adds `'unsafe-eval'` and `ws:` for React's overlay and hot
reload, never production. The app loads no third-party scripts; adding one
needs a review here.

## Secrets

`DATABASE_URL`, `AUTH_SECRET`, `AUTH_GOOGLE_SECRET`, `CRON_SECRET`,
`SIMPLEFIN_ACCESS_URL`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `DOC_VAULT_KEY`,
`GOOGLE_CALENDAR_SERVICE_ACCOUNT`, `GOOGLE_REFRESH_TOKEN` (or `GOOGLE_CALENDAR_REFRESH_TOKEN`),
`GOOGLE_CLIENT_SECRET`, `GOOGLE_CALENDAR_ID` and `GOOGLE_CALENDARS` are read
only by server code. Files that read them import `server-only`, so a Client
Component importing them breaks the build. No variable uses the
`NEXT_PUBLIC_` prefix (CI checks this). Secrets live in Railway variables,
never in the repo (`.env*` is git-ignored except `.env.example`).

The SimpleFIN access URL is the one secret the app obtains at runtime. If
`SIMPLEFIN_ACCESS_URL` is set it is used as is; otherwise the URL claimed on
Settings → Bank sync is stored in `core_settings` encrypted with AES-256-GCM
under a key derived from `AUTH_SECRET` (HKDF). It is never sent to the
browser or logged: the Settings page gets only status (connected, how,
last sync, counts). The setup token is posted once through an allowlisted
server action, claimed from the server, and not kept. Disconnect deletes the
stored URL (synced data stays); an env-provided URL can only be removed on
the server. Rotating `AUTH_SECRET` means reconnecting SimpleFIN.

Claude can also run on the household's Claude subscription. The token from
`claude setup-token` is pasted in Settings (stored like the keys below, key
`ai.key.claude_subscription`) or set as `CLAUDE_CODE_OAUTH_TOKEN`. Claude calls
then go through the Claude Agent SDK (`src/core/ai/claude-code.ts`), which
starts Claude Code as a child process with: no tools (only WebSearch for the
card-catalog research step), no settings files, no saved sessions, an empty
working directory under the temp dir, and a minimal environment (the token,
PATH, proxy/CA variables). `DATABASE_URL`, `AUTH_SECRET` and every other
secret are not passed to it. Non-essential traffic is off, so it only calls
`api.anthropic.com`, which is already allowlisted; this child process is the
one network path that does not go through `outboundFetch`. The same sanitized
payloads are sent either way. If the subscription call fails (usage limit,
expired token) and an Anthropic API key is saved, the call is retried on the
API; otherwise the error is shown. Error text is scrubbed of tokens.

AI provider API keys can also be pasted in Settings > AI configuration (any
allowlisted user). They are stored the same way (`core_settings` keys
`ai.key.anthropic` / `ai.key.gemini`, AES-256-GCM under the `AUTH_SECRET`
derived key) and a saved key wins over `ANTHROPIC_API_KEY` /
`GEMINI_API_KEY`, which stay as the fallback. The browser only ever gets a
masked hint (`sk-ant-…abcd`, prefix plus last four characters) computed at
save time; the key is never returned by a Server Action, never logged, and
error messages are fixed strings. "Test" lists the provider's models
(`api.anthropic.com/v1/models`, `generativelanguage.googleapis.com/v1beta/models`)
with the key in a header, spends no tokens, sends no household data and
reports only the HTTP status. A key the provider rejects is not saved.
Removing a key deletes the row. Rotating `AUTH_SECRET` makes saved keys
unreadable; calls then fall back to the environment until they are re-entered.

## Google Calendar sync

Two-way with the shared family calendar ("Pavel + Raisa"); read-only for
any extra calendars in `GOOGLE_CALENDARS`.

- **Mirror.** `calendar_google_events` keeps title, time range, location,
  all-day, Google's `etag` and update time, from yesterday through the next
  9 days. Sync upserts by Google event id and drops rows Google no longer
  returns. It runs at most once a minute: when the kiosk or phone page
  renders and the copy is over 90 s old (the kiosk re-renders every 30 s),
  on the Sync button, and hourly from cron.
- **Ids stay on the server.** Calendar ids (often email addresses) live in
  `GOOGLE_CALENDAR_ID` / `GOOGLE_CALENDARS`, or are found by name with
  `calendarList.list` (`GOOGLE_CALENDAR_NAME`) and kept in process memory
  only. They are never stored or sent to a browser; rows carry a key
  ("family", "kids") and the browser gets only our own row ids.
- **Writes.** Add / edit / delete go to Google first (`events.insert`,
  `events.patch`, `events.delete`), then update the mirror. Edits and
  deletes send the stored etag as `If-Match`, so a change made elsewhere is
  never overwritten; on a mismatch the mirror is refreshed and the user
  tries again. Only rows of the family calendar can be changed. Google
  keeps deleted events in its bin for 30 days.
- **Credentials.** A member's refresh token (`GOOGLE_REFRESH_TOKEN`, for
  `GOOGLE_CLIENT_ID` or the sign-in client) with the `calendar.events` and
  `calendar.calendarlist.readonly` scopes, or a service account the family
  calendar is shared with ("Make changes to events") plus
  `GOOGLE_CALENDAR_ID`. `calendar.events` cannot change calendar sharing or
  settings, only events.

## Bank sync limits

Scheduled syncs contact SimpleFIN at most twice a day. Railway cron calls
`/api/cron/simplefin-sync` hourly; the handler only proceeds in the 7 AM and
7 PM hours of `HOUSEHOLD_TIMEZONE`, and refuses to run within 4 hours of the
last run. "Sync now" in Settings waits at least 15 minutes after the last
run, and no sync starts while another is running.

## Card catalog refresh limits

Railway cron calls `/api/cron/card-catalog` hourly; it only works in the
6 AM hour of `HOUSEHOLD_TIMEZONE` and checks at most 6 cards per day (two
AI calls each, the first with up to 5 searches). Cards the household holds
are checked weekly, others monthly, rotating-category cards every 2 days
until the quarter's categories are on file, and a failed check is not
retried for a day.

## Ask Claude (in-app assistant)

- No new HTTP surface: the page uses Server Actions (`authedAction`), and the
  tools run inside the server process (Agent SDK in-process MCP server or AI
  SDK tools).
- Tool answers go through the same scrub as MCP answers (`forAssistant` in
  src/mcp/sanitize.ts): no ids, account, card or routing numbers, legal
  names, wallets, emails or booking codes. Database ids are replaced by
  per-conversation refs kept on the server. The member's own messages are
  scrubbed of long numbers and legal names before they go to the provider.
- The assistant sees only joint accounts and the signed-in member's own.
  Conversations and change history are visible only to that member.
- Every change is logged with before and after values and can be undone.
  Deletes and batches over 10 changes need the member's Apply.
- No tool moves money, edits amounts or accounts, or touches bank
  connections, keys, settings or assistant permissions.

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
