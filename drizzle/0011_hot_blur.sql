CREATE TABLE "sellers" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"phone" text NOT NULL,
	"business_name" text NOT NULL,
	"country" text NOT NULL,
	"currency" text NOT NULL,
	"payout_destination_enc" text,
	"payout_last4" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"kyc_review_state" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sellers_status_check" CHECK ("sellers"."status" IN ('pending','active','suspended'))
);
--> statement-breakpoint
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sellers_partner_phone" ON "sellers" USING btree ("partner_id","phone");--> statement-breakpoint
CREATE INDEX "sellers_partner_created" ON "sellers" USING btree ("partner_id","created_at" DESC NULLS LAST);