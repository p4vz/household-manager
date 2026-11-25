ALTER TABLE "calendar_google_events" ADD COLUMN "etag" text;--> statement-breakpoint
ALTER TABLE "calendar_google_events" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_google_events" ADD COLUMN "recurring" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_google_events" RENAME COLUMN "synced_at" TO "last_synced_at";