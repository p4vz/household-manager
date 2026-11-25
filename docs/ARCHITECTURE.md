# Architecture

One Next.js app (App Router, TypeScript) deployed as one Node service on
Railway, with one Postgres database. It is a **modular monolith**: four
feature modules share sign-in, the database connection, the AI layer and an
internal event bus, but each module owns its own code and tables.

```
src/
  core/                 shared platform, knows nothing about modules
    auth/               Auth.js (Google), email allowlist, guards
    actions/            authedAction() wrapper for every Server Action
    ai/                 provider abstraction (Gemini / Claude), sanitizer, settings
    bus/                event catalogue + in-process event bus
    db/                 Drizzle client and the aggregate schema
    net/                outbound host allowlist, cron secret check
    env.ts              server-only environment parsing
  modules/
    finance/            expenses, budgets, card rewards (first to be built)
    maintenance/        home maintenance tasks and costs
    calendar/           household calendar
    trips/              trip planner
    family/             kids' chores, shopping lists, returns (kitchen kiosk + phone view)
    registry.ts         wires each module's subscriptions onto the bus
  app/                  routes and pages (thin; call module APIs)
  proxy.ts              request gate (Next 16 replacement for middleware)
  instrumentation.ts    registers modules once at server start
```

## How modules talk to each other

There are two channels, and both exist only inside the running server
process. Neither is reachable over HTTP.

### 1. Direct calls: `modules/<name>/api.ts`

Each module exposes a typed API in `api.ts`. When one module needs data from
or an action by another, it imports that module's `api.ts` and calls it like
any function. Example: the calendar's `upsertEventFromSource()` is used by
whichever module wants something on the calendar.

### 2. Events: `core/bus`

When something happens that other modules may care about, the owning module
publishes an event. Subscribers react on their own.

| Event | Published by | Who listens, and what they do |
| --- | --- | --- |
| `trips.tripPlanned` | trips | calendar adds the trip; finance adds the trip budget (or, with no budget, the sum of step costs) as an expected expense. Re-published whenever dates, places or costs change |
| `trips.tripCancelled` | trips | calendar removes the trip; finance drops the expected expense |
| `maintenance.taskScheduled` | maintenance | calendar adds a reminder; finance adds the estimated cost as an expected expense |
| `maintenance.taskCancelled` | maintenance | calendar removes the reminder; finance drops the expected expense |
| `maintenance.costRecorded` | maintenance | finance updates the expected expense with the actual cost |
| `finance.annualFeeUpcoming` | finance | calendar adds an annual-fee reminder |
| `finance.transactionsSynced` | finance | (none yet) |
| `calendar.eventCreated` | calendar | (none yet) |

Rules:

- The catalogue lives in `src/core/bus/events.ts`, with a Zod schema per
  event. Payloads are validated on publish.
- Event names are `<module>.<fact>`. Only the owning module may publish its
  events; the bus throws otherwise.
- Payloads carry ids, dates, amounts and short titles. Never account
  numbers, raw bank data, tokens or secrets.
- Handlers must be idempotent. They key writes on `(sourceModule, sourceRef)`
  so a replayed event updates instead of duplicating.
- A failing handler is logged and isolated. It never fails the publisher or
  other handlers.

### Rules that keep modules separate

These are enforced by `tests/boundaries.test.ts`, which runs in CI.

1. A module imports another module only through its `api.ts` (or a future
   `ui/` folder for shared components). Never its `schema.ts` or internals.
2. A module never queries another module's tables. Tables are prefixed with
   the module name (`finance_`, `maintenance_`, `calendar_`, `trips_`).
3. `core/` never imports a module. The only exception is
   `core/db/schema.ts`, which aggregates schemas for Drizzle.
4. `modules/registry.ts` is the only place that wires modules together.

## Adding a cross-module feature

1. If module B needs to react to something in module A, add an event to
   `core/bus/events.ts`, publish it from A's `api.ts`, and subscribe in B's
   `module.ts`.
2. If module B needs to ask module A something, add a function to A's
   `api.ts` and call it from B.

## Finance ingestion

- **SimpleFIN** (`modules/finance/ingest/simplefin.ts`, `sync.ts`). One
  request per run pulls every account plus transactions since the last good
  run minus 5 days (89 days on the first run). Transactions are deduped on
  `(account, "simplefin", SimpleFIN id)`. Pending rows that SimpleFIN stops
  reporting are removed, since banks re-issue them under a new id when they
  post. User edits (display name, owner, type, active, category) are never
  overwritten by a sync.
- **Simplifi CSV** (`ingest/csv.ts`, `import.ts`). Each CSV account is mapped
  to an existing account, a new CSV-only account, or skipped. Rows dated on
  or after that account's SimpleFIN start date are dropped, and each row gets
  a content hash id, so importing the same or an overlapping export again
  adds nothing. If an account is linked to SimpleFIN after its history was
  imported, the sync deletes the CSV rows that SimpleFIN now covers.
  Recommended order: connect SimpleFIN first, then import history into the
  synced accounts.
- **Categories.** Simplifi categories (`Parent: Child`) are kept as
  category/subcategory, and the most common category per merchant becomes a
  rule that is applied to newly synced transactions.

## Finance insights and budgets

- The server sends the dashboard per-month aggregates (by account, owner,
  category, merchant) for the last 12 months. Owner, account and range
  filters run in the browser on those aggregates, so they are instant.
  Clicking a slice or bar loads the underlying transactions on demand.
- Spending = outflows net of refunds, excluding transfers and inactive
  accounts. Income = an `Income…` category or an uncategorized deposit.
- Auto-budget = average of the last 3 or 6 complete months per category,
  optionally ignoring one spike month (over 1.5x the median of the others),
  rounded up. Accepting stores it as `auto`; overrides are `manual` and
  survive "Accept all". Progress bars warn at 80% and flag at 100%.
- There is deliberately no forecasting or projection anywhere.
- Uncategorized merchants can be categorized in batches by the fast AI
  model (also run after each bank sync). It only sees merchant names, a
  typical amount and a count, referenced by index.

## Card rewards

- Each active credit card can have a profile: reward type, base rate, value
  per point (cents), annual fee and the month it posts. Bonus rules match a
  category, subcategory or merchant, with an optional spend cap per
  month/quarter/year and an optional date window for rotating categories.
- The audit (`rewards/engine.ts`) is plain code. Transactions are walked in
  date order; each is valued on the card used (with that card's cap usage)
  and on every household card (with a separate "optimal" cap ledger). The
  difference is "points left on the table", reported per category and per
  transaction, alongside each card's rewards value minus its fee.
- Saving a fee month publishes `finance.annualFeeUpcoming`; the calendar
  adds a reminder. It is re-published after each sync so next year's date
  appears once this year's has passed.
- The AI advisor (flagship model) runs on the 1st of each month via cron or
  on demand. It receives only aggregates: per-card spend/earn/fee, spend by
  category, monthly amounts of recurring merchants, and the audit's missed
  value by category. Reports are stored in `finance_advisor_reports`.

## Card rewards and trips

Trips asks finance which card to book with; finance never reads trip tables.

- `finance.planCardsForPurchases(purchases)` takes planned purchases (date
  the charge posts, amount, merchant, category) and returns the card per
  purchase plus each sign-up bonus's progress. It is plain code in
  `rewards/bonus.ts`.
- A card's profile can hold a sign-up offer: bonus (points, or dollars for
  cash back), minimum spend, start and deadline. Progress is the card's
  purchases net of refunds in that window; transfers and income never count.
- Planning: open offers are filled first, most valuable first, using only
  purchases that post before the deadline, cheapest multiplier loss per
  dollar first, and only if the plan can actually reach the minimum (partial
  progress is not worth giving up multipliers). Everything else goes to the
  best-multiplier card, honouring caps already used this year.
- Trips turns unpaid itinerary steps with a cost into purchases
  (`trips/card-plan.ts`): kind maps to the Simplifi category a charge would
  land in (flight to Travel / Air Travel, stay to Travel / Hotel, ...) and the
  booking provider is the merchant, so merchant rules like "Marriott" match.
  A step marked "paid with" a card drops out: its real charge will arrive
  through the bank sync and count there.

## Trips

Ported from the standalone family trip assistant (`p4vz/trip-assistant-`).
What moved: itinerary with booking states, re-check dates and two-zone
times; reusable packing templates; gluten-free dining (OpenStreetMap search,
pasted Find Me Gluten Free lists) with coeliac-grade ratings; printable
allergy cards; Wikipedia-grounded trivia, kids' quizzes and scavenger hunts;
per-place emergency info; the encrypted documents vault.

What changed in the move:

- One household, so the old household/invite-code layer is gone. People are
  `trips_travelers`; adults can be linked to a sign-in by owner label.
- AI goes through the shared layer (Gemini or Claude per Settings).
  Variables travel in the sanitized payload, and travellers are sent only as
  "adult" or "child, age 8", never by name.
- Documents download through a server action that returns the decrypted
  bytes to the signed-in member, because the app has no file routes.
- The old MCP endpoint and OAuth server came back as the household-wide,
  read-only assistant endpoint (see "Assistant (MCP) endpoint"). Not ported
  yet, because each needs new OAuth scopes: Google Photos, Drive backup and
  the Calendar mirror. The offline service worker is also not ported yet.

## Trip spending (bank charges on trips)

Charges are tied to things in other modules through one finance table,
`finance_transaction_links` (one row per transaction per module: `module`,
`target_id`, optional `detail_id`, `status` linked/dismissed, `source`
auto/manual/assistant). Finance owns it so every read goes through the same
privacy rule as the transaction (`finance/links.ts`, viewer first). Other
modules can reuse it with their own `module` name (an upkeep task, say).

- `trips/spend.ts` (pure): matching rules and plan vs actual. Strong matches:
  the company on an itinerary step at about its cost (or during the trip, or
  a refund), or charged in a trip town during the trip. Possible: trip-like
  categories during the trip, travel bookings in the 180 days before, the
  step's company at a different amount.
- After every `finance.transactionsSynced`, trips links strong matches for
  recent and upcoming trips (`autoLinkTripCharges`). It never overrides a
  link a person made or dismissed, and skips charges two trips both claim.
- `/trips/[slug]/spend` shows plan vs actual, flags, suggestions, linked
  charges (per step) and rewards earned vs the best card. Totals count only
  charges the signed-in member can see.
- A step with a linked charge counts as paid in `tripCardPlan`.
- Ask Claude: `trip_spending`, `link_trip_charges` (undoable, entity
  `trip_charge`), `trip_card_plan`, `best_card_for_purchases`.

## Card catalog

A stored, kept-current copy of each card product's published terms, so the
audit, the advisor and other modules never have to look them up live.

- `finance_card_catalog` holds one row per product (household cards and
  about 20 well-known cards seeded from `rewards/catalog/seed.ts`): fee,
  base rate, bonus categories with caps, rotating quarterly categories,
  current sign-up offer, credits, perks, source URLs, `verifiedAt`, and a
  `version` that increases on every change. Terms are validated by the Zod
  schema in `rewards/catalog/terms.ts`.
- Catalog categories (`dining`, `flights`, `merchant:Amazon` ...) map onto
  the household's Simplifi category/subcategory names in
  `rewards/catalog/categories.ts`. One multiplier over several names shares
  one cap (`capGroup`).
- **Refresh.** The daily `card-catalog` cron checks due cards with
  `runWebResearch()` (provider web search, then a tool-free extraction into
  the schema). Unchanged terms just get a new `verifiedAt`. Changes are
  saved and logged in `finance_card_catalog_changes` as `applied`, except
  when a person edited that card's terms or the change looks too large (fee
  moves by more than $100, base rate changes, most categories vanish): then
  it is `pending` until accepted on the catalog page. Rotating quarters
  already on file are never dropped by a refresh.
- **Household cards.** A card profile can link to a catalog product.
  Linking (or "Apply") copies fee, base rate and the catalog's multipliers
  as rules with `source = 'catalog'`; rules a person added (`source =
  'user'`) are never touched. When the catalog version moves past the one
  applied, the Rewards page shows what changed with Apply / Keep mine. The
  catalog's rotating quarters are added to the audit at run time for linked
  cards, unless the card has its own dated rule overlapping that quarter.
- **Comparison.** `runCatalogComparison()` prices every catalog card the
  household does not hold against the last 12 months of card spending:
  value added on top of held cards (best card per purchase, caps honoured)
  minus fee, with the sign-up bonus shown separately. The advisor receives
  the top 8 with their offers and verified dates, plus the stored credits,
  perks and current rotating categories of held cards.
- Other modules read stored terms through `heldCardTerms()` in `api.ts`.

## Assistant (MCP) endpoint

Lets Claude, ChatGPT and Gemini read household card and trip data through
custom connectors. Security rules are in SECURITY.md ("Assistant access");
setup in MCP.md.

```
core/oauth/     OAuth 2.1 authorization server (policy.ts pure, server.ts storage)
mcp/            tools.ts (read-only tools over module APIs), server.ts, sanitize.ts
app/api/mcp     Streamable HTTP endpoint (stateless, JSON responses)
app/api/oauth   register / token / revoke
app/oauth/authorize   consent screen
```

`src/mcp` is wiring like `app/`: it may import module `api.ts` files only
(enforced by the boundary tests). Planning tools reuse finance's
`planCardsForPurchases()` (the trips "Which card" logic), with
`PURCHASE_CATEGORY` mapping a purchase kind (`hotels`, `dining`, ...) to the
category a charge would land in. Tables: `core_oauth_clients`,
`core_oauth_codes`, `core_oauth_grants`.

## Backups and phone notifications

- `core/backup/`: nightly encrypted dump to Google Drive (`drive.file`),
  30-day retention; restore with `scripts/restore-backup.mjs`. See
  docs/BACKUP.md.
- `core/push/`: Web Push (VAPID + RFC 8291 encryption by hand, sent through
  `outboundFetch`), devices and per-member choices. `notify/` is wiring like
  `mcp/`: it asks maintenance, family and finance (`api.ts` only) what is
  due or new, and sends each reminder once per stage. Cron:
  `/api/cron/notifications`, hourly, 8 AM to 9 PM.

## Ask Claude (in-app assistant)

`src/assistant/` lets the built-in Claude (subscription first, API key as
backup; Gemini works too) answer questions across every module and clean up
data. Page: `/assistant`, history at `/assistant/history`.

- **Tools run in-process.** On the subscription they are an Agent SDK
  in-process MCP server (`createSdkMcpServer`), allowed by exact name with
  Claude Code's own tools off; on an API key they are AI SDK tools. Nothing
  is exposed over HTTP. Tools call module `api.ts` only.
- **Reads** act as the signed-in member: finance shows joint accounts and
  that member's own (`viewerFromLabel`, `visibleAccountIds`). Rows carry
  short refs ("t12") that map to ids on the server, per conversation.
- **Edits are changesets.** Edit tools only draft; at the end of the turn
  `changesets.ts` records each change with the editable fields before and
  after. Up to 10 changes without deletes apply at once (Pavel's choice,
  `policy.ts`); bigger batches and any delete wait for Apply. Applying
  re-reads each row and skips it as a conflict if it changed meanwhile.
  Undo works per change or per batch and leaves rows that changed again.
  Batches are capped at 200 changes.
- **What can change** (`entities.ts`): transaction category, subcategory,
  notes and transfer flag; merchant category rules; upkeep tasks for the
  house and cars (create, edit, mark done with cost and odometer, reopen;
  marking done schedules the next one and reopening removes it); home
  equipment; house projects; home binder entries (no files: those are added
  on the binder page, and entries with a file are not deleted from here);
  shopping items, whole lists (create, from a template, rename, put off,
  delete) and list templates; store returns; chores (create one-time or
  repeating per kid by name, edit, tick, archive) and chore goals with
  rewards; events on the family Google calendar (create, edit, delete;
  repeating events stay in Google Calendar). Deletes are soft where the
  module has it (chores and goals archive) and otherwise restorable from
  the snapshot (a deleted list comes back with its stores and items).
  Things created in one reply can be referred to by name in the same reply
  (a new list's items, a new chore's goal), since changes apply in order.
  Nothing moves money, edits amounts, accounts, bank connections, keys,
  settings or assistant permissions. Trips are read-only apart from linking
  charges.
- **Voice and photos** (`components/assistant/voice-photo.tsx`): a mic
  button types speech into the message box with the browser's own speech
  recognition (Web Speech API; hidden where the browser has none), and a
  photo button reads a picture's text on the device (tesseract.js, as on
  the home page upload). The text is shown for checking; only it is sent,
  and the server scrubs it (`withPhotoText` in `inbox.ts`) and marks it as
  data. No audio or picture reaches the app or Claude.
- **Kitchen screen** (`kitchen.ts`, adult mode only): the same agent with
  the fast model, a snapshot of the screen, and only the kitchen's tools
  (`KITCHEN_TOOLS`: calendar, chores and goals, shopping, returns, upkeep).
  Its context has no finance viewer (reading it throws), and
  `kitchenRefusal()` refuses any other entity, and any delete except a
  calendar event, when a change is drafted or applied. Its changesets are
  owned by the kitchen screen and also appear, undoable, in each member's
  history. The conversation itself is kept only on the screen.
- Conversations and changesets belong to the member who had them.

## Finance review (one-time cleanup)

`/finance/review`, run by each member over joint accounts and their own.

1. **Reconcile** (`finance/review/reconcile.ts`, plain code): imported
   CSV-only accounts are matched by name to linked SimpleFIN accounts and
   can be merged (rows the bank feed already has, same amount within 3
   days, are dropped); CSV/bank duplicates on one account; tidier nicknames
   and account types; stale balances, gaps between the import and bank
   sync, empty months, quiet unlinked accounts.
2. **Categories** (`finance/review/taxonomy.ts`, `categories.ts`): one
   category set (parents = `DEFAULT_CATEGORIES`, with subcategories). Mint
   and Simplifi names map through a built-in alias list; Claude suggests the
   rest via `runStructured` (category names and example merchants only).
   Applying remaps visible transactions and the shared merchant rules.
3. **Large purchases** (`finance/review/large.ts`): spending at or above a
   per-member threshold (default $500; not transfers, income, mortgage, loan
   or card payments) is listed until answered or skipped.
4. **House upkeep** (`src/assistant/review.ts`): an answer goes to Claude
   with the purchase's date, merchant, amount and category (scrubbed); the
   resulting note, home equipment (`maintenance_assets`) and upkeep tasks
   are recorded as an Ask Claude changeset, so they apply under the usual
   policy and are undone from its history.

Steps 1 and 2 log each fix in `finance_review_actions` with what is needed
to undo it; undo leaves rows that were changed again since.

## House upkeep and the house audit

`/maintenance` holds four things: **action items** (`maintenance_tasks`
with area, parts, last-done and next-due dates and a repeat interval;
completing one records the date and schedules the next), the **house
project history** (`maintenance_projects`, optionally linked to the bank
transaction that paid for it), **home equipment** (`maintenance_assets`,
with CPSC recall checks), and the **questionable transactions** tracker.

The **house audit** (`src/assistant/house-audit.ts`) runs on demand ("Run
audit now") and weekly per member after the 7 AM / 7 PM bank sync (the
`simplefin-sync` cron route; no extra Railway job). It links each dated
project to its payment (same amount within $1 and 60 days, vendor name
breaking ties), then sends open questionable transactions (date, merchant,
amount, category only) to Claude, whose guesses wait in the tracker for the
member. Cash withdrawals are always asked. Answers in the tracker go
through `review.ts`, which can add a house project, equipment and upkeep in
one undoable Ask Claude changeset.

Ask Claude also gets `house_projects`, `questionable_transactions`,
`check_recalls` (CPSC, `www.saferproducts.gov`) and `maintenance_research`
(the provider's own web search, no new host).

Migration 0018 seeds Pavel's maintenance schedule, equipment and project
history (2026-11-25), without invoice/order numbers or individuals' names.

### Cars

Cars are `maintenance_assets` of kind `vehicle` with a nickname, make, model,
year and the last odometer reading (migration 0019). There is deliberately no
VIN or plate column, so neither can reach the AI, MCP or logs. Action items
can belong to a car (`asset_id`) and be due by date or mileage, whichever
comes first (`due_mileage`, `recurrence_miles`); completing one with an
odometer reading records it on the car and schedules the next by both. Adding
a car can seed oil change, state inspection, registration and tire rotation
items. House history entries with an `asset_id` are that car's service
history. In the questionable-transactions tracker, shop, parts-store and
DMV/PennDOT payments come up as "Car upkeep" (fuel, parking, tolls and car
washes don't) and can be filed under a car; Claude's plan for an explained
payment gets the cars' nicknames, make, model, year and mileage. Car recalls
come from NHTSA (`api.nhtsa.gov`, keyless) by make, model and year.

### Home binder

`maintenance_documents` (migration 0020) holds manuals, warranties, insurance
policies, property tax bills and receipts, optionally linked to equipment, a
car (`asset_id`) or a house project (`project_id`). Files are sealed with
DOC_VAULT_KEY (AES-256-GCM) like trip documents, up to 8 MB of any type, and
decrypted only for a signed-in member's download (server action to blob URL;
no route). There is no column for policy, account or parcel numbers. A
warranty end, insurance renewal or tax due date keeps one reminder action
item (area "Home binder") 30 days ahead (14 for tax), which reaches the
calendar like any task. `addBinderDocument()` in `maintenance/api.ts` is the
filing entry point for the home-page upload.

## Subscriptions and net worth

Subscriptions (`finance/subscriptions*.ts`): recurring charges are detected on
the fly from the last 400 days of transactions the viewer can see, grouped
by account owner and merchant (weekly, monthly, quarterly or yearly at a
steady price; price rises flagged). `finance_subscriptions` stores what a
member confirmed, renamed, cancelled, hid ("not a subscription") or added by
hand. Rows follow the account privacy rule: joint plus the viewer's own.

Net worth (`finance/net-worth*.ts`): account balances (signed as the bank
reports them) plus hand-entered assets and liabilities
(`finance_net_worth_items`, dated values in `finance_net_worth_values`).
Scopes are Joint, the viewer's own, or both; never the other member's own.
History is month ends for two years: each bank sync writes a daily balance
snapshot (`finance_balance_snapshots`) and earlier balances are worked back
from transactions. History only, no forecast. Neither feature sends anything
to an AI or an assistant.

## Kitchen kiosk and family hub

`/kiosk` is a single 1920x1080 touch screen (no page scroll): calendar on
the left 55%, the kids' chore board top right, Shopping / Returns / Upkeep
tabs bottom right. `/family` is the phone companion (390-430 px) with the
same lists plus setup. Both are thin pages over module APIs:

- **family** owns `family_kids`, `family_chores`,
  `family_chore_completions` (`kid_id`, `chore_id`, `completed_at`,
  `date_bucket`, `stars`), the shopping tables and
  `family_purchase_returns`.
- **Shopping lists** (`family/shopping.ts`): `family_shopping_lists`
  (ordered, optional `deferred_until`) hold `family_shopping_sections` (one
  per store, ordered), which hold `family_shopping_items` (ordered tiles).
  `family_shopping_templates` + `_template_items` start new lists; any list
  can be saved as one (same name replaces). Ticking an item ticks every
  item with the same name (`itemKey()`: case, spacing and punctuation
  ignored) on every list that is not deferred, all with one `checked_at`,
  so un-ticking undoes that group. A deferred list is simply filtered out
  until its date. The shopping UI keeps its own state: each action answers
  with the whole board, and every screen polls `syncShoppingAction` every
  3 s, which reads one revision counter (`family_shopping_revision`, bumped
  by every change) and only returns the board when it moved.
- **Chore resets need no job.** A completion is stored against its period:
  the chore day (4 AM `America/New_York` rollover) for daily and one-time
  chores, the Monday of the chore week for weekly ones (rolls over Monday
  4 AM, i.e. Sunday night). The board shows a chore as done only if it has
  a completion in the current period, so a missed cron run can never leave
  yesterday's ticks on the wall. Stats (today, week %, streak of fully done
  days, stars) are computed from the stored history (`family/stats.ts`).
- **Upkeep** stays in the maintenance module. Tasks now have an optional
  repeat interval; `completeTask()` schedules the next one from the day it
  was done, which publishes `maintenance.taskScheduled` as usual (calendar
  reminder, expected expense). The kiosk lists tasks due within 14 days.
- **Calendar** owns the Google sync (`calendar/google.ts`) and
  `kioskCalendar()`, which merges Google events with household entries
  (trips, events typed by hand; never finance reminders).
- **Live updates** without new HTTP routes: the kiosk calls
  `router.refresh()` every 30 s while visible, and every action except
  shopping (see above) revalidates `/kiosk` and `/family`.
- **Printing** (`src/lib/thermal/`): `receipt.ts` lays out 32-column text
  and encodes ESC/POS (bold, centre, double size, divider, `[ ]`
  checkboxes, feed and cut); `thermalPrinter.ts` writes it over Web
  Bluetooth (service `0x18F0`, then any writable characteristic on known
  vendor services) in 100-byte chunks. Without Web Bluetooth (iPhone,
  Firefox) or on failure, a 58 mm print preview goes through the browser
  print dialog.
- Cron `/api/cron/family-hub` (hourly) refreshes Google events and clears
  ticked shopping items after 12 hours (and a list left empty by that) and
  returned items after 30 days.

## Database

Drizzle ORM on Postgres. Migrations live in `drizzle/` and are generated with
`npm run db:generate`, applied with `npm run db:migrate`. The integration
tests apply the same migrations to an in-memory PGlite database.
