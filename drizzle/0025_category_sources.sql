ALTER TABLE "finance_category_rules" ADD COLUMN "source" text DEFAULT 'learned' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_transactions" ADD COLUMN "category_source" text;--> statement-breakpoint
ALTER TABLE "finance_transactions" ADD COLUMN "category_reason" text;--> statement-breakpoint
ALTER TABLE "finance_transactions" ADD COLUMN "memo" text;--> statement-breakpoint
-- Existing categories: CSV rows came from Simplifi/Mint; synced ones are of unknown origin.
UPDATE "finance_transactions" SET "category_source" = CASE WHEN "source" = 'csv' THEN 'import' ELSE 'legacy' END WHERE "category" IS NOT NULL;--> statement-breakpoint
-- Rules with no imported history behind them were Claude's guesses from the merchant name.
UPDATE "finance_category_rules" r SET "source" = 'ai' WHERE NOT EXISTS (
  SELECT 1 FROM "finance_transactions" t WHERE t."source" = 'csv' AND lower(trim(t."merchant")) = r."merchant"
);
