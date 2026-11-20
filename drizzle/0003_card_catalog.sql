CREATE TABLE "finance_card_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"name" text NOT NULL,
	"terms" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"source_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'seed' NOT NULL,
	"verified_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"last_error" text,
	"edited_by" text DEFAULT 'seed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_card_catalog_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer NOT NULL,
	"changes" jsonb NOT NULL,
	"proposed" jsonb NOT NULL,
	"source_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"seen" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finance_card_profiles" ADD COLUMN "catalog_product_id" text;--> statement-breakpoint
ALTER TABLE "finance_card_profiles" ADD COLUMN "catalog_applied_version" integer;--> statement-breakpoint
ALTER TABLE "finance_card_rules" ADD COLUMN "source" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_card_rules" ADD COLUMN "cap_group" text;--> statement-breakpoint
ALTER TABLE "finance_card_catalog_changes" ADD CONSTRAINT "finance_card_catalog_changes_product_id_finance_card_catalog_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."finance_card_catalog"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_catalog_changes_product_idx" ON "finance_card_catalog_changes" USING btree ("product_id","detected_at");--> statement-breakpoint
ALTER TABLE "finance_card_profiles" ADD CONSTRAINT "finance_card_profiles_catalog_product_id_finance_card_catalog_id_fk" FOREIGN KEY ("catalog_product_id") REFERENCES "public"."finance_card_catalog"("id") ON DELETE set null ON UPDATE no action;