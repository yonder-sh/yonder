-- A trip with money (or a merged placeholder) couldn't be deleted: the money →
-- member keys and trip_members_merged_into_fk were NO ACTION, checked at the end
-- of each cascaded delete, so whichever cascade reached trip_members first
-- (trips → trip_members before trips → expenses → expense_shares) failed the
-- whole `delete from trips`. Member rows only go with their trip or their user's
-- account (the app retires members, `retireMember`, and `deleteUserAccount`
-- retires them before the account goes), so the money rows go with them:
-- shares, payers and line members CASCADE, and so does a settlement (a transfer
-- with one side gone means nothing). The generated part below is Drizzle's; the
-- last statement is hand-written (a column-list SET NULL, which Drizzle can't
-- express and its snapshot doesn't track): a merge target's row going leaves the
-- merged placeholder a plain former member.
ALTER TABLE "expense_line_members" DROP CONSTRAINT "expense_line_members_member_fk";
--> statement-breakpoint
ALTER TABLE "expense_payment_payers" DROP CONSTRAINT "expense_payment_payers_member_fk";
--> statement-breakpoint
ALTER TABLE "expense_shares" DROP CONSTRAINT "expense_shares_member_fk";
--> statement-breakpoint
ALTER TABLE "settlements" DROP CONSTRAINT "settlements_from_member_fk";
--> statement-breakpoint
ALTER TABLE "settlements" DROP CONSTRAINT "settlements_to_member_fk";
--> statement-breakpoint
ALTER TABLE "expense_line_members" ADD CONSTRAINT "expense_line_members_member_fk" FOREIGN KEY ("trip_id","member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payment_payers" ADD CONSTRAINT "expense_payment_payers_member_fk" FOREIGN KEY ("trip_id","member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_shares" ADD CONSTRAINT "expense_shares_member_fk" FOREIGN KEY ("trip_id","member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_from_member_fk" FOREIGN KEY ("trip_id","from_member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_to_member_fk" FOREIGN KEY ("trip_id","to_member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_members" DROP CONSTRAINT "trip_members_merged_into_fk";
--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_merged_into_fk" FOREIGN KEY ("trip_id", "merged_into_id")
  REFERENCES "trip_members" ("trip_id", "id") ON DELETE SET NULL ("merged_into_id");
