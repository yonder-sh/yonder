CREATE TYPE "public"."idea_status" AS ENUM('idea', 'shortlist', 'dropped');--> statement-breakpoint
CREATE TYPE "public"."shortlist_pin" AS ENUM('auto', 'pinned', 'unpinned');--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "idea_status" "idea_status" DEFAULT 'idea' NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "shortlist_pin" "shortlist_pin" DEFAULT 'auto' NOT NULL;--> statement-breakpoint
-- docs/PLACES.md §3: places already dropped keep that decision.
UPDATE "nodes" SET "idea_status" = 'dropped' WHERE "status" = 'dropped';
