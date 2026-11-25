CREATE TABLE "finance_transaction_links" (
	"transaction_id" uuid NOT NULL,
	"module" text NOT NULL,
	"target_id" text NOT NULL,
	"detail_id" text,
	"status" text DEFAULT 'linked' NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_transaction_links_transaction_id_module_pk" PRIMARY KEY("transaction_id","module")
);
--> statement-breakpoint
ALTER TABLE "finance_transaction_links" ADD CONSTRAINT "finance_transaction_links_transaction_id_finance_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."finance_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_txn_links_target_idx" ON "finance_transaction_links" USING btree ("module","target_id");