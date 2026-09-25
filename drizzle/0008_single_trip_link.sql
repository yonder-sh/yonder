-- FB-13 (owner, 2026-09-23): ONE share link per trip, like Google Docs.
-- Every trip keeps the live link it most likely shares today (switched on
-- and unexpired first, then the most recently opened, the most used, the
-- newest); every other live link is revoked: its URL stops working and the
-- guests who came in through it lose that access (as "Reset link" does).
-- Their open suggestions are withdrawn when they have no other way in,
-- together with suggestions that depend on them (EXTENSIONS §3.5).
CREATE TEMP TABLE "_fb13_lost" ("trip_id" uuid NOT NULL, "user_id" text NOT NULL);--> statement-breakpoint
WITH "ranked" AS (
	SELECT "id", row_number() OVER (
		PARTITION BY "trip_id"
		ORDER BY "enabled" DESC,
		         ("expires_at" IS NULL OR "expires_at" > now()) DESC,
		         "last_used_at" DESC NULLS LAST,
		         "use_count" DESC,
		         "created_at" DESC,
		         "id" DESC
	) AS "rn"
	  FROM "share_links"
	 WHERE "revoked_at" IS NULL
), "retired" AS (
	UPDATE "share_links" "l" SET "revoked_at" = now(), "enabled" = false
	  FROM "ranked" "r"
	 WHERE "l"."id" = "r"."id" AND "r"."rn" > 1
	RETURNING "l"."id"
), "gone" AS (
	DELETE FROM "share_grants" "g" USING "retired" "r"
	 WHERE "g"."share_link_id" = "r"."id"
	RETURNING "g"."trip_id", "g"."user_id"
)
INSERT INTO "_fb13_lost" SELECT DISTINCT "trip_id", "user_id" FROM "gone";--> statement-breakpoint
DELETE FROM "_fb13_lost" "x"
 WHERE EXISTS (SELECT 1 FROM "trip_members" "m" WHERE "m"."trip_id" = "x"."trip_id" AND "m"."user_id" = "x"."user_id" AND "m"."status" = 'active')
    OR EXISTS (SELECT 1 FROM "share_grants" "g" WHERE "g"."trip_id" = "x"."trip_id" AND "g"."user_id" = "x"."user_id");--> statement-breakpoint
CREATE TEMP TABLE "_fb13_withdrawn" ("id" uuid NOT NULL);--> statement-breakpoint
WITH "w" AS (
	UPDATE "proposals" "p" SET "status" = 'withdrawn', "review_note" = 'author lost access', "updated_at" = now()
	  FROM "_fb13_lost" "x"
	 WHERE "p"."trip_id" = "x"."trip_id" AND "p"."author_user_id" = "x"."user_id" AND "p"."status" = 'open'
	RETURNING "p"."id"
)
INSERT INTO "_fb13_withdrawn" SELECT "id" FROM "w";--> statement-breakpoint
WITH RECURSIVE "dep"("id") AS (
	SELECT "p"."id" FROM "proposals" "p"
	 WHERE "p"."status" = 'open' AND "p"."requires" && ARRAY(SELECT "id" FROM "_fb13_withdrawn")
	UNION
	SELECT "p"."id" FROM "proposals" "p" JOIN "dep" "d" ON "d"."id" = ANY("p"."requires")
	 WHERE "p"."status" = 'open'
)
UPDATE "proposals" SET "status" = 'withdrawn', "review_note" = 'depends on a withdrawn suggestion', "updated_at" = now()
 WHERE "id" IN (SELECT "id" FROM "dep") AND "status" = 'open';--> statement-breakpoint
DROP TABLE "_fb13_withdrawn";--> statement-breakpoint
DROP TABLE "_fb13_lost";--> statement-breakpoint
-- FB-14: per-person join links are gone (people join by email invite or the
-- trip link; editors still tie a placeholder to a member or an email).
ALTER TABLE "trip_members" DROP CONSTRAINT "trip_members_claim_ck";--> statement-breakpoint
DROP INDEX "trip_members_claim_token_uq";--> statement-breakpoint
ALTER TABLE "trip_members" DROP COLUMN "claim_token_hash";--> statement-breakpoint
ALTER TABLE "trip_members" DROP COLUMN "claim_token_prefix";--> statement-breakpoint
ALTER TABLE "trip_members" DROP COLUMN "claim_token_sealed";--> statement-breakpoint
ALTER TABLE "trip_members" DROP COLUMN "claim_expires_at";
