CREATE TABLE "core_oauth_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core_oauth_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"email" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"scope" text NOT NULL,
	"resource" text NOT NULL,
	"code_challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "core_oauth_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"email" text NOT NULL,
	"scope" text NOT NULL,
	"resource" text NOT NULL,
	"access_hash" text NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"refresh_hash" text NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "core_oauth_codes" ADD CONSTRAINT "core_oauth_codes_client_id_core_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."core_oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_oauth_grants" ADD CONSTRAINT "core_oauth_grants_client_id_core_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."core_oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "core_oauth_codes_expires_idx" ON "core_oauth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "core_oauth_grants_access_uq" ON "core_oauth_grants" USING btree ("access_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "core_oauth_grants_refresh_uq" ON "core_oauth_grants" USING btree ("refresh_hash");