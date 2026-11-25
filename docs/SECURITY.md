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
| `/kiosk/pair` | anyone | a code box; its one action trades a one-time pairing code for a kiosk cookie (see "Kitchen kiosk"). Also `clearUnpairedScreenAction`, which clears kiosk cookies only when the pairing no longer works |
| `/kiosk` | a paired kiosk device | device token checked against the database by the page and every kiosk action, with an ability check (kid-safe, or adult mode by PIN). A member without a pairing sees only "Make this the kitchen screen". A browser in kitchen mode can reach nothing else |
| `/api/auth/*` | anyone | Auth.js OAuth flow; allowlist enforced in callbacks |
| `/manifest.webmanifest`, `/kiosk.webmanifest`, `/sw.js`, `/offline.html`, `/kiosk-offline.html`, `/icons/*` | anyone | static PWA files with no household data; the service worker caches only these and Next.js build files, never pages or data |
| `/api/cron/simplefin-sync`, `/api/cron/monthly-advisor`, `/api/cron/card-catalog`, `/api/cron/family-hub`, `/api/cron/backup`, `/api/cron/notifications` | Railway cron only | `Authorization: Bearer $CRON_SECRET`, constant-time compare, fails closed if the secret is missing or short |
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
decrypted to render Finance pages for members who can see the account. The
one exception to "never sent to an AI provider": "Add a card you just
opened" on the Accounts page sends that one photo (number covered) to the
configured provider to read the issuer and product name. If the model reports
a readable card number, nothing is stored. Assistants (MCP, in-app) never get
pictures.

Home binder files (manuals, warranties, insurance, property tax) are sealed
with DOC_VAULT_KEY the same way, up to 8 MB, downloaded only by a signed-in
member, and never sent to an AI or an assistant; the binder has no field for
policy or account numbers. Subscriptions and net worth follow the account
rule above (joint plus the viewer's own, enforced in the module API) and are
not exposed to assistants.

Account and card numbers, even masked ones, are stripped from bank names and
typed names before they are stored. Only the last 4 digits are kept, in their
own column (`finance_accounts.last4`, Pavel's choice, 2026-11-25), so people
can tell similar accounts apart. They are shown on Finance pages to members
who can see the account, and are left out of everything sent to an AI
provider, the in-app assistant and MCP (those read lists that never select
the column, and the outbound sanitizers strip 4-digit runs as well).

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
- **Kitchen mode from the app.** A signed-in member taps "Kitchen mode"
  on the device that should become the screen and confirms. That makes
  the same device token directly, with no code (`enterKitchenModeAction`,
  an `authedAction`, so a kiosk cookie alone can never pair another
  screen), signs the member out on that device, and needs an adult PIN to
  be set first (leaving needs one). Opening `/kiosk` with a member session
  but no pairing shows that button instead of the kiosk: the kitchen screen
  never runs on a parent's Google session.
- **Device token.** Pairing sets a 256-bit random token as the `hm_kiosk`
  cookie: httpOnly, `Secure` in production, `SameSite=Strict`, path
  `/kiosk`, one year. The database keeps only its SHA-256 hash
  (`core_kiosk_devices`). Settings lists paired screens with "Unpair",
  which revokes the token on its next request.
- **Locked to the kiosk.** Pairing also sets `hm_kiosk_lock` (path `/`,
  `SameSite=Lax`, no secret). While it is there the proxy sends every page
  except `/kiosk`, `/kiosk/pair` and the PWA files back to `/kiosk`, answers
  403 to `/api/*` (Google sign-in included) and deletes any Auth.js session
  cookie in that browser, so kids can't leave for the app or sign in there.
  A screen paired before the lock existed gets it on its next `/kiosk`
  visit. Only "Exit kitchen mode" (adult mode) removes it; a screen
  unpaired in Settings offers "Use as a normal browser", which does nothing
  while the pairing still works (`clearUnpairedScreenAction`).
- **What it opens.** The device cookie works only on the exact path
  `/kiosk` (the page and its Server Actions, which post to that path). The
  page and each kiosk action (`kioskAction()` in
  `core/actions/kiosk-action.ts`) verify the token against the database and
  check the device first, before any session. All other actions use
  `authedAction()`, which a kiosk cookie never satisfies, so posting another
  page's action id to `/kiosk` is refused.
- **Kid-safe by default.** Every kiosk action names an ability
  (`core/kiosk/permissions.ts`). A paired screen gets only the child-safe
  ones: read family Google calendars, household calendar entries other than
  finance reminders, chores, shopping, returns, upkeep due in two weeks;
  tick or un-tick a chore, add a one-time chore; on shopping lists add,
  tick and drag items, add lists (blank or from a template) and stores,
  reorder, rename, put a list off and save a list as a template; add a
  return; refresh the calendar; add or edit events on the family Google
  calendar (title, time, address and notes) and add pictures to them.
- **Adult mode (adult PIN).** "🔒 Adult" on the screen asks for the
  household adult PIN. A correct PIN gives that screen adult abilities for
  5 minutes, held on the server (`core_kiosk_devices.adult_until`), or until
  "Lock": delete an event or a picture, mark upkeep done, move a return
  along, and "Exit kitchen mode" (unpairs the screen and removes both
  cookies). The PIN is 4 to 8 digits (no repeats or runs like 1234), set and
  changed only in Settings by a signed-in member, stored as a salted scrypt
  hash (`core_kiosk_adult_pin`), and changing it ends adult mode on every
  screen. Five wrong PINs lock that screen out for 15 minutes; tries are
  also capped at 10 a minute in memory. A short PIN is weak against someone
  holding the database, so the protection is online: only a paired screen
  can try one. `startAdultMode()` (`core/kiosk/adult.ts`) is separate from
  the PIN check so a fingerprint or face passkey can replace the PIN later.
- **Never on the kiosk, even in adult mode.** Finance, trips, settings,
  Ask Claude and the assistant (MCP) are member-only `authedAction`s and
  pages; the proxy keeps the screen off them. Deleting anything else
  (shopping items, stores, lists, templates, chores), adding kids or
  recurring chores stay member-only too.
  `tests/kiosk-lockdown.integration.test.ts` calls every server action in
  the app as a paired screen and checks that only the listed kid-safe ones
  get through, and that the adult ones work only in adult mode;
  `tests/proxy-kiosk.test.ts` checks the lock; `tests/boundaries.test.ts`
  checks the action files.
- **Event notes and pictures.** Notes are the Google event's description,
  stored as plain text in the mirror. They are left out of what the in-app
  assistant reads. Pictures can't live in Google, so they stay in the app:
  shrunk and re-encoded in the browser (dropping location and camera data),
  checked by file signature, limited to 1 MB and 8 per event, encrypted with
  `DOC_VAULT_KEY`, and decrypted only when someone opens that event. They
  are deleted with the event.
- **Risk accepted.** Anyone standing at the screen can use the kid-safe
  actions, and someone who takes the device can keep using the kiosk until
  it is unpaired. Return notes and order references are shown on the wall,
  so text holding a card-number-shaped number (13 to 19 digits passing the
  Luhn check) is refused. The app can't stop someone leaving the browser
  itself (home button, recent apps): Android does that, below.

### Kiosk setup and self-recovery

The screen runs without a paid kiosk browser: open `/kiosk` in Chrome on
the DeX phone, pair it, then "Add to Home screen". It installs as its own
app ("Kitchen", `public/kiosk.webmanifest`: start `/kiosk`, full screen,
landscape) and shares Chrome's cookies, so the pairing carries over. Turn
on "Stay awake while charging".

Lock the phone itself down too, so kids can't leave the browser:

1. Give the phone a screen-lock PIN the kids don't know (Settings →
   Lock screen).
2. Turn on App pinning with "Ask for PIN before unpinning" (Settings →
   Security and privacy → More security settings → Pin app; on stock
   Android, Settings → Security → App pinning). Open the Kitchen app, open
   Recent apps, tap its icon → Pin. Unpinning (Back + Recents held) then
   asks for the phone's PIN.
3. Don't sign into Google with a parent's account in that phone's Chrome,
   and don't keep the Household app installed there. Kitchen mode signs
   the app session out and the lock refuses Google sign-in, but a Google
   account in the browser itself could open Gmail or other sites.
4. Optional: turn off "Install unknown apps" and set Google Play to ask
   for authentication on every purchase.

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
| `gmail.googleapis.com` | return emails: read-only search of the mailboxes each member connected (`gmail.readonly`) |
| `bridge.simplefin.org`, `beta-bridge.simplefin.org` | bank sync |
| `generativelanguage.googleapis.com` | Gemini |
| `api.anthropic.com` | Claude |
| `geocoding-api.open-meteo.com`, `api.open-meteo.com` | trips: place lookup and weather forecast; home weather on the kiosk and home page (coordinates from `HOME_WEATHER` only; keyless) |
| `en.wikipedia.org` | trips: article summary that grounds generated trivia (keyless) |
| `overpass-api.de` | trips: gluten-free venues tagged in OpenStreetMap (keyless) |
| `www.saferproducts.gov` | house upkeep: U.S. CPSC product-recall search for listed home equipment (keyless; only a product phrase such as "GE refrigerator" is sent, digit runs of 5+ removed) |
| `fcm.googleapis.com`, `web.push.apple.com`, `updates.push.services.mozilla.com` | phone notifications (Web Push to Chrome/Android, Safari/iPhone, Firefox); payloads are end-to-end encrypted for the device, see "Phone notifications" |
| `api.nhtsa.gov` | car upkeep: NHTSA vehicle safety-recall search (keyless; only make, model and model year are sent, never a VIN or plate, which the app doesn't store) |

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
`BACKUP_KEY`, `VAPID_PRIVATE_KEY`, `GOOGLE_CALENDAR_SERVICE_ACCOUNT`, `GOOGLE_REFRESH_TOKEN` (or `GOOGLE_CALENDAR_REFRESH_TOKEN`),
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

## Return emails (Gmail)

Each member connects their own Gmail mailboxes (Settings → Email for
returns) with a separate Google sign-in that asks only for
`gmail.readonly`. It is a restricted scope, so while the OAuth app is not
verified Google shows an "unverified app" screen; that is expected for a
two-person household app.

- **Tokens.** The connect flow uses a one-time `state` (10 minutes, stored in
  `family_mail_connect_states`, bound to the member) and PKCE. The refresh
  token and the mailbox address are sealed with AES-256-GCM
  (`src/core/secrets/secret-box.ts`). Only a hash of the address is stored
  in clear, to recognise a reconnect. Disconnect revokes the grant at
  Google and deletes the mailbox and everything found in it.
- **What is read.** A search (`mail-text.ts`) that matches return-related
  subjects and phrases only, since the last scan (45 days the first time),
  in Inbox and, if the member leaves it on, Spam. At most 25 new messages
  per mailbox per scan, every 3 hours from the hourly cron or on "Scan now".
- **What is kept.** Extracted fields (store, item, deadline, how to
  return) and Gmail's message id, in `family_return_suggestions`. The email
  body is held in memory for one AI call and never stored.
- **What the AI sees.** Subject, sender display name and up to 4,000
  characters of body text after `scrubMailText()`: links, email addresses,
  phone numbers, order / tracking / RMA numbers, any token with 5+ digits,
  card masks and household legal names are removed, then
  `sanitizeReferencePayload()` runs as for every AI call.
- **Privacy between members.** Mailboxes and found returns are visible only
  to the member who connected the mailbox, never to the other member or the
  kiosk. A found return reaches the shared list only when that member taps
  Add (or Mark returned for a refund).
- **Screenshots and pasted text.** "Fill from a screenshot or text" on the
  phone's Returns tab reads screenshots in the browser with Tesseract OCR
  (`public/ocr/`, copied from `node_modules` at build time). The image never
  leaves the phone. The recognised text is shown, can be edited, and goes
  through the same scrub and AI call; the member confirms the fields before
  anything is saved. `/ocr/*` gets its own CSP (`ocrAssetPolicy()`) so the
  OCR worker may run WebAssembly; nothing else gets `'wasm-unsafe-eval'`.

## Backups (Google Drive)

Railway's own volume backups are the first line (see docs/BACKUP.md). The
app adds an off-site copy:

- **What.** Nightly (3 AM household time, `/api/cron/backup`) or on "Back up
  now": every table in one read-only, repeatable-read transaction, gzipped
  and encrypted with AES-256-GCM under `BACKUP_KEY` (32 random bytes,
  base64; separate from `AUTH_SECRET` and `DOC_VAULT_KEY`). Without the key
  no backup is made. Nothing is written to local disk.
- **Where.** A "Household manager backups" folder in the Drive of the member
  who connected it (Settings → Backups), with a separate Google sign-in that
  asks only for `drive.file`: the app sees and changes only files it
  created, never anything else in that Drive. The refresh token is sealed
  like the Gmail ones; connect uses a one-time state and PKCE; disconnect
  revokes the grant. Google stores only ciphertext.
- **Retention.** Copies older than 30 days are deleted, but the newest 7 always stay.
- **Never GitHub.** Household data is never written to a repository.
- **Restore.** `scripts/restore-backup.mjs` (docs/BACKUP.md) decrypts on the
  member's own computer and loads into a new, empty database. Values sealed
  with `AUTH_SECRET` / `DOC_VAULT_KEY` inside the backup need those keys too.

## Phone notifications (Web Push)

- Each member turns notifications on per device in Settings → Phone
  notifications and picks the types: house and car upkeep, registrations and
  inspections, return deadlines, new things to review. Never bills.
- The browser's push address must be on Google's, Apple's or Mozilla's push
  service (`PUSH_HOSTS`); at most 8 devices per member. Messages are signed
  with VAPID (RFC 8292) and encrypted for the device (RFC 8291, implemented
  in `core/push/crypto.ts` and sent through `outboundFetch`), so the push
  service carries only ciphertext. VAPID keys come from `VAPID_PUBLIC_KEY` /
  `VAPID_PRIVATE_KEY` or are made once and stored sealed under `AUTH_SECRET`.
- **Privacy.** Shared items (upkeep, registrations, the shared returns list)
  go to both members. Transactions to review follow the finance viewer rule:
  joint and the member's own accounts, never the other member's private
  ones. Returns found in email go only to that mailbox's member. Each member's
  devices and choices are visible only to them.
- **Text.** Notifications show on lock screens, so they hold only an item's
  title and when it is due; finance items say only "A large purchase to
  review" (no merchant, amount or account). Every string is scrubbed
  (`scrubText`: digit runs, emails, codes, legal names) and the click target
  is an in-app path only.
- Sent between 8 AM and 9 PM household time, once per item and stage
  (`core_push_sent`), grouped into one message per type.

## Home page upload and "Needs attention"

- **Upload ("Drop anything here").** Photos are read on the member's device
  with the same Tesseract OCR; the picture is not uploaded for reading. PDFs
  are not read at all: only the file name and the member's note go to the
  AI. The original photo or PDF is uploaded only when the member taps "Keep
  … in the binder", and is then stored encrypted by the home binder
  (`addBinderDocument`, 8 MB limit, needs DOC_VAULT_KEY); it never goes to
  the AI. The
  text goes through `scrubMailText()` (numeric dates rewritten with slashes
  first so they survive) and `sanitizeReferencePayload()`; car nicknames are
  the only stored data sent. Claude's answer is re-checked (real dates, no
  5+ digit runs) and nothing is saved until the member taps Add on a
  suggestion. Receipt matching and transaction notes use the finance access
  rules, so a member only sees and notes joint and own transactions.
  Code: `src/assistant/inbox.ts`, `src/app/(app)/home-actions.ts`.
- **Needs attention.** Built on the server from module `api.ts` calls and
  rendered only on the signed-in member's own page; nothing goes to an AI.
  Money items (large purchases, questionable transactions, budgets, sign-up
  bonuses) are counted per member; finance calendar reminders are left out
  of "Coming up". Code: `src/assistant/attention.ts`.

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
