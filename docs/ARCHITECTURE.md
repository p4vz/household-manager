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
| `trips.tripPlanned` | trips | calendar adds the trip; finance adds the trip budget as an expected expense |
| `trips.tripCancelled` | trips | calendar removes the trip; finance drops the expected expense |
| `maintenance.taskScheduled` | maintenance | calendar adds a reminder; finance adds the estimated cost as an expected expense |
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

## Database

Drizzle ORM on Postgres. Migrations live in `drizzle/` and are generated with
`npm run db:generate`, applied with `npm run db:migrate`. The integration
tests apply the same migrations to an in-memory PGlite database.
