-- ADDENDUM §7.3/§9: a receipt can belong to ONE payment of its expense. Hand-written
-- (Drizzle can't express a column-list SET NULL; its snapshot doesn't track this, so
-- later `drizzle-kit generate` runs see no diff). The FK includes expense_id, so a
-- payment of ANOTHER expense can never be named; deleting or replacing a payment
-- nulls only payment_id and the receipt stays on the expense.
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_payment_fk" FOREIGN KEY ("trip_id", "expense_id", "payment_id")
  REFERENCES "expense_payments" ("trip_id", "expense_id", "id") ON DELETE SET NULL ("payment_id");
