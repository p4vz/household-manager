<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project rules

Read `docs/ARCHITECTURE.md` and `docs/SECURITY.md` before changing code.

- Modules (`src/modules/*`) call each other only through `api.ts` or events on the bus. Never import another module's schema or internals.
- Every Server Action uses `authedAction()`. Every page under `(app)` relies on the layout's `requireUserOrRedirect()`.
- No new HTTP route handlers outside `/api/auth` and `/api/cron`. Cron routes must call `isValidCronRequest()`.
- Network calls go through `outboundFetch`. New hosts need an entry in `src/core/net/hosts.ts` and `docs/SECURITY.md`.
- AI calls go through `runStructured()` with a payload from `sanitizePayload()` / `toLlmTransaction()`.
- Run `npm run lint && npm run typecheck && npm test` before pushing.
