CREATE TABLE "family_chore_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kid_id" uuid NOT NULL,
	"chore_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target" integer NOT NULL,
	"reward" text NOT NULL,
	"reward_emoji" text DEFAULT '🎁' NOT NULL,
	"started_on" date NOT NULL,
	"achieved_on" date,
	"reward_given_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "family_chore_goals" ADD CONSTRAINT "family_chore_goals_kid_id_family_kids_id_fk" FOREIGN KEY ("kid_id") REFERENCES "public"."family_kids"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_chore_goals" ADD CONSTRAINT "family_chore_goals_chore_id_family_chores_id_fk" FOREIGN KEY ("chore_id") REFERENCES "public"."family_chores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "family_chore_goals_kid_idx" ON "family_chore_goals" USING btree ("kid_id");