CREATE TABLE "inbox_reads" (
	"user_id" text NOT NULL,
	"item_key" text NOT NULL,
	"trip_id" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_reads_user_id_item_key_pk" PRIMARY KEY("user_id","item_key"),
	CONSTRAINT "inbox_reads_key_ck" CHECK (char_length("inbox_reads"."item_key") <= 200)
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "payment_id" uuid;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD COLUMN "default_seen_minor" bigint;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "net_after" jsonb;--> statement-breakpoint
ALTER TABLE "trip_members" ADD COLUMN "claim_token_hash" text;--> statement-breakpoint
ALTER TABLE "trip_members" ADD COLUMN "claim_token_prefix" text;--> statement-breakpoint
ALTER TABLE "trip_members" ADD COLUMN "claim_token_sealed" text;--> statement-breakpoint
ALTER TABLE "trip_members" ADD COLUMN "claim_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trip_members" ADD COLUMN "merged_into_id" uuid;--> statement-breakpoint
ALTER TABLE "inbox_reads" ADD CONSTRAINT "inbox_reads_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_reads" ADD CONSTRAINT "inbox_reads_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_reads_user_trip_idx" ON "inbox_reads" USING btree ("user_id","trip_id");--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_merged_into_fk" FOREIGN KEY ("trip_id","merged_into_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_payment_idx" ON "attachments" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trip_members_claim_token_uq" ON "trip_members" USING btree ("claim_token_hash") WHERE "trip_members"."claim_token_hash" is not null;--> statement-breakpoint
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_trip_expense_id_uq" UNIQUE("trip_id","expense_id","id");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_payment_ck" CHECK ("attachments"."payment_id" is null or "attachments"."expense_id" is not null);--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_default_seen_ck" CHECK ("budget_lines"."default_seen_minor" is null or "budget_lines"."member_id" is not null);--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_claim_ck" CHECK ("trip_members"."claim_token_hash" is null or ("trip_members"."status" = 'placeholder' and char_length("trip_members"."claim_token_hash") = 43));--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_merged_ck" CHECK ("trip_members"."merged_into_id" is null or "trip_members"."merged_into_id" <> "trip_members"."id");