CREATE TABLE "family_star_prizes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"emoji" text DEFAULT '🎁' NOT NULL,
	"stars" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "family_star_spends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kid_id" uuid NOT NULL,
	"prize_name" text NOT NULL,
	"emoji" text DEFAULT '🎁' NOT NULL,
	"stars" integer NOT NULL,
	"given_by" text NOT NULL,
	"given_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "family_star_spends" ADD CONSTRAINT "family_star_spends_kid_id_family_kids_id_fk" FOREIGN KEY ("kid_id") REFERENCES "public"."family_kids"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "family_star_spends_kid_idx" ON "family_star_spends" USING btree ("kid_id");--> statement-breakpoint
INSERT INTO "family_star_prizes" ("name", "emoji", "stars") VALUES ('Small prize', '🍭', 25), ('Medium prize', '🎁', 100), ('Large prize', '🏆', 500);
