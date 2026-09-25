ALTER TABLE "mentions" DROP CONSTRAINT "mentions_source_ck";--> statement-breakpoint
ALTER TABLE "mentions" ADD COLUMN "rater_member_id" uuid;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_rater_fk" FOREIGN KEY ("trip_id","rater_member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mentions_rating_member_uq" ON "mentions" USING btree ("node_id","rater_member_id","member_id") WHERE "mentions"."rater_member_id" is not null;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_source_ck" CHECK (num_nonnulls("mentions"."doc_name", "mentions"."list_item_id", "mentions"."note_item_id", "mentions"."rater_member_id") = 1);