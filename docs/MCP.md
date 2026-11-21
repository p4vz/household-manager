# Connecting Claude, ChatGPT and Gemini

The app exposes a read-only MCP server so an AI assistant can look at the
household's cards, sign-up bonuses, rewards audit and trips, and advise on
which card to book with. It cannot book, pay or change anything. Security
rules are in SECURITY.md ("Assistant access").

## Turn it on (Railway)

1. Deploy (the `0005_mcp_oauth` migration adds three `core_oauth_*` tables).
2. Set `AUTH_URL` to the app's public https origin, e.g.
   `https://household.up.railway.app` (no path), and `MCP_ENABLED=true`.
3. The server URL to paste into each app is `<AUTH_URL>/api/mcp`. Settings
   shows it too, with the list of connected assistants.

Each app then discovers the OAuth server, registers itself, and sends you
to the app's consent page. Sign in with an allowlisted Google account and
click Approve. Whoever approves is the "User 1" or "User 2" the assistant
talks to.

## What each assistant can see

The consent page lists every section of the app as checkboxes: Travel
(trips, itinerary, bookings), Financial manager (cards and benefits, card
advice, sign-up bonuses, points left on the table, card catalog, aggregate
spending, transactions, income, balances, crypto), House upkeep and
Calendar. Travel and card features start ticked; spending, transactions,
income, balances, house upkeep and calendar start unticked. Change them any
time under Settings > AI assistants; the assistant sees the change on its
next request.

Whatever is ticked: account numbers, card numbers, crypto wallets,
confirmation codes, emails and other identifiers are never shared, and
full names are never shared or stored (the server cannot make purchases).

## Claude (web, desktop, mobile)

Settings > Connectors > Add custom connector. Name it "Household", paste
the URL, leave the OAuth client fields empty, Add, then Connect. Connectors
added on claude.ai also work in the desktop and mobile apps.

## ChatGPT

Settings > Apps & Connectors > Advanced settings: turn on Developer mode
(Plus/Pro). Then Create (or Add app), paste the URL, choose OAuth, and
leave client id/secret empty so ChatGPT registers itself. In a chat, pick
the connector from the + menu (Developer mode).

## Gemini

Gemini app > Settings > Apps (or Connected apps) > Add custom app, paste
the URL. Gemini registers itself and opens the consent page. Google has
known reports of custom-app OAuth stalling after the redirect on their side;
if it does, the app's logs will show the approval but no token request.

## Useful prompts

- "Which card should I book the Rome hotel with? About $1,400, Marriott."
- "Plan cards for every unbooked step of our Thanksgiving trip."
- "How close am I to the Venture sign-up bonus, and what should go on it?"
- "Where are we leaving the most points on the table?"
- "Is any card worth adding given our spending?"
- "What credits on my cards am I likely not using?"

## If a connection fails

- 404 on `/api/mcp`: `MCP_ENABLED` or `AUTH_URL` is not set (or AUTH_URL is not https).
- "Redirect URI not allowed" in the logs: the app used a callback host that
  is not on the list. Add it to `MCP_EXTRA_REDIRECT_HOSTS` only if it is
  really that assistant's host.
- An assistant stops working after an allowlist change: expected; its
  member is no longer allowed. Reconnect from an allowed account.
