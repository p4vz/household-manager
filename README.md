# Household manager

A private web app for a two-person household: finances, home maintenance,
calendar and trips, in one Next.js app with one Postgres database.

- Architecture and how the modules talk to each other: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Who and what can connect to it: [docs/SECURITY.md](docs/SECURITY.md)

## Status

| Module | State |
| --- | --- |
| Finance (expenses, auto-budget, card rewards) | in progress |
| Home maintenance | scaffold: tasks with dates and costs |
| Calendar | scaffold: events created by other modules |
| Trips | scaffold: trips with dates and a budget |

## Local setup

```bash
cp .env.example .env.local      # fill in the values
npm install
npm run db:migrate              # needs DATABASE_URL
npm run dev
```

Google OAuth client: add `http://localhost:3000/api/auth/callback/google`
(and the Railway URL equivalent) as an authorized redirect URI.

## Checks

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

## Deploying on Railway

1. Create a project with a Postgres service and a service from this repo.
2. Set the variables from `.env.example` on the app service.
3. Start command: `npm run db:migrate && npm start`.
4. Add a cron service (later milestone) that calls `/api/cron/*` with
   `Authorization: Bearer $CRON_SECRET`.
