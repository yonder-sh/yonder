-- Saved: photos and videos in it (saved_files), and one waiting row per link (link_key).
CREATE TABLE "saved_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"saved_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"width" integer,
	"height" integer,
	"duration_sec" double precision,
	"thumbhash" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_files_status_ck" CHECK ("saved_files"."status" in ('pending', 'processing', 'ready', 'failed')),
	CONSTRAINT "saved_files_kind_ck" CHECK ("saved_files"."kind" in ('photo', 'video'))
);
--> statement-breakpoint
ALTER TABLE "saved_links" ADD COLUMN "link_key" text;--> statement-breakpoint
ALTER TABLE "saved_files" ADD CONSTRAINT "saved_files_saved_id_saved_links_id_fk" FOREIGN KEY ("saved_id") REFERENCES "public"."saved_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_files" ADD CONSTRAINT "saved_files_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_files_user_idx" ON "saved_files" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_files_position_uq" ON "saved_files" USING btree ("saved_id","position");--> statement-breakpoint
-- Links already waiting keep their address as the key (the newest of any twins).
UPDATE "saved_links" s SET "link_key" = s."url"
 WHERE s."url" IS NOT NULL AND s."deleted_at" IS NULL AND s."added_at" IS NULL
   AND s."id" = (SELECT max(o."id"::text)::uuid FROM "saved_links" o
                  WHERE o."user_id" = s."user_id" AND o."url" = s."url"
                    AND o."deleted_at" IS NULL AND o."added_at" IS NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "saved_links_waiting_link_uq" ON "saved_links" USING btree ("user_id","link_key") WHERE "saved_links"."deleted_at" is null and "saved_links"."added_at" is null;