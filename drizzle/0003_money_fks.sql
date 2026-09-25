-- EXTENSIONS §8.1 / ADDENDUM §6: money FKs Drizzle can't express. Hand-written;
-- Drizzle's snapshot doesn't track any of this, so later `drizzle-kit generate`
-- runs see no diff. Column-list SET NULL (Postgres 15+) nulls only the referencing
-- id, never trip_id: deleting a leg, day, node or item leaves the expense
-- "Trip-wide" (expenses_target_ck allows it), so money history never vanishes.
-- No enum literal added by 0002 (`suggester`, `removed`) may appear here: drizzle's
-- migrator applies every pending file in ONE transaction.
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_node_fk" FOREIGN KEY ("trip_id", "node_id")
  REFERENCES "nodes" ("trip_id", "id") ON DELETE SET NULL ("node_id");
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_leg_fk" FOREIGN KEY ("trip_id", "leg_id")
  REFERENCES "legs" ("trip_id", "id") ON DELETE SET NULL ("leg_id");
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_item_fk" FOREIGN KEY ("trip_id", "item_id")
  REFERENCES "items" ("trip_id", "id") ON DELETE SET NULL ("item_id");
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_day_fk" FOREIGN KEY ("trip_id", "day_id")
  REFERENCES "trip_days" ("trip_id", "id") ON DELETE SET NULL ("day_id");
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_list_item_fk" FOREIGN KEY ("trip_id", "list_item_id")
  REFERENCES "list_items" ("trip_id", "id") ON DELETE SET NULL ("list_item_id");
--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_node_fk" FOREIGN KEY ("trip_id", "node_id")
  REFERENCES "nodes" ("trip_id", "id") ON DELETE SET NULL ("node_id");
--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_day_fk" FOREIGN KEY ("trip_id", "day_id")
  REFERENCES "trip_days" ("trip_id", "id") ON DELETE SET NULL ("day_id");
--> statement-breakpoint
-- Receipts: an attachment on an expense goes with it (a hard delete happens only
-- with the trip; expenses are soft-deleted).
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_expense_fk" FOREIGN KEY ("trip_id", "expense_id")
  REFERENCES "expenses" ("trip_id", "id") ON DELETE CASCADE;
