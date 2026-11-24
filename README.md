# Agent run archive

Logs and statistics of finished Agents UI runs, moved here from the server to free disk space.

- `runs/<YYYY-MM>/<run id>/meta.json`: run settings, status, token usage
- `events.jsonl`: everything the run did (gzipped when large)
- `audit.jsonl`: per-turn performance audit
- `audits/`: weekly audit summaries

Unmerged work from archived runs was pushed as its own `agents/<run id>` branch.
