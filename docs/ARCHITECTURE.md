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
| `trips.tripCancelled` | trips | calendar removes the trip |
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

## Database

Drizzle ORM on Postgres. Migrations live in `drizzle/` and are generated with
`npm run db:generate`, applied with `npm run db:migrate`. The integration
tests apply the same migrations to an in-memory PGlite database.
