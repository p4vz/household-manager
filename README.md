# Household manager

A private web app for a two-person household: finances, home maintenance,
calendar and trips, in one Next.js app with one Postgres database.

- Architecture and how the modules talk to each other: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Who and what can connect to it: [docs/SECURITY.md](docs/SECURITY.md)

## Status

| Module | State |
| --- | --- |
| Finance (expenses, auto-budget, card rewards) | bank sync, CSV history, accounts, charts, auto-budget, rewards audit, AI advisor |
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
For return emails, also add `/settings/email/callback` on the same origins,
enable the Gmail API, and add the `gmail.readonly` scope to the consent screen.
For backups, also add `/settings/backup/callback`, enable the Google Drive
API, and add the `drive.file` scope.

## Checks

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

## Deploying on Railway

1. Create a project with a Postgres service and a service from this repo.
2. Set the variables from `.env.example` on the app service.
3. Start command: `npm run db:migrate && npm start`.
4. Add a second service from the same repo for cron: schedule `0 * * * *`,
   start command `node scripts/cron.mjs simplefin-sync monthly-advisor card-catalog family-hub backup notifications`, variables `APP_URL`
   (the app's public URL) and `CRON_SECRET`. The app only contacts SimpleFIN
   at 7 AM and 7 PM in `HOUSEHOLD_TIMEZONE`, runs the AI card
   review on the 1st of each month, checks due card catalog entries
   against issuer pages at 6 AM, and refreshes the kitchen kiosk's Google
   Calendar copy every hour, backs up to Google Drive at 3 AM
   (docs/BACKUP.md) and sends phone notifications between 8 AM and 9 PM.

## First run

1. Sign in with one of the two allowlisted Google accounts.
2. Settings → Bank sync (SimpleFIN): paste a setup token from SimpleFIN Bridge.
3. Finance → Accounts: give each card a display name, owner and type.
4. Finance → Import Simplifi history: drop the Simplifi CSV export.
5. Finance → Rewards: link each card to its catalog entry (fills in fee,
   base rate and bonus categories), or enter them by hand, and set the
   point value.
6. Settings: pick Gemini or Claude and the fast/flagship models.
7. Kitchen kiosk: on your phone, Family hub → Setup to add the kids, their
   chores. Shopping starts with two templates (Weekly Sam's, Weekly
   Russian); save any list as another. Set `GOOGLE_CALENDARS` and a calendar
   credential (see `.env.example`). On the wall screen open `/kiosk/pair`,
   and type the code from Settings → Kitchen kiosk. Pair the Bluetooth
   printer from the first Print tap (Chrome asks which device).
