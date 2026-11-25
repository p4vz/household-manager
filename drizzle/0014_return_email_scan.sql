CREATE TABLE "family_mail_connect_states" (
	"state" text PRIMARY KEY NOT NULL,
	"member" text NOT NULL,
	"verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "family_mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member" text NOT NULL,
	"address_sealed" text NOT NULL,
	"address_hash" text NOT NULL,
	"refresh_token_sealed" text NOT NULL,
	"include_spam" boolean DEFAULT true NOT NULL,
	"last_scan_at" timestamp with time zone,
	"last_scan_ok" boolean,
	"last_scan_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "family_return_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"member" text NOT NULL,
	"message_id" text NOT NULL,
	"status" text NOT NULL,
	"kind" text,
	"item_name" text,
	"store" text,
	"return_deadline" date,
	"notes" text,
	"match_return_id" uuid,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "family_return_suggestions" ADD CONSTRAINT "family_return_suggestions_mailbox_id_family_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."family_mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_return_suggestions" ADD CONSTRAINT "family_return_suggestions_match_return_id_family_purchase_returns_id_fk" FOREIGN KEY ("match_return_id") REFERENCES "public"."family_purchase_returns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "family_mailboxes_member_address_idx" ON "family_mailboxes" USING btree ("member","address_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "family_return_suggestions_msg_idx" ON "family_return_suggestions" USING btree ("mailbox_id","message_id");--> statement-breakpoint
CREATE INDEX "family_return_suggestions_member_idx" ON "family_return_suggestions" USING btree ("member","status");