-- PLACES §1c "Can rate": a role between viewer and suggester. Appended to both
-- enums (ranking lives in RANK, src/lib/auth/roles.ts). Existing rows are
-- untouched: viewers stay viewers.
ALTER TYPE "public"."share_role" ADD VALUE 'rater';--> statement-breakpoint
ALTER TYPE "public"."trip_role" ADD VALUE 'rater';