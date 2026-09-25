-- SPEC §6.4: constraints Drizzle can't express. Hand-written; Drizzle's snapshot
-- doesn't track any of this, so later `drizzle-kit generate` runs see no diff.

-- Sibling slug uniqueness among live nodes (root siblings share parent_id NULL, hence NULLS NOT DISTINCT).
CREATE UNIQUE INDEX "nodes_sibling_slug_uq" ON "nodes" ("trip_id", "parent_id", "slug") NULLS NOT DISTINCT WHERE "deleted_at" IS NULL;
--> statement-breakpoint
-- A node may not become its own ancestor. (Type-rank rules are enforced in nodes.functions.ts.)
-- UNION (not UNION ALL) so the walk terminates even on corrupt data.
CREATE OR REPLACE FUNCTION nodes_prevent_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.parent_id = NEW.id OR EXISTS (
    WITH RECURSIVE up AS (
      SELECT id, parent_id FROM nodes WHERE id = NEW.parent_id
      UNION
      SELECT n.id, n.parent_id FROM nodes n JOIN up ON n.id = up.parent_id
    )
    SELECT 1 FROM up WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'cycle'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'nodes_no_cycle',
            DETAIL = format('node %s cannot be moved under its own descendant %s', NEW.id, NEW.parent_id);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "nodes_prevent_cycle" BEFORE INSERT OR UPDATE OF "parent_id" ON "nodes" FOR EACH ROW EXECUTE FUNCTION nodes_prevent_cycle();
--> statement-breakpoint
-- Days can swap or shift dates inside one transaction (moveDay, insertDay, shiftTripDates).
ALTER TABLE "trip_days" DROP CONSTRAINT "trip_days_trip_date_uq";
--> statement-breakpoint
ALTER TABLE "trip_days" ADD CONSTRAINT "trip_days_trip_date_uq" UNIQUE ("trip_id", "date") DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
-- Column-list SET NULL (Postgres 15+): only the referencing id column is nulled, never trip_id.
-- These two FKs are NOT declared in the TS schema (Drizzle can't express them).
ALTER TABLE "list_items" ADD CONSTRAINT "list_items_due_day_fk" FOREIGN KEY ("trip_id", "due_day_id")
  REFERENCES "trip_days" ("trip_id", "id") ON DELETE SET NULL ("due_day_id");
--> statement-breakpoint
ALTER TABLE "trip_days" ADD CONSTRAINT "trip_days_night_node_fk" FOREIGN KEY ("trip_id", "night_node_id")
  REFERENCES "nodes" ("trip_id", "id") ON DELETE SET NULL ("night_node_id");
