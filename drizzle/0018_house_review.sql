CREATE TABLE "finance_review_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"viewer" text NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"undo" jsonb NOT NULL,
	"status" text DEFAULT 'applied' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "finance_review_questions" (
	"transaction_id" uuid PRIMARY KEY NOT NULL,
	"viewer" text NOT NULL,
	"status" text NOT NULL,
	"answer" text,
	"suggestion" jsonb,
	"outcome" jsonb,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_review_state" (
	"viewer" text PRIMARY KEY NOT NULL,
	"large_threshold" numeric(14, 2) DEFAULT 500 NOT NULL,
	"category_proposal" jsonb,
	"house_audit_at" timestamp with time zone,
	"house_audit_note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"location" text,
	"installed_on" date,
	"cost" numeric(12, 2),
	"notes" text,
	"recall_checked_at" timestamp with time zone,
	"recalls" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date,
	"period" text,
	"title" text NOT NULL,
	"vendor" text,
	"description" text,
	"amount" numeric(12, 2),
	"amount_note" text,
	"transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "maintenance_tasks" ADD COLUMN "area" text;--> statement-breakpoint
ALTER TABLE "maintenance_tasks" ADD COLUMN "parts" text;--> statement-breakpoint
ALTER TABLE "maintenance_tasks" ADD COLUMN "last_done_on" date;--> statement-breakpoint
ALTER TABLE "finance_review_questions" ADD CONSTRAINT "finance_review_questions_transaction_id_finance_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."finance_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_review_actions_viewer_idx" ON "finance_review_actions" USING btree ("viewer","created_at");--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Pavel's house records (2026-11-25). Invoice, order and work-order numbers
-- and individuals' names are left out on purpose; add them in the app if needed.
-- Everything is inserted only when a row with the same title/name is absent.
-- ---------------------------------------------------------------------------
INSERT INTO "maintenance_projects" ("date", "period", "title", "vendor", "description", "amount", "amount_note")
SELECT v.d::date, v.p, v.t, v.vendor, v.descr, v.amt::numeric, v.note
FROM (VALUES
  (NULL, '2022 – 2023', 'Dishwasher replacement', NULL, 'Replaced the kitchen dishwasher.', NULL, 'Standard appliance'),
  (NULL, '2023 – 2024', 'Second-floor bathroom vanities', NULL, 'Replaced the bathroom cabinets and vanities in the second-floor bathroom.', NULL, 'Renovation'),
  ('2024-05-28', NULL, 'Architectural design & structural engineering', 'Basecamp Architects LLC', 'Schematic design, zoning documents and construction drawings ($8,300); subcontracted structural engineering ($2,300).', '10600', NULL),
  ('2024-09-23', NULL, 'Civil engineering & stormwater design', 'Doubleday Design, LLC / Urban Land Surveying LLC', 'Property survey, site engineering, stormwater seepage pit design.', '3600', NULL),
  ('2024-11-27', NULL, 'Permit drawing reproduction', 'Basecamp Architects', 'Printing 4 sets of sealed 24"x36" construction drawings for the township permit submission.', NULL, '~$600 – $800'),
  ('2024-12-01', NULL, 'House addition construction contract', 'Mullen Construction', '1-story addition (living room & office), demolition, crawl space, footings. Tamko lifetime roof, James Hardie lap siding, Wolf PVC deck, TimberTech railings. Viwinco windows, Therma-Tru doors, 200A electrical service panel. Baseboard heat zone, separate AC zone, drywall, hardwood & Schluter tile, painting. Seepage pit rainwater infiltration system.', '200000', NULL),
  ('2025-01-29', NULL, 'PECO gas line relocation', 'PECO Energy', 'Relocated about 80 ft of gas service line and the meter away from the addition footings.', '3966.74', NULL),
  ('2025-03-10', NULL, 'Sharp microwave repair', 'Steward Home Maintenance', 'Replaced the high-voltage capacitor and the magnetron.', '370.09', NULL),
  ('2025-06-16', NULL, 'Steel drop beam engineering', 'Jeffrey Harris RA', 'Structural calculation report for the W12x26 steel drop beam clear-span support.', NULL, 'Included in scope'),
  ('2025-09-22', NULL, 'Daniel''s ceiling refinishing', 'The Home Depot Rental', 'Drywall sander ($64) and dust vacuum ($32) rental to refinish the ceiling before repainting.', '117.03', NULL),
  ('2026-05-24', NULL, 'Garage upright freezer', 'The Home Depot Pro', 'GE Garage Ready 14.2 cu. ft. upright freezer ($599 + $39 delivery + tax).', '674.94', NULL),
  ('2026-08-28', NULL, 'HVAC & boiler annual service', 'Chud Cooling & Heating', '1-year club membership and system diagnostics.', '597', NULL),
  ('2026-10-01', 'Oct 2026', 'Front yard tree removal', 'Tree removal contractor', 'Removed 2 large pine trees in the front yard.', '8500', NULL)
) AS v(d, p, t, vendor, descr, amt, note)
WHERE NOT EXISTS (SELECT 1 FROM "maintenance_projects" m WHERE m."title" = v.t);--> statement-breakpoint
INSERT INTO "maintenance_assets" ("name", "kind", "location", "installed_on", "cost", "notes")
SELECT v.n, v.k, v.loc, v.d::date, v.c::numeric, v.notes
FROM (VALUES
  ('GE refrigerator', 'appliance', 'Kitchen', NULL, NULL, 'Water filter: GE MWF or compatible.'),
  ('APEC reverse osmosis system', 'plumbing', 'Kitchen', NULL, NULL, 'Pre-filters (ESX2 sediment + carbon), post-carbon filter, membrane.'),
  ('Boiler and baseboard heat', 'hvac', NULL, NULL, NULL, 'Baseboard loops; auto-fill valve due for replacement.'),
  ('Water heater', 'plumbing', NULL, NULL, NULL, NULL),
  ('Addition AC system', 'hvac', 'Attic', NULL, NULL, 'Separate AC zone for the addition. Spare coil in storage.'),
  ('Tamko lifetime roof', 'roof', NULL, NULL, NULL, 'Installed with the addition.'),
  ('James Hardie lap siding', 'exterior', NULL, NULL, NULL, 'Installed with the addition.'),
  ('Wolf PVC deck with TimberTech railings', 'exterior', NULL, NULL, NULL, 'Installed with the addition.'),
  ('Viwinco windows', 'exterior', 'Addition', NULL, NULL, NULL),
  ('Therma-Tru doors', 'exterior', 'Addition', NULL, NULL, NULL),
  ('200A electrical service panel', 'electrical', NULL, NULL, NULL, NULL),
  ('Stormwater seepage pit', 'yard', NULL, NULL, NULL, 'Rainwater infiltration system with cleanouts.'),
  ('GE Garage Ready upright freezer (14.2 cu. ft.)', 'appliance', 'Garage', '2026-05-24', '674.94', NULL),
  ('Sharp microwave', 'appliance', 'Kitchen', NULL, NULL, 'Capacitor and magnetron replaced March 2025.'),
  ('Dishwasher', 'appliance', 'Kitchen', NULL, NULL, 'Replaced 2022 – 2023.')
) AS v(n, k, loc, d, c, notes)
WHERE NOT EXISTS (SELECT 1 FROM "maintenance_assets" a WHERE a."name" = v.n);--> statement-breakpoint
-- An HVAC/AC filter task typed in by hand becomes the air-filter item instead of a second one.
UPDATE "maintenance_tasks" SET "title" = 'Replace HVAC air filters', "area" = 'HVAC & heating', "recurrence_days" = 30,
  "notes" = coalesce("notes" || ' ', '') || 'Every 1 to 3 months: inspect and replace quarterly, monthly during peak summer and winter use.'
WHERE "completed_on" IS NULL AND "title" ~* '(\mac\M|hvac|air).*filter|filter.*(\mac\M|hvac|air)';--> statement-breakpoint
INSERT INTO "maintenance_tasks" ("title", "area", "parts", "due_date", "recurrence_days", "last_done_on", "estimated_cost", "notes")
SELECT v.t, v.area, v.parts, v.due::date, v.days::int, v.last::date, v.cost::numeric, v.notes
FROM (VALUES
  ('Replace refrigerator water filter', 'Water filtration', 'GE MWF filter (or compatible)', '2026-12-01', '182', NULL, NULL, 'Twice a year, for clean ice and water and to prevent scale.'),
  ('Replace RO pre-filters', 'Water filtration', 'APEC ESX2 set: sediment and carbon block pre-filters', '2026-12-01', '182', NULL, NULL, 'Every 6 months; protects the RO membrane.'),
  ('Replace RO post-carbon filter', 'Water filtration', 'APEC post-carbon (taste and odor) filter', '2026-12-01', '365', NULL, NULL, 'Yearly, together with the pre-filters.'),
  ('Replace RO membrane', 'Water filtration', 'APEC reverse osmosis membrane', '2027-12-01', '913', NULL, NULL, 'Every 2 to 3 years, depending on water use and TDS readings.'),
  ('Replace HVAC air filters', 'HVAC & heating', 'HVAC air filters (note the size here)', '2026-12-01', '30', NULL, NULL, 'Every 1 to 3 months: inspect and replace quarterly, monthly during peak summer and winter use.'),
  ('Replace attic AC coil', 'HVAC & heating', 'Leftover coil from the box in storage', '2027-03-01', NULL, NULL, '1500', 'For the addition system, scheduled March 2027.'),
  ('Heating tune-up and boiler flush', 'HVAC & heating', NULL, '2027-09-15', '365', '2026-08-28', NULL, 'Every fall before heating season: bleed the baseboard loops, inspect the boiler and radiators.'),
  ('Replace boiler auto-fill valve; check water heater valves', 'HVAC & heating', 'Boiler auto-fill valve; water heater safety (T&P) valve if needed', '2026-11-25', NULL, NULL, NULL, 'As soon as convenient: the auto-fill is leaking.'),
  ('Clean gutters and downspouts', 'Exterior & stormwater', NULL, '2026-12-01', '182', NULL, NULL, 'Twice a year: late spring after seeds and pollen drop, late fall after leaves drop.'),
  ('Inspect stormwater seepage pit and cleanouts', 'Exterior & stormwater', NULL, '2026-12-15', '365', NULL, NULL, 'Yearly in the fall, or after heavy spring storms: make sure the cleanouts drain clear.'),
  ('Roof and siding inspection', 'Exterior & stormwater', NULL, '2027-04-15', '365', NULL, NULL, 'Yearly walkaround: Tamko shingles, flashing, James Hardie siding.')
) AS v(t, area, parts, due, days, last, cost, notes)
WHERE NOT EXISTS (SELECT 1 FROM "maintenance_tasks" m WHERE m."completed_on" IS NULL AND m."title" = v.t);--> statement-breakpoint
-- Calendar entries and expected costs, as the app would add them for new tasks.
INSERT INTO "calendar_events" ("title", "start_date", "source_module", "source_ref")
SELECT 'Maintenance: ' || t."title", t."due_date", 'maintenance', t."id"::text
FROM "maintenance_tasks" t WHERE t."completed_on" IS NULL
ON CONFLICT ("source_module", "source_ref") DO NOTHING;--> statement-breakpoint
INSERT INTO "finance_expected_expenses" ("title", "date", "amount", "category", "source_module", "source_ref")
SELECT t."title", t."due_date", t."estimated_cost", 'Home Maintenance', 'maintenance', t."id"::text
FROM "maintenance_tasks" t WHERE t."completed_on" IS NULL AND t."estimated_cost" IS NOT NULL
ON CONFLICT ("source_module", "source_ref") DO NOTHING;
