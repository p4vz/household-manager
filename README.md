# Household manager

A private web app for a two-person household: finances, home maintenance,
calendar and trips, in one Next.js app with one Postgres database.

- Architecture and how the modules talk to each other: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Who and what can connect to it: [docs/SECURITY.md](docs/SECURITY.md)

## Status

| Module | State |
| --- | --- |
| Finance (expenses, auto-budget, card rewards) | in progress: bank sync, CSV history, accounts |
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
4. Add a second service from the same repo for cron: schedule `0 * * * *`,
   start command `node scripts/cron.mjs simplefin-sync`, variables `APP_URL`
   (the app's public URL) and `CRON_SECRET`. The app only contacts SimpleFIN
   at 7 AM and 7 PM in `HOUSEHOLD_TIMEZONE`.

## First run

1. Sign in with one of the two allowlisted Google accounts.
2. Finance → Connect SimpleFIN: paste a setup token from SimpleFIN Bridge.
3. Finance → Accounts: give each card a display name, owner and type.
4. Finance → Import Simplifi history: drop the Simplifi CSV export.
