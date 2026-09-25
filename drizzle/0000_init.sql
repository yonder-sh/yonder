CREATE TYPE "public"."attachment_kind" AS ENUM('photo', 'video', 'embed', 'link');--> statement-breakpoint
CREATE TYPE "public"."attachment_status" AS ENUM('pending', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."leg_kind" AS ENUM('pair', 'stay_start', 'stay_end');--> statement-breakpoint
CREATE TYPE "public"."leg_mode" AS ENUM('walk', 'transit', 'flight', 'other');--> statement-breakpoint
CREATE TYPE "public"."leg_source" AS ENUM('manual', 'google', 'osrm', 'navitime', 'estimate');--> statement-breakpoint
CREATE TYPE "public"."list_item_status" AS ENUM('open', 'done', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."list_kind" AS ENUM('todo', 'shopping');--> statement-breakpoint
CREATE TYPE "public"."member_status" AS ENUM('active', 'invited', 'placeholder');--> statement-breakpoint
CREATE TYPE "public"."node_status" AS ENUM('active', 'dropped');--> statement-breakpoint
CREATE TYPE "public"."node_type" AS ENUM('country', 'region', 'city', 'area', 'place');--> statement-breakpoint
CREATE TYPE "public"."place_category" AS ENUM('sight', 'temple_shrine', 'museum', 'viewpoint', 'nature', 'park', 'beach', 'onsen', 'food_drink', 'restaurant', 'cafe', 'market', 'bar', 'nightlife', 'shopping', 'activity', 'event', 'lodging', 'station', 'airport', 'port', 'other');--> statement-breakpoint
CREATE TYPE "public"."priority_level" AS ENUM('must', 'really_want', 'want', 'sure_why_not', 'meh', 'nah');--> statement-breakpoint
CREATE TYPE "public"."share_role" AS ENUM('editor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."trip_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"is_anonymous" boolean DEFAULT false,
	"first_name" text DEFAULT '',
	"last_name" text DEFAULT '',
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"node_id" uuid,
	"leg_id" uuid,
	"item_id" uuid,
	"day_id" uuid,
	"kind" "attachment_kind" NOT NULL,
	"status" "attachment_status" DEFAULT 'ready' NOT NULL,
	"storage_key" text,
	"mime" text,
	"size_bytes" bigint,
	"width" integer,
	"height" integer,
	"duration_sec" real,
	"thumbhash" text,
	"taken_at" timestamp with time zone,
	"url" text,
	"provider" text,
	"embed_id" text,
	"title" text,
	"description" text,
	"site_name" text,
	"author" text,
	"favicon_url" text,
	"favicon_key" text,
	"image_key" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"caption" text,
	"position" text COLLATE "C" NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "attachments_trip_id_id_uq" UNIQUE("trip_id","id"),
	CONSTRAINT "attachments_target_ck" CHECK (num_nonnulls("attachments"."node_id", "attachments"."leg_id", "attachments"."item_id", "attachments"."day_id") <= 1),
	CONSTRAINT "attachments_url_ck" CHECK ("attachments"."url" is null or "attachments"."url" ~* '^https?://'),
	CONSTRAINT "attachments_size_ck" CHECK (("attachments"."size_bytes" is null or "attachments"."size_bytes" >= 0)
			and ("attachments"."width" is null or "attachments"."width" > 0)
			and ("attachments"."height" is null or "attachments"."height" > 0)
			and ("attachments"."duration_sec" is null or "attachments"."duration_sec" >= 0))
);
--> statement-breakpoint
CREATE TABLE "list_item_assignees" (
	"trip_id" uuid NOT NULL,
	"list_item_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	CONSTRAINT "list_item_assignees_list_item_id_member_id_pk" PRIMARY KEY("list_item_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "list_item_targets" (
	"trip_id" uuid NOT NULL,
	"list_item_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	CONSTRAINT "list_item_targets_list_item_id_node_id_pk" PRIMARY KEY("list_item_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "list_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"node_id" uuid,
	"leg_id" uuid,
	"item_id" uuid,
	"day_id" uuid,
	"list" "list_kind" NOT NULL,
	"text" text NOT NULL,
	"note" text,
	"url" text,
	"status" "list_item_status" DEFAULT 'open' NOT NULL,
	"done_at" timestamp with time zone,
	"done_by" text,
	"due_day_id" uuid,
	"due_date" date,
	"due_time" text,
	"due_tz" text,
	"quantity" integer,
	"price_amount" numeric(14, 2),
	"price_currency" text,
	"price_text" text,
	"position" text COLLATE "C" NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "list_items_trip_id_id_uq" UNIQUE("trip_id","id"),
	CONSTRAINT "list_items_target_ck" CHECK (num_nonnulls("list_items"."node_id", "list_items"."leg_id", "list_items"."item_id", "list_items"."day_id") <= 1),
	CONSTRAINT "list_items_due_time_ck" CHECK ("list_items"."due_time" is null or "list_items"."due_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "list_items_due_tz_ck" CHECK (("list_items"."due_time" is null) or ("list_items"."due_tz" is not null)),
	CONSTRAINT "list_items_url_ck" CHECK ("list_items"."url" is null or "list_items"."url" ~* '^https?://'),
	CONSTRAINT "list_items_quantity_ck" CHECK ("list_items"."quantity" is null or "list_items"."quantity" > 0),
	CONSTRAINT "list_items_currency_ck" CHECK ("list_items"."price_currency" is null or char_length("list_items"."price_currency") = 3)
);
--> statement-breakpoint
CREATE TABLE "mentions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"doc_name" text,
	"list_item_id" uuid,
	"note_item_id" uuid,
	"node_id" uuid,
	"leg_id" uuid,
	"item_id" uuid,
	"day_id" uuid,
	"excerpt" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "mentions_source_ck" CHECK (num_nonnulls("mentions"."doc_name", "mentions"."list_item_id", "mentions"."note_item_id") = 1),
	CONSTRAINT "mentions_doc_trip_ck" CHECK ("mentions"."doc_name" is null or "mentions"."doc_name" like 'trip/' || "mentions"."trip_id"::text || '/%')
);
--> statement-breakpoint
CREATE TABLE "yjs_documents" (
	"name" text PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"node_id" uuid,
	"leg_id" uuid,
	"item_id" uuid,
	"day_id" uuid,
	"state" "bytea" NOT NULL,
	"json" jsonb,
	"markdown" text,
	"plain_text" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "yjs_documents_target_ck" CHECK (num_nonnulls("yjs_documents"."node_id", "yjs_documents"."leg_id", "yjs_documents"."item_id", "yjs_documents"."day_id") <= 1),
	CONSTRAINT "yjs_documents_name_ck" CHECK ("yjs_documents"."name" = 'trip/' || "yjs_documents"."trip_id"::text || case
				when "yjs_documents"."node_id" is not null then '/node/' || "yjs_documents"."node_id"::text
				when "yjs_documents"."leg_id" is not null then '/leg/' || "yjs_documents"."leg_id"::text
				when "yjs_documents"."item_id" is not null then '/item/' || "yjs_documents"."item_id"::text
				when "yjs_documents"."day_id" is not null then '/day/' || "yjs_documents"."day_id"::text
				else '/root' end)
);
--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"actor_user_id" text,
	"actor_name" text NOT NULL,
	"verb" text NOT NULL,
	"node_id" uuid,
	"item_id" uuid,
	"leg_id" uuid,
	"day_id" uuid,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_priorities" (
	"trip_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"priority" "priority_level" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_priorities_node_id_member_id_pk" PRIMARY KEY("node_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"parent_id" uuid,
	"type" "node_type" NOT NULL,
	"category" "place_category",
	"status" "node_status" DEFAULT 'active' NOT NULL,
	"name" text NOT NULL,
	"local_name" text,
	"slug" text NOT NULL,
	"description" text,
	"position" text COLLATE "C" NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"tz" text,
	"country_code" text,
	"address" text,
	"google_place_id" text,
	"osm_ref" text,
	"bbox" jsonb,
	"time_needed_min" integer,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "nodes_trip_id_id_uq" UNIQUE("trip_id","id"),
	CONSTRAINT "nodes_category_ck" CHECK ("nodes"."category" is null or "nodes"."type" = 'place'),
	CONSTRAINT "nodes_latlng_ck" CHECK (("nodes"."lat" is null) = ("nodes"."lng" is null)),
	CONSTRAINT "nodes_latlng_range_ck" CHECK ("nodes"."lat" is null or ("nodes"."lat" between -90 and 90 and "nodes"."lng" between -180 and 180)),
	CONSTRAINT "nodes_country_code_ck" CHECK ("nodes"."country_code" is null or "nodes"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "nodes_time_needed_ck" CHECK ("nodes"."time_needed_min" is null or "nodes"."time_needed_min" between 0 and 4320)
);
--> statement-breakpoint
CREATE TABLE "item_assignees" (
	"trip_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	CONSTRAINT "item_assignees_item_id_member_id_pk" PRIMARY KEY("item_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"day_id" uuid,
	"node_id" uuid,
	"title" text,
	"note" text,
	"position" text COLLATE "C" NOT NULL,
	"duration_min" integer DEFAULT 60 NOT NULL,
	"pinned_start" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "items_trip_id_id_uq" UNIQUE("trip_id","id"),
	CONSTRAINT "items_located_or_titled_ck" CHECK ("items"."node_id" is not null or "items"."title" is not null),
	CONSTRAINT "items_duration_ck" CHECK ("items"."duration_min" between 0 and 4320),
	CONSTRAINT "items_pinned_ck" CHECK ("items"."pinned_start" is null or "items"."pinned_start" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
--> statement-breakpoint
CREATE TABLE "leg_assignees" (
	"trip_id" uuid NOT NULL,
	"leg_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	CONSTRAINT "leg_assignees_leg_id_member_id_pk" PRIMARY KEY("leg_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "legs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"kind" "leg_kind" DEFAULT 'pair' NOT NULL,
	"from_item_id" uuid,
	"to_item_id" uuid,
	"stay_day_id" uuid,
	"anchor_item_id" uuid,
	"mode" "leg_mode",
	"duration_min" integer,
	"distance_m" integer,
	"source" "leg_source" DEFAULT 'manual' NOT NULL,
	"estimate_min" integer,
	"is_edited" boolean DEFAULT false NOT NULL,
	"dep_at" timestamp with time zone,
	"arr_at" timestamp with time zone,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"alternatives" jsonb,
	"queried_for" timestamp with time zone,
	"queried_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legs_trip_id_id_uq" UNIQUE("trip_id","id"),
	CONSTRAINT "legs_shape_ck" CHECK (("legs"."kind" = 'pair' and "legs"."from_item_id" is not null and "legs"."to_item_id" is not null
				and "legs"."stay_day_id" is null and "legs"."from_item_id" <> "legs"."to_item_id")
			or ("legs"."kind" <> 'pair' and "legs"."from_item_id" is null and "legs"."to_item_id" is null and "legs"."stay_day_id" is not null)),
	CONSTRAINT "legs_flight_ck" CHECK ("legs"."mode" is distinct from 'flight' or ("legs"."kind" = 'pair' and "legs"."dep_at" is not null and "legs"."arr_at" is not null)),
	CONSTRAINT "legs_timed_order_ck" CHECK ("legs"."dep_at" is null or "legs"."arr_at" is null or "legs"."arr_at" > "legs"."dep_at"),
	CONSTRAINT "legs_minutes_ck" CHECK (("legs"."duration_min" is null or "legs"."duration_min" >= 0)
			and ("legs"."estimate_min" is null or "legs"."estimate_min" >= 0)
			and ("legs"."distance_m" is null or "legs"."distance_m" >= 0))
);
--> statement-breakpoint
CREATE TABLE "trip_days" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"date" date NOT NULL,
	"start_time" text DEFAULT '09:00' NOT NULL,
	"title" text,
	"night_node_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trip_days_trip_id_id_uq" UNIQUE("trip_id","id"),
	CONSTRAINT "trip_days_trip_date_uq" UNIQUE("trip_id","date"),
	CONSTRAINT "trip_days_start_ck" CHECK ("trip_days"."start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
--> statement-breakpoint
CREATE TABLE "share_grants" (
	"trip_id" uuid NOT NULL,
	"share_link_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"color" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_grants_share_link_id_user_id_pk" PRIMARY KEY("share_link_id","user_id"),
	CONSTRAINT "share_grants_color_ck" CHECK ("share_grants"."color" between 0 and 7)
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"token_sealed" text,
	"role" "share_role" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "share_links_trip_id_id_uq" UNIQUE("trip_id","id"),
	CONSTRAINT "share_links_token_hash_ck" CHECK (char_length("share_links"."token_hash") = 43),
	CONSTRAINT "share_links_token_prefix_ck" CHECK (char_length("share_links"."token_prefix") between 1 and 12),
	CONSTRAINT "share_links_use_count_ck" CHECK ("share_links"."use_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "trip_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"user_id" text,
	"status" "member_status" NOT NULL,
	"role" "trip_role" NOT NULL,
	"email" text,
	"display_name" text,
	"color" smallint NOT NULL,
	"invited_by" text,
	"joined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trip_members_trip_id_id_uq" UNIQUE("trip_id","id"),
	CONSTRAINT "trip_members_status_ck" CHECK (("trip_members"."status" = 'active' and "trip_members"."user_id" is not null)
			or ("trip_members"."status" = 'invited' and "trip_members"."user_id" is null and "trip_members"."email" is not null)
			or ("trip_members"."status" = 'placeholder' and "trip_members"."user_id" is null)),
	CONSTRAINT "trip_members_placeholder_name_ck" CHECK ("trip_members"."status" <> 'placeholder' or "trip_members"."display_name" is not null),
	CONSTRAINT "trip_members_email_lower_ck" CHECK ("trip_members"."email" = lower("trip_members"."email")),
	CONSTRAINT "trip_members_color_ck" CHECK ("trip_members"."color" between 0 and 7)
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"start_date" date,
	"end_date" date,
	"default_tz" text DEFAULT 'UTC' NOT NULL,
	"cover_attachment_id" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "trips_slug_ck" CHECK ("trips"."slug" ~ '^[a-z0-9-]{1,100}$'),
	CONSTRAINT "trips_dates_ck" CHECK ("trips"."start_date" is null or "trips"."end_date" is null or "trips"."start_date" <= "trips"."end_date"),
	CONSTRAINT "trips_version_ck" CHECK ("trips"."version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_node_fk" FOREIGN KEY ("trip_id","node_id") REFERENCES "public"."nodes"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_leg_fk" FOREIGN KEY ("trip_id","leg_id") REFERENCES "public"."legs"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_item_fk" FOREIGN KEY ("trip_id","item_id") REFERENCES "public"."items"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_day_fk" FOREIGN KEY ("trip_id","day_id") REFERENCES "public"."trip_days"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_item_assignees" ADD CONSTRAINT "list_item_assignees_item_fk" FOREIGN KEY ("trip_id","list_item_id") REFERENCES "public"."list_items"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_item_assignees" ADD CONSTRAINT "list_item_assignees_member_fk" FOREIGN KEY ("trip_id","member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_item_targets" ADD CONSTRAINT "list_item_targets_item_fk" FOREIGN KEY ("trip_id","list_item_id") REFERENCES "public"."list_items"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_item_targets" ADD CONSTRAINT "list_item_targets_node_fk" FOREIGN KEY ("trip_id","node_id") REFERENCES "public"."nodes"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_items" ADD CONSTRAINT "list_items_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_items" ADD CONSTRAINT "list_items_done_by_user_id_fk" FOREIGN KEY ("done_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_items" ADD CONSTRAINT "list_items_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_items" ADD CONSTRAINT "list_items_node_fk" FOREIGN KEY ("trip_id","node_id") REFERENCES "public"."nodes"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_items" ADD CONSTRAINT "list_items_leg_fk" FOREIGN KEY ("trip_id","leg_id") REFERENCES "public"."legs"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_items" ADD CONSTRAINT "list_items_item_fk" FOREIGN KEY ("trip_id","item_id") REFERENCES "public"."items"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_items" ADD CONSTRAINT "list_items_day_fk" FOREIGN KEY ("trip_id","day_id") REFERENCES "public"."trip_days"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_doc_name_yjs_documents_name_fk" FOREIGN KEY ("doc_name") REFERENCES "public"."yjs_documents"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_member_fk" FOREIGN KEY ("trip_id","member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_list_item_fk" FOREIGN KEY ("trip_id","list_item_id") REFERENCES "public"."list_items"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_note_item_fk" FOREIGN KEY ("trip_id","note_item_id") REFERENCES "public"."items"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yjs_documents" ADD CONSTRAINT "yjs_documents_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yjs_documents" ADD CONSTRAINT "yjs_documents_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yjs_documents" ADD CONSTRAINT "yjs_documents_node_fk" FOREIGN KEY ("trip_id","node_id") REFERENCES "public"."nodes"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yjs_documents" ADD CONSTRAINT "yjs_documents_leg_fk" FOREIGN KEY ("trip_id","leg_id") REFERENCES "public"."legs"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yjs_documents" ADD CONSTRAINT "yjs_documents_item_fk" FOREIGN KEY ("trip_id","item_id") REFERENCES "public"."items"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yjs_documents" ADD CONSTRAINT "yjs_documents_day_fk" FOREIGN KEY ("trip_id","day_id") REFERENCES "public"."trip_days"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_priorities" ADD CONSTRAINT "node_priorities_node_fk" FOREIGN KEY ("trip_id","node_id") REFERENCES "public"."nodes"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_priorities" ADD CONSTRAINT "node_priorities_member_fk" FOREIGN KEY ("trip_id","member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_parent_fk" FOREIGN KEY ("trip_id","parent_id") REFERENCES "public"."nodes"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_assignees" ADD CONSTRAINT "item_assignees_item_fk" FOREIGN KEY ("trip_id","item_id") REFERENCES "public"."items"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_assignees" ADD CONSTRAINT "item_assignees_member_fk" FOREIGN KEY ("trip_id","member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_day_fk" FOREIGN KEY ("trip_id","day_id") REFERENCES "public"."trip_days"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_node_fk" FOREIGN KEY ("trip_id","node_id") REFERENCES "public"."nodes"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leg_assignees" ADD CONSTRAINT "leg_assignees_leg_fk" FOREIGN KEY ("trip_id","leg_id") REFERENCES "public"."legs"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leg_assignees" ADD CONSTRAINT "leg_assignees_member_fk" FOREIGN KEY ("trip_id","member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legs" ADD CONSTRAINT "legs_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legs" ADD CONSTRAINT "legs_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legs" ADD CONSTRAINT "legs_from_fk" FOREIGN KEY ("trip_id","from_item_id") REFERENCES "public"."items"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legs" ADD CONSTRAINT "legs_to_fk" FOREIGN KEY ("trip_id","to_item_id") REFERENCES "public"."items"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legs" ADD CONSTRAINT "legs_stay_day_fk" FOREIGN KEY ("trip_id","stay_day_id") REFERENCES "public"."trip_days"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_days" ADD CONSTRAINT "trip_days_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_grants" ADD CONSTRAINT "share_grants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_grants" ADD CONSTRAINT "share_grants_link_fk" FOREIGN KEY ("trip_id","share_link_id") REFERENCES "public"."share_links"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "attachments_node_idx" ON "attachments" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "attachments_leg_idx" ON "attachments" USING btree ("leg_id");--> statement-breakpoint
CREATE INDEX "attachments_item_idx" ON "attachments" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "attachments_day_idx" ON "attachments" USING btree ("day_id");--> statement-breakpoint
CREATE INDEX "attachments_trip_live_idx" ON "attachments" USING btree ("trip_id") WHERE "attachments"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "list_item_assignees_member_idx" ON "list_item_assignees" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "list_item_assignees_trip_idx" ON "list_item_assignees" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "list_item_targets_node_idx" ON "list_item_targets" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "list_item_targets_trip_idx" ON "list_item_targets" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "list_items_node_idx" ON "list_items" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "list_items_leg_idx" ON "list_items" USING btree ("leg_id");--> statement-breakpoint
CREATE INDEX "list_items_item_idx" ON "list_items" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "list_items_day_idx" ON "list_items" USING btree ("day_id");--> statement-breakpoint
CREATE INDEX "list_items_trip_live_idx" ON "list_items" USING btree ("trip_id","list") WHERE "list_items"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "list_items_due_idx" ON "list_items" USING btree ("trip_id","due_date") WHERE "list_items"."status" = 'open' and "list_items"."due_date" is not null;--> statement-breakpoint
CREATE INDEX "list_items_due_day_idx" ON "list_items" USING btree ("due_day_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mentions_doc_member_uq" ON "mentions" USING btree ("doc_name","member_id") WHERE "mentions"."doc_name" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "mentions_list_member_uq" ON "mentions" USING btree ("list_item_id","member_id") WHERE "mentions"."list_item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "mentions_note_member_uq" ON "mentions" USING btree ("note_item_id","member_id") WHERE "mentions"."note_item_id" is not null;--> statement-breakpoint
CREATE INDEX "mentions_member_unread_idx" ON "mentions" USING btree ("member_id") WHERE "mentions"."read_at" is null;--> statement-breakpoint
CREATE INDEX "mentions_trip_idx" ON "mentions" USING btree ("trip_id","created_at");--> statement-breakpoint
CREATE INDEX "yjs_documents_node_idx" ON "yjs_documents" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "yjs_documents_leg_idx" ON "yjs_documents" USING btree ("leg_id");--> statement-breakpoint
CREATE INDEX "yjs_documents_item_idx" ON "yjs_documents" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "yjs_documents_day_idx" ON "yjs_documents" USING btree ("day_id");--> statement-breakpoint
CREATE INDEX "yjs_documents_trip_idx" ON "yjs_documents" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "activity_trip_idx" ON "activity_log" USING btree ("trip_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_node_idx" ON "activity_log" USING btree ("node_id","created_at");--> statement-breakpoint
CREATE INDEX "node_priorities_member_idx" ON "node_priorities" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "node_priorities_trip_idx" ON "node_priorities" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "nodes_trip_live_idx" ON "nodes" USING btree ("trip_id") WHERE "nodes"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "nodes_parent_pos_idx" ON "nodes" USING btree ("parent_id","position");--> statement-breakpoint
CREATE INDEX "nodes_trip_gpid_idx" ON "nodes" USING btree ("trip_id","google_place_id");--> statement-breakpoint
CREATE INDEX "item_assignees_member_idx" ON "item_assignees" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "item_assignees_trip_idx" ON "item_assignees" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "items_day_pos_idx" ON "items" USING btree ("day_id","position") WHERE "items"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "items_day_idx" ON "items" USING btree ("trip_id","day_id");--> statement-breakpoint
CREATE INDEX "items_node_idx" ON "items" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "leg_assignees_member_idx" ON "leg_assignees" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "leg_assignees_trip_idx" ON "leg_assignees" USING btree ("trip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "legs_pair_uq" ON "legs" USING btree ("from_item_id","to_item_id") WHERE "legs"."kind" = 'pair';--> statement-breakpoint
CREATE UNIQUE INDEX "legs_stay_uq" ON "legs" USING btree ("stay_day_id","kind") WHERE "legs"."kind" <> 'pair';--> statement-breakpoint
CREATE INDEX "legs_trip_idx" ON "legs" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "legs_from_idx" ON "legs" USING btree ("from_item_id");--> statement-breakpoint
CREATE INDEX "legs_to_idx" ON "legs" USING btree ("to_item_id");--> statement-breakpoint
CREATE INDEX "legs_stay_day_idx" ON "legs" USING btree ("stay_day_id");--> statement-breakpoint
CREATE INDEX "trip_days_night_node_idx" ON "trip_days" USING btree ("night_node_id");--> statement-breakpoint
CREATE INDEX "share_grants_user_idx" ON "share_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "share_grants_trip_idx" ON "share_grants" USING btree ("trip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_token_hash_uq" ON "share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_live_role_uq" ON "share_links" USING btree ("trip_id","role") WHERE "share_links"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "trip_members_trip_user_uq" ON "trip_members" USING btree ("trip_id","user_id") WHERE "trip_members"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "trip_members_trip_email_uq" ON "trip_members" USING btree ("trip_id","email") WHERE "trip_members"."email" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "trip_members_one_owner_uq" ON "trip_members" USING btree ("trip_id") WHERE "trip_members"."role" = 'owner';--> statement-breakpoint
CREATE INDEX "trip_members_user_idx" ON "trip_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "trip_members_invited_email_idx" ON "trip_members" USING btree ("email") WHERE "trip_members"."status" = 'invited';--> statement-breakpoint
CREATE UNIQUE INDEX "trips_slug_uq" ON "trips" USING btree ("slug") WHERE "trips"."deleted_at" is null;