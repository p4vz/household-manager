CREATE TABLE "family_slideshow_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch" uuid NOT NULL,
	"source_id" text NOT NULL,
	"mime_type" text NOT NULL,
	"cipher_text" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "family_slideshow_photos_batch_source_idx" ON "family_slideshow_photos" USING btree ("batch","source_id");