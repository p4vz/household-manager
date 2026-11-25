CREATE TABLE "family_reading_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kid_id" uuid NOT NULL,
	"day" date NOT NULL,
	"book" text NOT NULL,
	"language" text NOT NULL,
	"minutes" integer NOT NULL,
	"pages" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "family_reading_log" ADD CONSTRAINT "family_reading_log_kid_id_family_kids_id_fk" FOREIGN KEY ("kid_id") REFERENCES "public"."family_kids"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "family_reading_log_kid_day_idx" ON "family_reading_log" USING btree ("kid_id","day");