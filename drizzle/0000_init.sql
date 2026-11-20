CREATE TABLE "core_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_expected_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"date" date NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"category" text,
	"source_module" text NOT NULL,
	"source_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"due_date" date NOT NULL,
	"estimated_cost" numeric(12, 2),
	"actual_cost" numeric(12, 2),
	"completed_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"all_day" boolean DEFAULT true NOT NULL,
	"notes" text,
	"source_module" text,
	"source_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips_trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"destination" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"budget" numeric(12, 2),
	"status" text DEFAULT 'planned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "finance_expected_source_uq" ON "finance_expected_expenses" USING btree ("source_module","source_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_events_source_uq" ON "calendar_events" USING btree ("source_module","source_ref");