CREATE TABLE "trips_allergy_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"destination_id" uuid NOT NULL,
	"traveler_id" uuid NOT NULL,
	"language" text NOT NULL,
	"language_name" text NOT NULL,
	"body" text NOT NULL,
	"english_body" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"name" text NOT NULL,
	"country" text,
	"country_code" text,
	"languages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"timezone" text,
	"latitude" double precision,
	"longitude" double precision,
	"arrive_on" date,
	"depart_on" date,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips_dining_places" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"destination_id" uuid,
	"name" text NOT NULL,
	"cuisine" text,
	"address" text,
	"latitude" double precision,
	"longitude" double precision,
	"phone" text,
	"website" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_ref" text,
	"fmgf_url" text,
	"gf_status" text DEFAULT 'unknown' NOT NULL,
	"dedicated_fryer" boolean,
	"celiac_friendly" boolean,
	"visited" boolean DEFAULT false NOT NULL,
	"favorite" boolean DEFAULT false NOT NULL,
	"our_rating" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid,
	"itinerary_item_id" uuid,
	"traveler_id" uuid,
	"uploaded_by" text,
	"kind" text DEFAULT 'other' NOT NULL,
	"title" text NOT NULL,
	"filename" text,
	"mime_type" text,
	"size_bytes" integer,
	"cipher_text" "bytea",
	"iv" "bytea",
	"auth_tag" "bytea",
	"document_number_last4" text,
	"expires_on" date,
	"issuing_country" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips_emergency_info" (
	"destination_id" uuid PRIMARY KEY NOT NULL,
	"emergency_number" text,
	"hospitals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pharmacies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"embassies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gf_groceries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips_hunt_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"traveler_id" uuid NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips_hunt_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hunt_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"hint" text,
	"points" integer DEFAULT 10 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips_hunts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"destination_id" uuid,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips_itinerary_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"destination_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"timezone" text,
	"end_timezone" text,
	"all_day" boolean DEFAULT false NOT NULL,
	"location" text,
	"address" text,
	"confirmation" text,
	"url" text,
	"notes" text,
	"booking_status" text DEFAULT 'idea' NOT NULL,
	"provider" text,
	"booking_url" text,
	"booking_opens_on" date,
	"verify_by" date,
	"verified_at" timestamp with time zone,
	"verified_note" text,
	"seat_note" text,
	"gf_vetted" boolean DEFAULT false NOT NULL,
	"cost" numeric(12, 2),
	"paid_with_account_id" uuid,
	"charge_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips_packing_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"traveler_id" uuid,
	"name" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"packed" boolean DEFAULT false NOT NULL,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips_packing_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"template_id" uuid,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips_packing_template_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"per_person" boolean DEFAULT true NOT NULL,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips_packing_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips_quiz_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quiz_id" uuid NOT NULL,
	"traveler_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"total_points" integer NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips_quiz_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quiz_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"choices" jsonb NOT NULL,
	"answer_index" integer NOT NULL,
	"explanation" text,
	"points" integer DEFAULT 10 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips_quizzes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"destination_id" uuid NOT NULL,
	"title" text NOT NULL,
	"min_age" integer DEFAULT 6 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips_travelers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'adult' NOT NULL,
	"birthdate" date,
	"owner" text,
	"color" text DEFAULT 'sky' NOT NULL,
	"celiac" boolean DEFAULT false NOT NULL,
	"gluten_free" boolean DEFAULT false NOT NULL,
	"cross_contact_strict" boolean DEFAULT true NOT NULL,
	"other_allergens" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"diet_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips_trivia_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"destination_id" uuid NOT NULL,
	"text" text NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"kid_friendly" boolean DEFAULT false NOT NULL,
	"source_name" text,
	"source_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finance_card_profiles" ADD COLUMN "signup_bonus" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "finance_card_profiles" ADD COLUMN "signup_min_spend" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "finance_card_profiles" ADD COLUMN "signup_start" date;--> statement-breakpoint
ALTER TABLE "finance_card_profiles" ADD COLUMN "signup_deadline" date;--> statement-breakpoint
ALTER TABLE "trips_trips" ADD COLUMN "slug" text;--> statement-breakpoint
-- Trips created by the scaffold have no slug; give them their id.
UPDATE "trips_trips" SET "slug" = "id"::text WHERE "slug" IS NULL;--> statement-breakpoint
ALTER TABLE "trips_trips" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "trips_trips" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "trips_trips" ADD COLUMN "archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "trips_allergy_cards" ADD CONSTRAINT "trips_allergy_cards_destination_id_trips_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."trips_destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_allergy_cards" ADD CONSTRAINT "trips_allergy_cards_traveler_id_trips_travelers_id_fk" FOREIGN KEY ("traveler_id") REFERENCES "public"."trips_travelers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_destinations" ADD CONSTRAINT "trips_destinations_trip_id_trips_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips_trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_dining_places" ADD CONSTRAINT "trips_dining_places_destination_id_trips_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."trips_destinations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_documents" ADD CONSTRAINT "trips_documents_trip_id_trips_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips_trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_documents" ADD CONSTRAINT "trips_documents_itinerary_item_id_trips_itinerary_items_id_fk" FOREIGN KEY ("itinerary_item_id") REFERENCES "public"."trips_itinerary_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_documents" ADD CONSTRAINT "trips_documents_traveler_id_trips_travelers_id_fk" FOREIGN KEY ("traveler_id") REFERENCES "public"."trips_travelers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_emergency_info" ADD CONSTRAINT "trips_emergency_info_destination_id_trips_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."trips_destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_hunt_completions" ADD CONSTRAINT "trips_hunt_completions_task_id_trips_hunt_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."trips_hunt_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_hunt_completions" ADD CONSTRAINT "trips_hunt_completions_traveler_id_trips_travelers_id_fk" FOREIGN KEY ("traveler_id") REFERENCES "public"."trips_travelers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_hunt_tasks" ADD CONSTRAINT "trips_hunt_tasks_hunt_id_trips_hunts_id_fk" FOREIGN KEY ("hunt_id") REFERENCES "public"."trips_hunts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_hunts" ADD CONSTRAINT "trips_hunts_trip_id_trips_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips_trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_hunts" ADD CONSTRAINT "trips_hunts_destination_id_trips_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."trips_destinations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_itinerary_items" ADD CONSTRAINT "trips_itinerary_items_trip_id_trips_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips_trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_itinerary_items" ADD CONSTRAINT "trips_itinerary_items_destination_id_trips_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."trips_destinations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_packing_items" ADD CONSTRAINT "trips_packing_items_list_id_trips_packing_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."trips_packing_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_packing_items" ADD CONSTRAINT "trips_packing_items_traveler_id_trips_travelers_id_fk" FOREIGN KEY ("traveler_id") REFERENCES "public"."trips_travelers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_packing_lists" ADD CONSTRAINT "trips_packing_lists_trip_id_trips_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips_trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_packing_lists" ADD CONSTRAINT "trips_packing_lists_template_id_trips_packing_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."trips_packing_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_packing_template_items" ADD CONSTRAINT "trips_packing_template_items_template_id_trips_packing_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."trips_packing_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_quiz_attempts" ADD CONSTRAINT "trips_quiz_attempts_quiz_id_trips_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."trips_quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_quiz_attempts" ADD CONSTRAINT "trips_quiz_attempts_traveler_id_trips_travelers_id_fk" FOREIGN KEY ("traveler_id") REFERENCES "public"."trips_travelers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_quiz_questions" ADD CONSTRAINT "trips_quiz_questions_quiz_id_trips_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."trips_quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_quizzes" ADD CONSTRAINT "trips_quizzes_destination_id_trips_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."trips_destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips_trivia_facts" ADD CONSTRAINT "trips_trivia_facts_destination_id_trips_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."trips_destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trips_allergy_cards_uq" ON "trips_allergy_cards" USING btree ("destination_id","language","traveler_id");--> statement-breakpoint
CREATE INDEX "trips_destinations_trip_idx" ON "trips_destinations" USING btree ("trip_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "trips_dining_source_uq" ON "trips_dining_places" USING btree ("source","source_ref");--> statement-breakpoint
CREATE INDEX "trips_documents_trip_idx" ON "trips_documents" USING btree ("trip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trips_hunt_completions_uq" ON "trips_hunt_completions" USING btree ("task_id","traveler_id");--> statement-breakpoint
CREATE INDEX "trips_itinerary_trip_idx" ON "trips_itinerary_items" USING btree ("trip_id","starts_at");--> statement-breakpoint
CREATE INDEX "trips_itinerary_status_idx" ON "trips_itinerary_items" USING btree ("trip_id","booking_status");--> statement-breakpoint
CREATE UNIQUE INDEX "trips_packing_templates_name_uq" ON "trips_packing_templates" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "trips_trips_slug_uq" ON "trips_trips" USING btree ("slug");