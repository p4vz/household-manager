CREATE TABLE "assistant_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"changeset_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"entity" text NOT NULL,
	"op" text NOT NULL,
	"target_key" text,
	"label" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"status" text DEFAULT 'proposed' NOT NULL,
	"error" text,
	"applied_at" timestamp with time zone,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "assistant_changesets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid,
	"owner_email" text NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"auto_applied" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "assistant_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_email" text NOT NULL,
	"title" text NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_ref" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_changes" ADD CONSTRAINT "assistant_changes_changeset_id_assistant_changesets_id_fk" FOREIGN KEY ("changeset_id") REFERENCES "public"."assistant_changesets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_changesets" ADD CONSTRAINT "assistant_changesets_conversation_id_assistant_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."assistant_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_changes_set_idx" ON "assistant_changes" USING btree ("changeset_id","seq");--> statement-breakpoint
CREATE INDEX "assistant_changesets_owner_idx" ON "assistant_changesets" USING btree ("owner_email","created_at");--> statement-breakpoint
CREATE INDEX "assistant_conversations_owner_idx" ON "assistant_conversations" USING btree ("owner_email","updated_at");