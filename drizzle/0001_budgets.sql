CREATE TABLE "finance_budgets" (
	"category" text PRIMARY KEY NOT NULL,
	"monthly_limit" numeric(14, 2) NOT NULL,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
