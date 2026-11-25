# Backups and restore

Two layers. Neither ever puts household data in GitHub.

## 1. Railway volume backups (first line)

On the Postgres service in Railway: **Settings → Backups**, tick **Daily**
(kept 6 days) and **Weekly** (kept 27 days); **Monthly** (kept 89 days) is
worth adding. To roll back, open the same Backups tab, pick a date and click
**Restore**, review the staged change and **Deploy**. Railway mounts the
backup as a new volume; the old one stays, unmounted.

Limits: restores only work inside the same Railway project, and deleting the
volume deletes its backups. That is why there is a second copy.

## 2. Nightly encrypted copy in Google Drive (off-site)

Setup, once:

1. Generate the key and save it in your password manager **before** setting
   it on Railway (without it the backups can't be opened):
   `openssl rand -base64 32` → Railway variable `BACKUP_KEY` on the app.
   Save `AUTH_SECRET` and `DOC_VAULT_KEY` there too: some values inside the
   backup (saved API keys, connected mailboxes, trip documents, card
   pictures) are sealed with them.
2. Google Cloud console, same project as the sign-in client: enable the
   **Google Drive API**; on the OAuth client add the redirect URI
   `https://<app>/settings/backup/callback`; on the consent screen add the
   `.../auth/drive.file` scope (non-sensitive, no review needed).
3. Railway cron service: add `backup notifications` to its start command
   (see README).
4. In the app: **Settings → Backups → Connect Google Drive**, then **Back up
   now**. A "Household manager backups" folder appears in that Drive with a
   `household-<date>.hmbackup` file.

From then on it runs at 3 AM household time, keeps 30 days (never fewer than
the newest 7) and shows the last result in Settings.

## Restoring a Drive backup

On any computer with Node 22 and a checkout of this repo (same or newer than
the backup), after `npm ci`:

```bash
# 1. Check the file opens, and see what is in it
BACKUP_KEY='...' node scripts/restore-backup.mjs inspect household-2026-11-26T0800Z.hmbackup

# 2. Make a NEW, empty Postgres (e.g. a new Postgres service in Railway) and copy its public URL
BACKUP_KEY='...' node scripts/restore-backup.mjs restore household-2026-11-26T0800Z.hmbackup 'postgresql://...'
```

The script refuses a database that already has tables. It applies the repo's
migrations up to the backup's level, loads every table in one transaction,
checks row counts, and moves sequences past the data. Then point the app's
`DATABASE_URL` at the new database (with the same `AUTH_SECRET` and
`DOC_VAULT_KEY` as before) and redeploy: the start command applies any newer
migrations.

Tested: `tests/backup.integration.test.ts` round-trips a database through the
app's writer and the script's reader, and the same was checked by hand
against Postgres 16 (every table identical after restore).
