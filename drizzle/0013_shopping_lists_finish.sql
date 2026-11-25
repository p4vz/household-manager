DROP INDEX "family_shopping_items_store_idx";--> statement-breakpoint
ALTER TABLE "family_shopping_items" ALTER COLUMN "section_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "family_shopping_items" DROP COLUMN "store";--> statement-breakpoint
ALTER TABLE "family_shopping_items" DROP COLUMN "is_staple";