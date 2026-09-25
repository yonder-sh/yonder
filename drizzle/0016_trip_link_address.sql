-- Owner decision (2026-09-25): the trip's address IS its share link, like
-- Google Drive. `/join#t=<token>` links are gone: members open /t/<slug> as
-- members, and anyone else gets the "Anyone with the link" role while the
-- trip's link is on. The token columns go; the link row keeps the role,
-- on/off, expiry and use count, and grants still hang off it.
ALTER TABLE "share_links" DROP CONSTRAINT "share_links_token_hash_ck";--> statement-breakpoint
ALTER TABLE "share_links" DROP CONSTRAINT "share_links_token_prefix_ck";--> statement-breakpoint
DROP INDEX "share_links_token_hash_uq";--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "slug_tail" text;--> statement-breakpoint
ALTER TABLE "share_links" DROP COLUMN "token_hash";--> statement-breakpoint
ALTER TABLE "share_links" DROP COLUMN "token_prefix";--> statement-breakpoint
ALTER TABLE "share_links" DROP COLUMN "token_sealed";--> statement-breakpoint
-- Every existing trip gets an unguessable tail (src/lib/trip-slug.ts: 8 of
-- the 31 characters without 0/o/1/l/i, from gen_random_uuid()'s random
-- bytes, rejection-sampled): /t/asia-2027 becomes /t/asia-2027-k7m2qxw9.
-- The readable part is kept (cut to 91 characters). Members find the trip
-- from their dashboard; guests keep their grants.
DO $$
DECLARE
	alphabet constant text := '23456789abcdefghjkmnpqrstuvwxyz';
	r record;
	base text;
	tail text;
	bytes bytea;
	b int;
	i int;
BEGIN
	FOR r IN SELECT "id", "slug", "deleted_at" FROM "trips" WHERE "slug_tail" IS NULL LOOP
		base := rtrim(left(r."slug", 91), '-');
		IF base = '' THEN
			base := 'trip';
		END IF;
		LOOP
			tail := '';
			WHILE length(tail) < 8 LOOP
				bytes := uuid_send(gen_random_uuid());
				-- A v4 uuid: bytes 6 and 8 carry the version and variant bits.
				FOREACH i IN ARRAY ARRAY[0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13, 14, 15] LOOP
					b := get_byte(bytes, i);
					IF b < 248 AND length(tail) < 8 THEN
						tail := tail || substr(alphabet, 1 + b % 31, 1);
					END IF;
				END LOOP;
			END LOOP;
			EXIT WHEN r."deleted_at" IS NOT NULL OR NOT EXISTS (
				SELECT 1 FROM "trips" WHERE "slug" = base || '-' || tail AND "deleted_at" IS NULL
			);
		END LOOP;
		UPDATE "trips" SET "slug" = base || '-' || tail, "slug_tail" = tail WHERE "id" = r."id";
	END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_slug_tail_ck" CHECK ("trips"."slug_tail" is null or ("trips"."slug_tail" ~ '^[23456789abcdefghjkmnpqrstuvwxyz]{8}$' and right("trips"."slug", 9) = '-' || "trips"."slug_tail"));