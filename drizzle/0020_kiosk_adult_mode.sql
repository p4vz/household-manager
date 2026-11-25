CREATE TABLE "core_kiosk_adult_pin" (
	"id" text PRIMARY KEY NOT NULL,
	"pin_hash" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core_kiosk_devices" ADD COLUMN "adult_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core_kiosk_devices" ADD COLUMN "pin_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "core_kiosk_devices" ADD COLUMN "pin_locked_until" timestamp with time zone;