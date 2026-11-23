CREATE TABLE "core_kiosk_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "core_kiosk_pairing_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_google_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"calendar_key" text NOT NULL,
	"google_event_id" text NOT NULL,
	"title" text NOT NULL,
	"location" text,
	"all_day" boolean DEFAULT false NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"start_date" date,
	"end_date" date,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "family_chore_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kid_id" uuid NOT NULL,
	"chore_id" uuid NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"date_bucket" date NOT NULL,
	"stars" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "family_chores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kid_id" uuid NOT NULL,
	"title" text NOT NULL,
	"icon" text DEFAULT '✅' NOT NULL,
	"recurrence" text NOT NULL,
	"stars" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "family_kids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#3b82f6' NOT NULL,
	"emoji" text DEFAULT '⭐' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "family_purchase_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_name" text NOT NULL,
	"store" text NOT NULL,
	"return_deadline" date,
	"status" text DEFAULT 'pending' NOT NULL,
	"notes" text,
	"order_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"returned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "family_shopping_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"store" text NOT NULL,
	"quantity" text,
	"is_staple" boolean DEFAULT false NOT NULL,
	"checked" boolean DEFAULT false NOT NULL,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "maintenance_tasks" ADD COLUMN "recurrence_days" integer;--> statement-breakpoint
ALTER TABLE "maintenance_tasks" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "maintenance_tasks" ADD COLUMN "previous_task_id" uuid;--> statement-breakpoint
ALTER TABLE "family_chore_completions" ADD CONSTRAINT "family_chore_completions_kid_id_family_kids_id_fk" FOREIGN KEY ("kid_id") REFERENCES "public"."family_kids"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_chore_completions" ADD CONSTRAINT "family_chore_completions_chore_id_family_chores_id_fk" FOREIGN KEY ("chore_id") REFERENCES "public"."family_chores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_chores" ADD CONSTRAINT "family_chores_kid_id_family_kids_id_fk" FOREIGN KEY ("kid_id") REFERENCES "public"."family_kids"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "core_kiosk_devices_token_uq" ON "core_kiosk_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "core_kiosk_pairing_codes_expires_idx" ON "core_kiosk_pairing_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_google_events_uq" ON "calendar_google_events" USING btree ("calendar_key","google_event_id");--> statement-breakpoint
CREATE INDEX "calendar_google_events_start_idx" ON "calendar_google_events" USING btree ("starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "family_chore_completions_uq" ON "family_chore_completions" USING btree ("chore_id","date_bucket");--> statement-breakpoint
CREATE INDEX "family_chore_completions_kid_idx" ON "family_chore_completions" USING btree ("kid_id","date_bucket");--> statement-breakpoint
CREATE INDEX "family_chores_kid_idx" ON "family_chores" USING btree ("kid_id");--> statement-breakpoint
CREATE INDEX "family_shopping_items_store_idx" ON "family_shopping_items" USING btree ("store");