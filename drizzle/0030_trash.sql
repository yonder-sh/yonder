-- Trash counts toward the quota: the per-uploader index covers deleted rows too.
DROP INDEX "attachments_created_by_live_idx";--> statement-breakpoint
CREATE INDEX "attachments_created_by_idx" ON "attachments" USING btree ("created_by");