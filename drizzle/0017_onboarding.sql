CREATE TABLE "rate_reminders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"by_user_id" text,
	"by_name" text NOT NULL,
	"places" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone,
	CONSTRAINT "rate_reminders_places_ck" CHECK ("rate_reminders"."places" >= 0)
);
--> statement-breakpoint
ALTER TABLE "trip_seen" ADD COLUMN "welcome_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "trip_members" ADD COLUMN "ratings_counted" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "trip_members" ADD COLUMN "invite_note" text;--> statement-breakpoint
ALTER TABLE "trip_members" ADD COLUMN "joined_by_link" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rate_reminders" ADD CONSTRAINT "rate_reminders_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_reminders" ADD CONSTRAINT "rate_reminders_by_user_id_user_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_reminders" ADD CONSTRAINT "rate_reminders_member_fk" FOREIGN KEY ("trip_id","member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rate_reminders_member_idx" ON "rate_reminders" USING btree ("trip_id","member_id","created_at");--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_note_ck" CHECK (char_length("share_links"."note") <= 140);--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_invite_note_ck" CHECK (char_length("trip_members"."invite_note") <= 140);--> statement-breakpoint
-- Whoever already opened a trip has seen it: the welcome is for newcomers.
UPDATE "trip_seen" SET "welcome_seen_at" = "seen_at";--> statement-breakpoint
-- The fixed shortlist score becomes a per-person level, read for a group of two (+2 Want, +3 halfway, +4 Really want).
UPDATE "trips"
   SET "settings" = "settings" || jsonb_build_object('shortlistLevel',
         CASE WHEN ("settings"->>'shortlistMinScore')::numeric <= 2 THEN 1
              WHEN ("settings"->>'shortlistMinScore')::numeric >= 4 THEN 2
              ELSE 1.5 END)
 WHERE jsonb_typeof("settings"->'shortlistMinScore') = 'number'
   AND NOT ("settings" ? 'shortlistLevel');
