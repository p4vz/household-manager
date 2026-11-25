CREATE TABLE "finance_account_images" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"mime_type" text NOT NULL,
	"cipher_text" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"bytes" integer NOT NULL,
	"uploaded_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finance_account_images" ADD CONSTRAINT "finance_account_images_account_id_finance_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD COLUMN "official_name" text;--> statement-breakpoint
-- Budgets become per member. Existing household limits are copied to both.
ALTER TABLE "finance_budgets" ADD COLUMN "viewer" text NOT NULL DEFAULT 'user1';--> statement-breakpoint
ALTER TABLE "finance_budgets" DROP CONSTRAINT "finance_budgets_pkey";--> statement-breakpoint
INSERT INTO "finance_budgets" ("viewer", "category", "monthly_limit", "source", "updated_at")
  SELECT 'user2', "category", "monthly_limit", "source", "updated_at" FROM "finance_budgets" WHERE "viewer" = 'user1';--> statement-breakpoint
ALTER TABLE "finance_budgets" ALTER COLUMN "viewer" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "finance_budgets" ADD CONSTRAINT "finance_budgets_viewer_category_pk" PRIMARY KEY("viewer","category");--> statement-breakpoint
-- Older advisor reports mixed both members' accounts: kept, but no longer shown.
ALTER TABLE "finance_advisor_reports" ADD COLUMN "viewer" text;--> statement-breakpoint
-- No account or card numbers, even masked ones like "(...1234)", in stored bank names.
UPDATE "finance_accounts"
  SET "bank_name" = coalesce(nullif(btrim(regexp_replace("bank_name", '\s*[([]?\s*(?:[.*xX#-]{2,}|#)?\s*[0-9](?:[ -]?[0-9]){3,}\s*[])]?', '', 'g')), ''), 'Account')
  WHERE "bank_name" ~ '[0-9](?:[ -]?[0-9]){3,}';
