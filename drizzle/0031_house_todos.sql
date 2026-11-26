ALTER TABLE "maintenance_tasks" ADD COLUMN "todo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "maintenance_tasks" ADD COLUMN "assignee" text;--> statement-breakpoint
ALTER TABLE "maintenance_tasks" ADD COLUMN "deferred_until" date;