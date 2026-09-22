CREATE TABLE "waitlist_signups" (
	"id" text PRIMARY KEY NOT NULL,
	"full_name_enc" text NOT NULL,
	"email_enc" text NOT NULL,
	"phone_enc" text NOT NULL,
	"location_enc" text NOT NULL,
	"email_bidx" text NOT NULL,
	"phone_bidx" text NOT NULL,
	"name_initial" text NOT NULL,
	"email_masked" text NOT NULL,
	"phone_last4" text NOT NULL,
	"destinations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"consent_at" timestamp with time zone NOT NULL,
	"consent_text_version" text NOT NULL,
	"utm_source" text,
	"utm_campaign" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "partner_requests" ADD COLUMN "partner_type" text;--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_signups_email_bidx" ON "waitlist_signups" USING btree ("email_bidx");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_signups_phone_bidx" ON "waitlist_signups" USING btree ("phone_bidx");--> statement-breakpoint
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_partner_type_check" CHECK ("partner_requests"."partner_type" IN ('referral','business','licensed_mt'));