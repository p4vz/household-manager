CREATE TABLE "family_books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kid_id" uuid NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"language" text NOT NULL,
	"finished" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "family_books" ADD CONSTRAINT "family_books_kid_id_family_kids_id_fk" FOREIGN KEY ("kid_id") REFERENCES "public"."family_kids"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "family_books_kid_idx" ON "family_books" USING btree ("kid_id");--> statement-breakpoint
-- Books already in the reading log go on each kid's shelf.
INSERT INTO "family_books" ("kid_id", "title", "language", "created_at")
SELECT DISTINCT ON ("kid_id", lower("book")) "kid_id", "book", "language", "created_at"
FROM "family_reading_log"
ORDER BY "kid_id", lower("book"), "created_at" DESC;
