CREATE TABLE "core_push_sent" (
	"member" text NOT NULL,
	"key" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_push_sent_member_key_pk" PRIMARY KEY("member","key")
);
--> statement-breakpoint
CREATE TABLE "core_push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_ok_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "core_push_sent_at_idx" ON "core_push_sent" USING btree ("sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "core_push_subscriptions_endpoint_uq" ON "core_push_subscriptions" USING btree ("endpoint");