ALTER TABLE "maintenance_assets" ADD COLUMN "make" text;--> statement-breakpoint
ALTER TABLE "maintenance_assets" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "maintenance_assets" ADD COLUMN "year" integer;--> statement-breakpoint
ALTER TABLE "maintenance_assets" ADD COLUMN "mileage" integer;--> statement-breakpoint
ALTER TABLE "maintenance_assets" ADD COLUMN "mileage_on" date;--> statement-breakpoint
ALTER TABLE "maintenance_projects" ADD COLUMN "asset_id" uuid;--> statement-breakpoint
ALTER TABLE "maintenance_tasks" ADD COLUMN "asset_id" uuid;--> statement-breakpoint
ALTER TABLE "maintenance_tasks" ADD COLUMN "due_mileage" integer;--> statement-breakpoint
ALTER TABLE "maintenance_tasks" ADD COLUMN "recurrence_miles" integer;--> statement-breakpoint
ALTER TABLE "maintenance_tasks" ADD COLUMN "last_done_mileage" integer;