CREATE TABLE "partner_reward_terms" (
	"partner_id" text PRIMARY KEY NOT NULL,
	"platform_fee_usd" numeric(12, 2) DEFAULT '0.60' NOT NULL,
	"give_back_pct" numeric(5, 2) DEFAULT '40' NOT NULL,
	"monthly_budget_usd" numeric(12, 2) DEFAULT '0' NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_reward_terms_fee" CHECK ("partner_reward_terms"."platform_fee_usd" >= 0),
	CONSTRAINT "partner_reward_terms_pct" CHECK ("partner_reward_terms"."give_back_pct" BETWEEN 0 AND 100),
	CONSTRAINT "partner_reward_terms_budget" CHECK ("partner_reward_terms"."monthly_budget_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "partner_rewards" (
	"partner_id" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"nth" integer,
	"festival_name" text,
	"starts_on" date,
	"ends_on" date,
	"min_amount_usd" numeric(12, 2),
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_rewards_partner_id_kind_pk" PRIMARY KEY("partner_id","kind"),
	CONSTRAINT "partner_rewards_kind" CHECK ("partner_rewards"."kind" IN ('nth_transfer','festival'))
);
--> statement-breakpoint
CREATE TABLE "payees" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"legal_name" text NOT NULL,
	"account_holder_enc" text NOT NULL,
	"payout_destination_enc" text NOT NULL,
	"payout_last4" text NOT NULL,
	"country" text DEFAULT 'IN' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"screening" text NOT NULL,
	"created_by" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payees_status" CHECK ("payees"."status" IN ('pending','approved','rejected','suspended')),
	CONSTRAINT "payees_screening" CHECK ("payees"."screening" IN ('clear','review'))
);
--> statement-breakpoint
CREATE TABLE "payment_links" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"payee_id" text NOT NULL,
	"token" text NOT NULL,
	"reference" text NOT NULL,
	"customer_name_enc" text NOT NULL,
	"customer_phone" text NOT NULL,
	"amount_inr" numeric(14, 2) NOT NULL,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"transfer_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"used_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_links_status" CHECK ("payment_links"."status" IN ('open','used','cancelled','expired')),
	CONSTRAINT "payment_links_amount" CHECK ("payment_links"."amount_inr" > 0)
);
--> statement-breakpoint
CREATE TABLE "platform_fee_ledger" (
	"transfer_id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"month" text NOT NULL,
	"fee_usd" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_fee_ledger_fee" CHECK ("platform_fee_ledger"."fee_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "referral_attributions" (
	"partner_id" text NOT NULL,
	"phone" text NOT NULL,
	"referral_partner_id" text NOT NULL,
	"code" text NOT NULL,
	"channel" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_attributions_partner_id_phone_pk" PRIMARY KEY("partner_id","phone"),
	CONSTRAINT "referral_attributions_channel" CHECK ("referral_attributions"."channel" IN ('whatsapp','portal'))
);
--> statement-breakpoint
CREATE TABLE "referral_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"referral_partner_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_codes_format" CHECK ("referral_codes"."code" ~ '^REF-[A-Z0-9]{6}$')
);
--> statement-breakpoint
CREATE TABLE "referral_partners" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"contact" text DEFAULT '' NOT NULL,
	"commission_cents" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_partners_status" CHECK ("referral_partners"."status" IN ('active','inactive')),
	CONSTRAINT "referral_partners_commission" CHECK ("referral_partners"."commission_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "referral_program_settings" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"plum_portal_url" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_program_settings_singleton" CHECK ("referral_program_settings"."id" = 'global')
);
--> statement-breakpoint
CREATE TABLE "reward_catalog" (
	"kind" text PRIMARY KEY NOT NULL,
	"available" boolean DEFAULT false NOT NULL,
	"nth_min" integer DEFAULT 3 NOT NULL,
	"nth_max" integer DEFAULT 10 NOT NULL,
	"max_days" integer DEFAULT 14 NOT NULL,
	"max_discount_usd" numeric(12, 2) DEFAULT '2.99' NOT NULL,
	"customer_monthly_cap" integer DEFAULT 1 NOT NULL,
	"festival_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reward_catalog_kind" CHECK ("reward_catalog"."kind" IN ('nth_transfer','festival')),
	CONSTRAINT "reward_catalog_nth" CHECK ("reward_catalog"."nth_min" >= 2 AND "reward_catalog"."nth_max" >= "reward_catalog"."nth_min" AND "reward_catalog"."nth_max" <= 50),
	CONSTRAINT "reward_catalog_days" CHECK ("reward_catalog"."max_days" BETWEEN 1 AND 31),
	CONSTRAINT "reward_catalog_discount" CHECK ("reward_catalog"."max_discount_usd" >= 0),
	CONSTRAINT "reward_catalog_cap" CHECK ("reward_catalog"."customer_monthly_cap" BETWEEN 1 AND 31)
);
--> statement-breakpoint
CREATE TABLE "reward_redemptions" (
	"transfer_id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"phone" text NOT NULL,
	"kind" text NOT NULL,
	"month" text NOT NULL,
	"discount_usd" numeric(12, 2) NOT NULL,
	"give_back_usd" numeric(12, 2) DEFAULT '0' NOT NULL,
	"give_back_withheld" boolean DEFAULT false NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reward_redemptions_kind" CHECK ("reward_redemptions"."kind" IN ('first_transfer','nth_transfer','festival')),
	CONSTRAINT "reward_redemptions_amounts" CHECK ("reward_redemptions"."discount_usd" >= 0 AND "reward_redemptions"."give_back_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "client_reference" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "payout_reference" text;--> statement-breakpoint
ALTER TABLE "partner_reward_terms" ADD CONSTRAINT "partner_reward_terms_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_rewards" ADD CONSTRAINT "partner_rewards_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payees" ADD CONSTRAINT "payees_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_payee_id_payees_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_fee_ledger" ADD CONSTRAINT "platform_fee_ledger_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_fee_ledger" ADD CONSTRAINT "platform_fee_ledger_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_referral_partner_id_referral_partners_id_fk" FOREIGN KEY ("referral_partner_id") REFERENCES "public"."referral_partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_referral_partner_id_referral_partners_id_fk" FOREIGN KEY ("referral_partner_id") REFERENCES "public"."referral_partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_redemptions" ADD CONSTRAINT "reward_redemptions_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_redemptions" ADD CONSTRAINT "reward_redemptions_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payees_partner_created" ON "payees" USING btree ("partner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payees_status_created" ON "payees" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "payment_links_token" ON "payment_links" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_links_partner_reference" ON "payment_links" USING btree ("partner_id","reference");--> statement-breakpoint
CREATE INDEX "payment_links_partner_created" ON "payment_links" USING btree ("partner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_links_status_expires" ON "payment_links" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "platform_fee_ledger_partner_month" ON "platform_fee_ledger" USING btree ("partner_id","month");--> statement-breakpoint
CREATE INDEX "referral_attributions_partner" ON "referral_attributions" USING btree ("referral_partner_id");--> statement-breakpoint
CREATE INDEX "referral_codes_partner" ON "referral_codes" USING btree ("referral_partner_id");--> statement-breakpoint
CREATE INDEX "reward_redemptions_partner_month" ON "reward_redemptions" USING btree ("partner_id","month");--> statement-breakpoint
CREATE INDEX "reward_redemptions_sender_month" ON "reward_redemptions" USING btree ("partner_id","phone","month");