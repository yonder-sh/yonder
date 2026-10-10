-- Saved (owner, 2026-10-09): shared links kept on the account until they go into a
-- trip; the Shortcut's pending links move here (0026 drops their old table).
CREATE TABLE "saved_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text,
	"url" text,
	"text" text,
	"title" text,
	"provider" text,
	"embed_id" text,
	"ig_type" text,
	"preview_status" text DEFAULT 'pending' NOT NULL,
	"preview_title" text,
	"description" text,
	"author" text,
	"site_name" text,
	"image_key" text,
	"image_w" integer,
	"image_h" integer,
	"thumbhash" text,
	"favicon_key" text,
	"place" jsonb,
	"added_trip_id" uuid,
	"added_node_id" uuid,
	"added_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_links_size_ck" CHECK (char_length(coalesce("saved_links"."url", '')) <= 2000 and char_length(coalesce("saved_links"."text", '')) <= 2000 and char_length(coalesce("saved_links"."title", '')) <= 300),
	CONSTRAINT "saved_links_status_ck" CHECK ("saved_links"."preview_status" in ('pending', 'ready', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "saved_links" ADD CONSTRAINT "saved_links_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_links" ADD CONSTRAINT "saved_links_added_trip_id_trips_id_fk" FOREIGN KEY ("added_trip_id") REFERENCES "public"."trips"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_links_user_idx" ON "saved_links" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_links_client_uq" ON "saved_links" USING btree ("user_id","client_id");--> statement-breakpoint
-- Nothing the Shortcut sent is lost: its waiting links become saved ones.
INSERT INTO "saved_links" ("id", "user_id", "url", "text", "created_at", "updated_at")
SELECT "id", "user_id", "url", "text", "created_at", "created_at" FROM "shortcut_shares";
