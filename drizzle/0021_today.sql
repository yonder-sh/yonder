-- One Yonder phase 5 (Today): Done on a stop (when and by whom, shared by
-- the group) and a place's address in local script for drivers (a cache).
ALTER TABLE "nodes" ADD COLUMN "local_address" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "done_by" text;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_done_by_user_id_fk" FOREIGN KEY ("done_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;