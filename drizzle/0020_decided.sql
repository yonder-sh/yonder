-- One Yonder D08: "Mark decided" at any scope (a node or the whole trip),
-- when and by whom.
ALTER TABLE "nodes" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "decided_by" text;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "decided_by" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;