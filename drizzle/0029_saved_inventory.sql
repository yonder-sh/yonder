-- Saved becomes an inventory: where each item is (country, city), the trips it
-- went into (it stays), saved from a trip's gallery; one live row per link.
CREATE TABLE "saved_link_trips" (
	"saved_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"node_id" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_link_trips_saved_id_trip_id_pk" PRIMARY KEY("saved_id","trip_id")
);
--> statement-breakpoint
ALTER TABLE "saved_links" ADD COLUMN "country_code" text;--> statement-breakpoint
ALTER TABLE "saved_links" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "saved_links" ADD COLUMN "city_key" text;--> statement-breakpoint
ALTER TABLE "saved_links" ADD COLUMN "city_lat" double precision;--> statement-breakpoint
ALTER TABLE "saved_links" ADD COLUMN "city_lng" double precision;--> statement-breakpoint
ALTER TABLE "saved_links" ADD COLUMN "placed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "saved_links" ADD COLUMN "from_attachment_id" uuid;--> statement-breakpoint
ALTER TABLE "saved_link_trips" ADD CONSTRAINT "saved_link_trips_saved_id_saved_links_id_fk" FOREIGN KEY ("saved_id") REFERENCES "public"."saved_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_link_trips" ADD CONSTRAINT "saved_link_trips_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_link_trips_trip_idx" ON "saved_link_trips" USING btree ("trip_id");--> statement-breakpoint
-- Added ones stay in Saved now: where they went moves to saved_link_trips.
INSERT INTO "saved_link_trips" ("saved_id", "trip_id", "node_id", "added_at")
SELECT "id", "added_trip_id", "added_node_id", coalesce("added_at", now()) FROM "saved_links"
 WHERE "added_trip_id" IS NOT NULL;--> statement-breakpoint
-- One live row per link: twins (one waiting, some added) fold into the newest.
WITH "twins" AS (
	SELECT s."id" AS "old_id", k."id" AS "keep_id" FROM "saved_links" s
	  JOIN LATERAL (SELECT o."id" FROM "saved_links" o
	                 WHERE o."user_id" = s."user_id" AND o."link_key" = s."link_key" AND o."deleted_at" IS NULL
	                 ORDER BY o."created_at" DESC, o."id" DESC LIMIT 1) k ON true
	 WHERE s."link_key" IS NOT NULL AND s."deleted_at" IS NULL AND k."id" <> s."id")
INSERT INTO "saved_link_trips" ("saved_id", "trip_id", "node_id", "added_at")
SELECT t."keep_id", l."trip_id", l."node_id", l."added_at" FROM "twins" t
  JOIN "saved_link_trips" l ON l."saved_id" = t."old_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
WITH "twins" AS (
	SELECT s."id" AS "old_id", k."id" AS "keep_id" FROM "saved_links" s
	  JOIN LATERAL (SELECT o."id" FROM "saved_links" o
	                 WHERE o."user_id" = s."user_id" AND o."link_key" = s."link_key" AND o."deleted_at" IS NULL
	                 ORDER BY o."created_at" DESC, o."id" DESC LIMIT 1) k ON true
	 WHERE s."link_key" IS NOT NULL AND s."deleted_at" IS NULL AND k."id" <> s."id")
UPDATE "saved_links" SET "deleted_at" = now(), "updated_at" = now()
 WHERE "id" IN (SELECT "old_id" FROM "twins");--> statement-breakpoint
ALTER TABLE "saved_links" DROP CONSTRAINT "saved_links_added_trip_id_trips_id_fk";
--> statement-breakpoint
DROP INDEX "saved_links_waiting_link_uq";--> statement-breakpoint
ALTER TABLE "saved_links" DROP COLUMN "added_trip_id";--> statement-breakpoint
ALTER TABLE "saved_links" DROP COLUMN "added_node_id";--> statement-breakpoint
ALTER TABLE "saved_links" DROP COLUMN "added_at";--> statement-breakpoint
CREATE UNIQUE INDEX "saved_links_link_uq" ON "saved_links" USING btree ("user_id","link_key") WHERE "saved_links"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_links_from_attachment_uq" ON "saved_links" USING btree ("user_id","from_attachment_id") WHERE "saved_links"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "saved_links" ADD CONSTRAINT "saved_links_where_ck" CHECK (("saved_links"."country_code" is null or "saved_links"."country_code" ~ '^[A-Z]{2}$') and ("saved_links"."city" is null or ("saved_links"."country_code" is not null and "saved_links"."city_key" is not null and char_length("saved_links"."city") <= 120)));