CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"label" text,
	"last4" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"partner_id" text,
	"actor" text NOT NULL,
	"actor_type" text NOT NULL,
	"action" text NOT NULL,
	"subject_id" text,
	"meta" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "beneficiaries" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"name" text NOT NULL,
	"country" text NOT NULL,
	"payout_method" text NOT NULL,
	"payout_destination_enc" text NOT NULL,
	"payout_destination_last4" text DEFAULT '' NOT NULL,
	"recipient_phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corridor_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"sender_phone" text NOT NULL,
	"destination_country" text NOT NULL,
	"approx_amount" numeric(12, 2),
	"approx_currency" text,
	"captured_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"phone" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"sender_country" text NOT NULL,
	"kyc_status" text DEFAULT 'not_started' NOT NULL,
	"kyc_review_state" text,
	"kyc_inquiry_id" text,
	"kyc_provider_ref" text,
	"kyc_rejected_reason" text,
	"kyc_verified_at" timestamp with time zone,
	"kyc_submitted_at" timestamp with time zone,
	"kyc_approved_by" text,
	"kyc_approved_at" timestamp with time zone,
	"kyc_rejected_at" timestamp with time zone,
	"full_name_enc" text,
	"date_of_birth_enc" text,
	"residential_address_enc" text,
	"email_enc" text,
	"gov_id_number_enc" text,
	"gov_id_type" text,
	"id_last4" text,
	"id_doc_type" text,
	"nationality" text,
	"pep_declared" boolean,
	"watchlist_hit" boolean,
	"pep_hit" boolean,
	"source_of_funds" text,
	"occupation" text,
	"edd_captured_at" timestamp with time zone,
	"last_funding_method" text,
	"last_funding_method_at" timestamp with time zone,
	"password_hash" text,
	"password_updated_at" timestamp with time zone,
	"phone_verified_at" timestamp with time zone,
	"opt_in_at" timestamp with time zone,
	"opted_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"partner_id" text NOT NULL,
	"key" text NOT NULL,
	"transfer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_partner_id_key_pk" PRIMARY KEY("partner_id","key")
);
--> statement-breakpoint
CREATE TABLE "kyc_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"phone" text NOT NULL,
	"state" text NOT NULL,
	"provider_ref" text,
	"notes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_integrations" (
	"partner_id" text PRIMARY KEY NOT NULL,
	"kyc_provider_type" text,
	"kyc_api_key_enc" text,
	"kyc_webhook_secret_enc" text,
	"payment_provider_type" text,
	"payment_credentials_enc" text,
	"payment_webhook_secret_enc" text,
	"wa_phone_number_id" text,
	"wa_token_enc" text,
	"wa_verify_token_enc" text,
	"wa_app_secret_enc" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partners" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"countries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"brand_name" text,
	"display_name" text,
	"primary_color" text,
	"logo_url" text,
	"support_contact" text,
	"bot_persona" text,
	"admin_note" text,
	"kyc_mode" text DEFAULT 'ours' NOT NULL,
	"require_kyc_before_send" boolean,
	"corridor_compliance" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipients" (
	"sender_phone" text NOT NULL,
	"recipient_phone" text NOT NULL,
	"name" text NOT NULL,
	"payout_method" text NOT NULL,
	"payout_destination_enc" text NOT NULL,
	"payout_destination_last4" text DEFAULT '' NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL,
	CONSTRAINT "recipients_sender_phone_recipient_phone_pk" PRIMARY KEY("sender_phone","recipient_phone")
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"phone" text NOT NULL,
	"amount_usd" numeric(12, 2) NOT NULL,
	"amount_source" numeric(12, 2) NOT NULL,
	"source_currency" text NOT NULL,
	"recipient_name" text NOT NULL,
	"recipient_phone" text NOT NULL,
	"payout_method" text NOT NULL,
	"payout_destination_enc" text DEFAULT '' NOT NULL,
	"payout_destination_last4" text DEFAULT '' NOT NULL,
	"funding_method" text NOT NULL,
	"frequency" text NOT NULL,
	"day_of_month" integer,
	"day_of_week" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"end_date" date,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"phone" text NOT NULL,
	"status" text NOT NULL,
	"compliance_status" text NOT NULL,
	"compliance_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"amount_usd" numeric(12, 2) NOT NULL,
	"fee_usd" numeric(12, 2) NOT NULL,
	"total_charge_usd" numeric(12, 2) NOT NULL,
	"amount_source" numeric(12, 2) NOT NULL,
	"fee_source" numeric(12, 2) NOT NULL,
	"total_charge_source" numeric(12, 2) NOT NULL,
	"fx_rate" numeric(14, 6) NOT NULL,
	"amount_dest" numeric(14, 2) NOT NULL,
	"source_country" text NOT NULL,
	"source_currency" text NOT NULL,
	"destination_country" text NOT NULL,
	"destination_currency" text NOT NULL,
	"recipient_name" text NOT NULL,
	"recipient_phone" text DEFAULT '' NOT NULL,
	"payout_method" text NOT NULL,
	"payout_destination_enc" text DEFAULT '' NOT NULL,
	"payout_destination_last4" text DEFAULT '' NOT NULL,
	"funding_method" text NOT NULL,
	"payment_provider_ref" text,
	"recipient_legal_name_enc" text,
	"relationship" text,
	"purpose" text,
	"edd_required" boolean,
	"assigned_to" text,
	"admin_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "transfers_status_check" CHECK ("transfers"."status" IN ('awaiting_payment','paid','in_review','delivered','cancelled','blocked'))
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beneficiaries" ADD CONSTRAINT "beneficiaries_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_integrations" ADD CONSTRAINT "partner_integrations_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_partner" ON "api_keys" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "audit_partner_at" ON "audit_events" USING btree ("partner_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "beneficiaries_partner" ON "beneficiaries" USING btree ("partner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "customers_partner_created" ON "customers" USING btree ("partner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "kyc_cases_state" ON "kyc_cases" USING btree ("state","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_dedupe" ON "outbox" USING btree ("dedupe_key") WHERE "outbox"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "outbox_drain" ON "outbox" USING btree ("status","next_attempt_at") WHERE "outbox"."status" IN ('pending','failed');--> statement-breakpoint
CREATE INDEX "schedules_status" ON "schedules" USING btree ("status","frequency");--> statement-breakpoint
CREATE INDEX "transfers_partner_created" ON "transfers" USING btree ("partner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transfers_phone_created" ON "transfers" USING btree ("phone","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transfers_status_paid" ON "transfers" USING btree ("status","paid_at");--> statement-breakpoint
CREATE INDEX "transfers_provider_ref" ON "transfers" USING btree ("payment_provider_ref");