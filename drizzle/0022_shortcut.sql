-- The iPhone Shortcut "Save to Yonder": Better Auth API keys (a phone's key, a
-- one-time setup code) and the links the Shortcut sent, waiting for the app.
CREATE TABLE "apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"reference_id" text NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer DEFAULT 86400000,
	"rate_limit_max" integer DEFAULT 10,
	"request_count" integer DEFAULT 0,
	"remaining" integer,
	"last_request" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "shortcut_shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"device_id" text,
	"url" text,
	"text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shortcut_shares_size_ck" CHECK (char_length(coalesce("shortcut_shares"."url", '')) <= 2000 and char_length(coalesce("shortcut_shares"."text", '')) <= 2000)
);
--> statement-breakpoint
ALTER TABLE "shortcut_shares" ADD CONSTRAINT "shortcut_shares_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortcut_shares" ADD CONSTRAINT "shortcut_shares_device_id_apikey_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."apikey"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apikey_configId_idx" ON "apikey" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "apikey_referenceId_idx" ON "apikey" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "apikey_key_idx" ON "apikey" USING btree ("key");--> statement-breakpoint
CREATE INDEX "shortcut_shares_user_idx" ON "shortcut_shares" USING btree ("user_id","created_at");--> statement-breakpoint
-- A Shortcut key goes with its account (Better Auth's table has no foreign key).
ALTER TABLE "apikey" ADD CONSTRAINT "apikey_reference_id_user_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."user"("id") ON DELETE cascade;
