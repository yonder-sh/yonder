CREATE TYPE "public"."budget_kind" AS ENUM('total', 'per_day');--> statement-breakpoint
CREATE TYPE "public"."due_kind" AS ENUM('due', 'opens', 'on');--> statement-breakpoint
CREATE TYPE "public"."expense_category" AS ENUM('lodging', 'transport', 'food_drink', 'activities', 'shopping', 'fees_other');--> statement-breakpoint
CREATE TYPE "public"."fee_kind" AS ENUM('percent', 'fixed');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('open', 'accepted', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."split_mode" AS ENUM('equal', 'exact');--> statement-breakpoint
ALTER TYPE "public"."member_status" ADD VALUE 'removed';--> statement-breakpoint
ALTER TYPE "public"."share_role" ADD VALUE 'suggester';--> statement-breakpoint
ALTER TYPE "public"."trip_role" ADD VALUE 'suggester';--> statement-breakpoint
CREATE TABLE "climate_normals" (
	"cell" text NOT NULL,
	"month" smallint NOT NULL,
	"t_max_c" real NOT NULL,
	"t_min_c" real NOT NULL,
	"precip_mm" real NOT NULL,
	"wet_days" real NOT NULL,
	"sun_hours" real,
	"years" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "climate_normals_cell_month_pk" PRIMARY KEY("cell","month"),
	CONSTRAINT "climate_month_ck" CHECK ("climate_normals"."month" between 1 and 12)
);
--> statement-breakpoint
CREATE TABLE "trip_seen" (
	"trip_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"seen_version" bigint DEFAULT 0 NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trip_seen_trip_id_user_id_pk" PRIMARY KEY("trip_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "user_prefs" (
	"user_id" text PRIMARY KEY NOT NULL,
	"prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"node_id" uuid,
	"category" "expense_category",
	"member_id" uuid,
	"amount_minor" bigint NOT NULL,
	"kind" "budget_kind" DEFAULT 'total' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_lines_uq" UNIQUE NULLS NOT DISTINCT("trip_id","node_id","category","member_id"),
	CONSTRAINT "budget_lines_amount_ck" CHECK ("budget_lines"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "expense_fees" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"label" text NOT NULL,
	"kind" "fee_kind" NOT NULL,
	"percent" numeric(7, 4),
	"amount_minor" bigint,
	"position" text COLLATE "C" NOT NULL,
	CONSTRAINT "expense_fees_value_ck" CHECK (("expense_fees"."kind" = 'percent' and "expense_fees"."percent" is not null and "expense_fees"."percent" between 0 and 100)
			or ("expense_fees"."kind" = 'fixed' and "expense_fees"."amount_minor" is not null)),
	CONSTRAINT "expense_fees_label_ck" CHECK (char_length("expense_fees"."label") between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "expense_line_members" (
	"trip_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	CONSTRAINT "expense_line_members_line_id_member_id_pk" PRIMARY KEY("line_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "expense_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"label" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"position" text COLLATE "C" NOT NULL,
	CONSTRAINT "expense_lines_trip_id_id_uq" UNIQUE("trip_id","id"),
	CONSTRAINT "expense_lines_label_ck" CHECK (char_length("expense_lines"."label") between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "expense_payment_payers" (
	"trip_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	CONSTRAINT "expense_payment_payers_payment_id_member_id_pk" PRIMARY KEY("payment_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "expense_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"paid_tz" text NOT NULL,
	"currency" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"home_currency" text,
	"home_amount_minor" bigint,
	"fx_rate" numeric(24, 12),
	"fx_date" date,
	"fx_source" text,
	"fx_manual" boolean DEFAULT false NOT NULL,
	"method" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_payments_trip_id_id_uq" UNIQUE("trip_id","id"),
	CONSTRAINT "expense_payments_currency_ck" CHECK ("expense_payments"."currency" ~ '^[A-Z]{3}$' and ("expense_payments"."home_currency" is null or "expense_payments"."home_currency" ~ '^[A-Z]{3}$')),
	CONSTRAINT "expense_payments_method_ck" CHECK ("expense_payments"."method" is null or char_length("expense_payments"."method") <= 60)
);
--> statement-breakpoint
CREATE TABLE "expense_shares" (
	"trip_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"amount_minor" bigint,
	CONSTRAINT "expense_shares_expense_id_member_id_pk" PRIMARY KEY("expense_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"node_id" uuid,
	"leg_id" uuid,
	"item_id" uuid,
	"day_id" uuid,
	"list_item_id" uuid,
	"refund_of_id" uuid,
	"title" text NOT NULL,
	"category" "expense_category" DEFAULT 'fees_other' NOT NULL,
	"amount_minor" bigint,
	"currency" text,
	"home_currency" text,
	"home_amount_minor" bigint,
	"fx_rate" numeric(24, 12),
	"fx_date" date,
	"fx_source" text,
	"fx_manual" boolean DEFAULT false NOT NULL,
	"points" integer,
	"points_program" text,
	"source_points" integer,
	"source_program" text,
	"cash_value_minor" bigint,
	"cash_value_currency" text,
	"expected_on" date,
	"split_mode" "split_mode" DEFAULT 'equal' NOT NULL,
	"is_private" boolean DEFAULT false NOT NULL,
	"tax_free_pending" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "expenses_trip_id_id_uq" UNIQUE("trip_id","id"),
	CONSTRAINT "expenses_target_ck" CHECK (num_nonnulls("expenses"."node_id", "expenses"."leg_id", "expenses"."item_id", "expenses"."day_id") <= 1),
	CONSTRAINT "expenses_money_ck" CHECK (("expenses"."amount_minor" is null) = ("expenses"."currency" is null)),
	CONSTRAINT "expenses_sign_ck" CHECK ("expenses"."amount_minor" is null or "expenses"."amount_minor" >= 0 or "expenses"."refund_of_id" is not null),
	CONSTRAINT "expenses_some_cost_ck" CHECK ("expenses"."amount_minor" is not null or "expenses"."points" is not null),
	CONSTRAINT "expenses_points_ck" CHECK (("expenses"."points" is null) = ("expenses"."points_program" is null) and ("expenses"."points" is null or "expenses"."points" > 0)),
	CONSTRAINT "expenses_source_points_ck" CHECK (("expenses"."source_points" is null) = ("expenses"."source_program" is null) and ("expenses"."source_points" is null or "expenses"."source_points" > 0)),
	CONSTRAINT "expenses_cash_value_ck" CHECK (("expenses"."cash_value_minor" is null) = ("expenses"."cash_value_currency" is null)),
	CONSTRAINT "expenses_currency_ck" CHECK (("expenses"."currency" is null or "expenses"."currency" ~ '^[A-Z]{3}$')
			and ("expenses"."home_currency" is null or "expenses"."home_currency" ~ '^[A-Z]{3}$')
			and ("expenses"."cash_value_currency" is null or "expenses"."cash_value_currency" ~ '^[A-Z]{3}$')),
	CONSTRAINT "expenses_text_ck" CHECK (char_length("expenses"."title") between 1 and 120 and ("expenses"."note" is null or char_length("expenses"."note") <= 2000)),
	CONSTRAINT "expenses_no_self_refund_ck" CHECK ("expenses"."refund_of_id" is null or "expenses"."refund_of_id" <> "expenses"."id")
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"date" date NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"rate" numeric(24, 12) NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_date_base_quote_pk" PRIMARY KEY("date","base","quote"),
	CONSTRAINT "fx_rates_ck" CHECK ("fx_rates"."rate" > 0 and "fx_rates"."base" ~ '^[A-Z]{3}$' and "fx_rates"."quote" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"from_member_id" uuid NOT NULL,
	"to_member_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"home_currency" text,
	"home_amount_minor" bigint,
	"fx_rate" numeric(24, 12),
	"fx_date" date,
	"fx_source" text,
	"fx_manual" boolean DEFAULT false NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	"settled_tz" text NOT NULL,
	"method" text,
	"note" text,
	"node_id" uuid,
	"day_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "settlements_trip_id_id_uq" UNIQUE("trip_id","id"),
	CONSTRAINT "settlements_ck" CHECK ("settlements"."from_member_id" <> "settlements"."to_member_id" and "settlements"."amount_minor" > 0),
	CONSTRAINT "settlements_currency_ck" CHECK ("settlements"."currency" ~ '^[A-Z]{3}$' and ("settlements"."home_currency" is null or "settlements"."home_currency" ~ '^[A-Z]{3}$')),
	CONSTRAINT "settlements_scope_ck" CHECK (num_nonnulls("settlements"."node_id", "settlements"."day_id") <= 1)
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"op" text NOT NULL,
	"payload" jsonb NOT NULL,
	"base" jsonb NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_id" uuid,
	"created_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"requires" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"summary" text NOT NULL,
	"message" text,
	"status" "proposal_status" DEFAULT 'open' NOT NULL,
	"author_user_id" text,
	"author_member_id" uuid,
	"author_name" text NOT NULL,
	"author_color" smallint NOT NULL,
	"author_is_guest" boolean NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"last_error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_trip_id_id_uq" UNIQUE("trip_id","id"),
	CONSTRAINT "proposals_payload_size_ck" CHECK (pg_column_size("proposals"."payload") <= 32768),
	CONSTRAINT "proposals_message_ck" CHECK ("proposals"."message" is null or char_length("proposals"."message") <= 500),
	CONSTRAINT "proposals_note_ck" CHECK ("proposals"."review_note" is null or char_length("proposals"."review_note") <= 200),
	CONSTRAINT "proposals_color_ck" CHECK ("proposals"."author_color" between 0 and 7)
);
--> statement-breakpoint
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_target_ck";--> statement-breakpoint
ALTER TABLE "yjs_documents" DROP CONSTRAINT "yjs_documents_name_ck";--> statement-breakpoint
ALTER TABLE "trip_members" DROP CONSTRAINT "trip_members_status_ck";--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "expense_id" uuid;--> statement-breakpoint
ALTER TABLE "list_items" ADD COLUMN "due_kind" "due_kind" DEFAULT 'due' NOT NULL;--> statement-breakpoint
ALTER TABLE "list_items" ADD COLUMN "is_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "yjs_documents" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "activity_log" ADD COLUMN "version" bigint;--> statement-breakpoint
ALTER TABLE "activity_log" ADD COLUMN "meta" jsonb;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "fixed_date" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "trip_members" ADD COLUMN "budget_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "trip_seen" ADD CONSTRAINT "trip_seen_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_seen" ADD CONSTRAINT "trip_seen_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_prefs" ADD CONSTRAINT "user_prefs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_node_fk" FOREIGN KEY ("trip_id","node_id") REFERENCES "public"."nodes"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_member_fk" FOREIGN KEY ("trip_id","member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_fees" ADD CONSTRAINT "expense_fees_expense_fk" FOREIGN KEY ("trip_id","expense_id") REFERENCES "public"."expenses"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_line_members" ADD CONSTRAINT "expense_line_members_line_fk" FOREIGN KEY ("trip_id","line_id") REFERENCES "public"."expense_lines"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_line_members" ADD CONSTRAINT "expense_line_members_member_fk" FOREIGN KEY ("trip_id","member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_lines" ADD CONSTRAINT "expense_lines_expense_fk" FOREIGN KEY ("trip_id","expense_id") REFERENCES "public"."expenses"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payment_payers" ADD CONSTRAINT "expense_payment_payers_payment_fk" FOREIGN KEY ("trip_id","payment_id") REFERENCES "public"."expense_payments"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payment_payers" ADD CONSTRAINT "expense_payment_payers_member_fk" FOREIGN KEY ("trip_id","member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_expense_fk" FOREIGN KEY ("trip_id","expense_id") REFERENCES "public"."expenses"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_shares" ADD CONSTRAINT "expense_shares_expense_fk" FOREIGN KEY ("trip_id","expense_id") REFERENCES "public"."expenses"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_shares" ADD CONSTRAINT "expense_shares_member_fk" FOREIGN KEY ("trip_id","member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_refund_of_fk" FOREIGN KEY ("trip_id","refund_of_id") REFERENCES "public"."expenses"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_from_member_fk" FOREIGN KEY ("trip_id","from_member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_to_member_fk" FOREIGN KEY ("trip_id","to_member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trip_seen_user_idx" ON "trip_seen" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "budget_lines_member_idx" ON "budget_lines" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "expense_fees_expense_idx" ON "expense_fees" USING btree ("expense_id");--> statement-breakpoint
CREATE INDEX "expense_line_members_member_idx" ON "expense_line_members" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "expense_lines_expense_idx" ON "expense_lines" USING btree ("expense_id");--> statement-breakpoint
CREATE INDEX "expense_payment_payers_member_idx" ON "expense_payment_payers" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "expense_payments_expense_idx" ON "expense_payments" USING btree ("expense_id");--> statement-breakpoint
CREATE INDEX "expense_shares_member_idx" ON "expense_shares" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "expenses_trip_live_idx" ON "expenses" USING btree ("trip_id") WHERE "expenses"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "expenses_node_idx" ON "expenses" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "expenses_leg_idx" ON "expenses" USING btree ("leg_id");--> statement-breakpoint
CREATE INDEX "expenses_item_idx" ON "expenses" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "expenses_day_idx" ON "expenses" USING btree ("day_id");--> statement-breakpoint
CREATE INDEX "expenses_list_item_idx" ON "expenses" USING btree ("list_item_id");--> statement-breakpoint
CREATE INDEX "expenses_refund_of_idx" ON "expenses" USING btree ("refund_of_id");--> statement-breakpoint
CREATE INDEX "settlements_trip_live_idx" ON "settlements" USING btree ("trip_id") WHERE "settlements"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "proposals_trip_open_idx" ON "proposals" USING btree ("trip_id","created_at") WHERE "proposals"."status" = 'open';--> statement-breakpoint
CREATE INDEX "proposals_entity_idx" ON "proposals" USING btree ("trip_id","entity_kind","entity_id");--> statement-breakpoint
CREATE INDEX "proposals_created_ids_gin" ON "proposals" USING gin ("created_ids") WHERE "proposals"."status" = 'open';--> statement-breakpoint
CREATE INDEX "proposals_author_idx" ON "proposals" USING btree ("author_user_id");--> statement-breakpoint
ALTER TABLE "yjs_documents" ADD CONSTRAINT "yjs_documents_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_expense_idx" ON "attachments" USING btree ("expense_id");--> statement-breakpoint
CREATE INDEX "yjs_documents_owner_idx" ON "yjs_documents" USING btree ("owner_user_id") WHERE "yjs_documents"."owner_user_id" is not null;--> statement-breakpoint
CREATE INDEX "activity_trip_version_idx" ON "activity_log" USING btree ("trip_id","version");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_target_ck" CHECK (num_nonnulls("attachments"."node_id", "attachments"."leg_id", "attachments"."item_id", "attachments"."day_id", "attachments"."expense_id") <= 1);--> statement-breakpoint
ALTER TABLE "yjs_documents" ADD CONSTRAINT "yjs_documents_name_ck" CHECK ("yjs_documents"."name" = 'trip/' || "yjs_documents"."trip_id"::text || case
				when "yjs_documents"."node_id" is not null then '/node/' || "yjs_documents"."node_id"::text
				when "yjs_documents"."leg_id" is not null then '/leg/' || "yjs_documents"."leg_id"::text
				when "yjs_documents"."item_id" is not null then '/item/' || "yjs_documents"."item_id"::text
				when "yjs_documents"."day_id" is not null then '/day/' || "yjs_documents"."day_id"::text
				else '/root' end || case
				when "yjs_documents"."owner_user_id" is not null then '/u/' || "yjs_documents"."owner_user_id"
				else '' end);--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_status_ck" CHECK (("trip_members"."status" = 'active' and "trip_members"."user_id" is not null)
			or ("trip_members"."status" = 'invited' and "trip_members"."user_id" is null and "trip_members"."email" is not null)
			or ("trip_members"."status" = 'placeholder' and "trip_members"."user_id" is null)
			or ("trip_members"."status"::text = 'removed' and "trip_members"."user_id" is null and "trip_members"."display_name" is not null));