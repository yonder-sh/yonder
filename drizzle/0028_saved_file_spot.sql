-- Saved photos keep where and when they were taken (the feed's trip and area default).
ALTER TABLE "saved_files" ADD COLUMN "lat" double precision;--> statement-breakpoint
ALTER TABLE "saved_files" ADD COLUMN "lng" double precision;--> statement-breakpoint
ALTER TABLE "saved_files" ADD COLUMN "taken_at" timestamp with time zone;