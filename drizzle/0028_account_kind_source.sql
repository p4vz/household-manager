ALTER TABLE "finance_accounts" ADD COLUMN "kind_source" text DEFAULT 'guess' NOT NULL;--> statement-breakpoint
-- Types already picked in the Finance review count as a person's choice.
UPDATE "finance_accounts" SET "kind_source" = 'manual'
WHERE "id"::text IN (
  SELECT "undo"->>'accountId' FROM "finance_review_actions"
  WHERE "kind" = 'rename_account' AND "status" = 'applied'
);
