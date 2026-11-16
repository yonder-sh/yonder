-- An expense can be the price of a flight booking (`legs.details.flight.bookingId`),
-- once among the expenses a trip shares. Flights from before bookings are each their own.
ALTER TABLE "expenses" ADD COLUMN "booking_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_booking_uq" ON "expenses" USING btree ("trip_id","booking_id") WHERE "expenses"."booking_id" is not null and "expenses"."deleted_at" is null and not "expenses"."is_private";--> statement-breakpoint
UPDATE "legs"
   SET "details" = jsonb_set("details", '{flight,bookingId}', to_jsonb(gen_random_uuid()::text))
 WHERE "mode" = 'flight'
   AND "details"->>'kind' = 'flight'
   AND jsonb_typeof("details"->'flight') = 'object'
   AND "details"->'flight'->>'bookingId' IS NULL
   AND NOT ("source" = 'estimate' AND "is_edited" = false);
