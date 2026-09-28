-- One Yonder D12: the Packing list (appended to list_kind) and a booking's
-- confirmation code on its to-do.
ALTER TYPE "public"."list_kind" ADD VALUE 'packing';--> statement-breakpoint
ALTER TABLE "list_items" ADD COLUMN "booking_ref" text;