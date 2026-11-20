CREATE TABLE "finance_advisor_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trigger" text NOT NULL,
	"provider" text NOT NULL,
	"report" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_card_profiles" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"reward_type" text DEFAULT 'points' NOT NULL,
	"base_rate" numeric(6, 3) DEFAULT 1 NOT NULL,
	"cents_per_unit" numeric(6, 3) DEFAULT 1 NOT NULL,
	"annual_fee" numeric(14, 2) DEFAULT 0 NOT NULL,
	"annual_fee_month" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_card_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"match_type" text NOT NULL,
	"match" text NOT NULL,
	"rate" numeric(6, 3) NOT NULL,
	"cap_amount" numeric(14, 2),
	"cap_period" text,
	"valid_from" date,
	"valid_to" date,
	"label" text
);
--> statement-breakpoint
ALTER TABLE "finance_card_profiles" ADD CONSTRAINT "finance_card_profiles_account_id_finance_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_card_rules" ADD CONSTRAINT "finance_card_rules_account_id_finance_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE cascade ON UPDATE no action;