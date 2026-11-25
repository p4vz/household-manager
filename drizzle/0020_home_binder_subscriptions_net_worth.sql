CREATE TABLE "finance_balance_snapshots" (
	"account_id" uuid NOT NULL,
	"date" date NOT NULL,
	"balance" numeric(14, 2) NOT NULL,
	CONSTRAINT "finance_balance_snapshots_account_id_date_pk" PRIMARY KEY("account_id","date")
);
--> statement-breakpoint
CREATE TABLE "finance_net_worth_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text DEFAULT 'joint' NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"acquired_on" date,
	"closed_on" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_net_worth_values" (
	"item_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"value" numeric(14, 2) NOT NULL,
	CONSTRAINT "finance_net_worth_values_item_id_as_of_pk" PRIMARY KEY("item_id","as_of")
);
--> statement-breakpoint
CREATE TABLE "finance_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text DEFAULT 'joint' NOT NULL,
	"merchant_key" text,
	"name" text NOT NULL,
	"amount" numeric(14, 2),
	"cadence" text DEFAULT 'monthly' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"next_charge" date,
	"notes" text,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"title" text NOT NULL,
	"provider" text,
	"asset_id" uuid,
	"project_id" uuid,
	"starts_on" date,
	"expires_on" date,
	"amount" numeric(12, 2),
	"url" text,
	"notes" text,
	"file_name" text,
	"mime_type" text,
	"size_bytes" integer,
	"cipher_text" "bytea",
	"iv" "bytea",
	"auth_tag" "bytea",
	"reminder_task_id" uuid,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finance_balance_snapshots" ADD CONSTRAINT "finance_balance_snapshots_account_id_finance_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_net_worth_values" ADD CONSTRAINT "finance_net_worth_values_item_id_finance_net_worth_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."finance_net_worth_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_subscriptions_merchant_uq" ON "finance_subscriptions" USING btree ("owner","merchant_key");