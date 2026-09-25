CREATE TYPE "public"."attachment_visibility" AS ENUM('everyone', 'members');--> statement-breakpoint
ALTER TYPE "public"."attachment_kind" ADD VALUE 'pdf';--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "visibility" "attachment_visibility" DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "list_items" ADD COLUMN "due_rule" jsonb;--> statement-breakpoint
ALTER TABLE "node_priorities" ADD COLUMN "rating_comment" text;--> statement-breakpoint
ALTER TABLE "node_priorities" ADD CONSTRAINT "node_priorities_comment_ck" CHECK ("node_priorities"."rating_comment" is null or char_length("node_priorities"."rating_comment") <= 280);