CREATE TABLE "family_shopping_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"deferred_until" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "family_shopping_revision" (
	"id" integer PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "family_shopping_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"store" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "family_shopping_template_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"store" text NOT NULL,
	"store_order" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"quantity" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "family_shopping_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "family_shopping_items" ALTER COLUMN "store" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "family_shopping_items" ADD COLUMN "section_id" uuid;--> statement-breakpoint
ALTER TABLE "family_shopping_items" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "family_shopping_sections" ADD CONSTRAINT "family_shopping_sections_list_id_family_shopping_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."family_shopping_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_shopping_template_items" ADD CONSTRAINT "family_shopping_template_items_template_id_family_shopping_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."family_shopping_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "family_shopping_sections_uq" ON "family_shopping_sections" USING btree ("list_id","store");--> statement-breakpoint
CREATE INDEX "family_shopping_template_items_tpl_idx" ON "family_shopping_template_items" USING btree ("template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "family_shopping_templates_name_uq" ON "family_shopping_templates" USING btree ("name");--> statement-breakpoint
ALTER TABLE "family_shopping_items" ADD CONSTRAINT "family_shopping_items_section_id_family_shopping_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."family_shopping_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "family_shopping_items_section_idx" ON "family_shopping_items" USING btree ("section_id");
--> statement-breakpoint
INSERT INTO "family_shopping_revision" ("id", "revision") VALUES (1, 0);--> statement-breakpoint
-- Existing items move to one list ("Shopping"), one section per store they used.
INSERT INTO "family_shopping_lists" ("name", "sort_order")
  SELECT 'Shopping', 0 WHERE EXISTS (SELECT 1 FROM "family_shopping_items");--> statement-breakpoint
INSERT INTO "family_shopping_sections" ("list_id", "store", "sort_order")
  SELECT l."id", s."store", (row_number() OVER (ORDER BY s."store"))::int - 1
  FROM (SELECT DISTINCT "store" FROM "family_shopping_items") s
  CROSS JOIN (SELECT "id" FROM "family_shopping_lists" WHERE "name" = 'Shopping' LIMIT 1) l;--> statement-breakpoint
UPDATE "family_shopping_items" i SET
  "section_id" = sec."id",
  "sort_order" = ord.n
  FROM "family_shopping_sections" sec,
    (SELECT "id", (row_number() OVER (PARTITION BY "store" ORDER BY "created_at"))::int - 1 AS n FROM "family_shopping_items") ord
  WHERE sec."store" = i."store" AND ord."id" = i."id";--> statement-breakpoint
-- The old default staples become a template, so "Restock staples" turns into "start a list from Staples".
INSERT INTO "family_shopping_templates" ("name")
  SELECT 'Staples' WHERE EXISTS (SELECT 1 FROM "family_shopping_items" WHERE "is_staple");--> statement-breakpoint
INSERT INTO "family_shopping_template_items" ("template_id", "store", "store_order", "name", "quantity", "sort_order")
  SELECT t."id", i."store", (dense_rank() OVER (ORDER BY i."store"))::int - 1, i."name", i."quantity",
    (row_number() OVER (PARTITION BY i."store" ORDER BY i."created_at"))::int - 1
  FROM "family_shopping_items" i
  CROSS JOIN (SELECT "id" FROM "family_shopping_templates" WHERE "name" = 'Staples') t
  WHERE i."is_staple";--> statement-breakpoint
-- Starter templates.
INSERT INTO "family_shopping_templates" ("name", "created_at") VALUES ('Weekly Sam''s', now()), ('Weekly Russian', now() + interval '1 millisecond');--> statement-breakpoint
INSERT INTO "family_shopping_template_items" ("template_id", "store", "store_order", "name", "sort_order")
  SELECT t."id", 'Sam''s Club', 0, v.name, v.n
  FROM "family_shopping_templates" t,
    (VALUES ('Milk', 0), ('Eggs', 1), ('Yogurt', 2), ('Berries', 3), ('Fruits', 4)) AS v(name, n)
  WHERE t."name" = 'Weekly Sam''s';--> statement-breakpoint
INSERT INTO "family_shopping_template_items" ("template_id", "store", "store_order", "name", "sort_order")
  SELECT t."id", 'Russian store', 0, v.name, v.n
  FROM "family_shopping_templates" t,
    (VALUES ('Tvorog', 0), ('Snacks', 1), ('Eggs', 2)) AS v(name, n)
  WHERE t."name" = 'Weekly Russian';
