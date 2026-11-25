CREATE TABLE "calendar_event_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"calendar_key" text NOT NULL,
	"google_event_id" text NOT NULL,
	"mime_type" text NOT NULL,
	"cipher_text" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"bytes" integer NOT NULL,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_google_events" ADD COLUMN "notes" text;--> statement-breakpoint
CREATE INDEX "calendar_event_photos_event_idx" ON "calendar_event_photos" USING btree ("calendar_key","google_event_id");