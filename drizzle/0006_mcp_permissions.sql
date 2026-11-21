ALTER TABLE "core_oauth_codes" ADD COLUMN "permissions" jsonb;--> statement-breakpoint
ALTER TABLE "core_oauth_grants" ADD COLUMN "permissions" jsonb;