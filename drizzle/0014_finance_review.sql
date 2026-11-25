CREATE TABLE "finance_review_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"viewer" text NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"undo" jsonb NOT NULL,
	"status" text DEFAULT 'applied' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "finance_review_questions" (
	"transaction_id" uuid PRIMARY KEY NOT NULL,
	"viewer" text NOT NULL,
	"status" text NOT NULL,
	"answer" text,
	"outcome" jsonb,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_review_state" (
	"viewer" text PRIMARY KEY NOT NULL,
	"large_threshold" numeric(14, 2) DEFAULT 500 NOT NULL,
	"category_proposal" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"location" text,
	"installed_on" date,
	"cost" numeric(12, 2),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finance_review_questions" ADD CONSTRAINT "finance_review_questions_transaction_id_finance_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."finance_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_review_actions_viewer_idx" ON "finance_review_actions" USING btree ("viewer","created_at");--> statement-breakpoint
-- Pavel's standing upkeep task (2026-11-25): change the AC filters once a month.
-- An existing open HVAC/AC filter task is switched to monthly instead of adding a second one.
UPDATE "maintenance_tasks" SET "recurrence_days" = 30
WHERE "completed_on" IS NULL AND "title" ~* '(\mac\M|hvac|air).*filter|filter.*(\mac\M|hvac|air)';--> statement-breakpoint
INSERT INTO "maintenance_tasks" ("title", "due_date", "recurrence_days", "notes")
SELECT 'Change AC filters', DATE '2026-12-01', 30, 'Every month. Note the filter size here once you know it.'
WHERE NOT EXISTS (
  SELECT 1 FROM "maintenance_tasks"
  WHERE "completed_on" IS NULL AND "title" ~* '(\mac\M|hvac|air).*filter|filter.*(\mac\M|hvac|air)'
);--> statement-breakpoint
INSERT INTO "calendar_events" ("title", "start_date", "source_module", "source_ref")
SELECT 'Maintenance: ' || t."title", t."due_date", 'maintenance', t."id"::text
FROM "maintenance_tasks" t
WHERE t."completed_on" IS NULL AND t."title" ~* '(\mac\M|hvac|air).*filter|filter.*(\mac\M|hvac|air)'
ON CONFLICT ("source_module", "source_ref") DO NOTHING;
