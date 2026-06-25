CREATE TABLE "b2b_invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"business_name" text NOT NULL,
	"buyer_phone" text NOT NULL,
	"line_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"amount_usd" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" text DEFAULT 'unpaid' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "b2b_invoices_status_check" CHECK ("b2b_invoices"."status" IN ('unpaid','paid'))
);
--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "transfer_type" text DEFAULT 'b2c' NOT NULL;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "sender_entity_type" text DEFAULT 'individual' NOT NULL;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "recipient_entity_type" text DEFAULT 'individual' NOT NULL;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "sender_business_name_enc" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "sender_business_name_last4" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "recipient_business_name_enc" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "recipient_business_name_last4" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "ach_token_ref" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "invoice_id" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "kyb_review_notes" text;--> statement-breakpoint
ALTER TABLE "b2b_invoices" ADD CONSTRAINT "b2b_invoices_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "b2b_invoices_buyer" ON "b2b_invoices" USING btree ("buyer_phone","status");--> statement-breakpoint
CREATE INDEX "b2b_invoices_partner" ON "b2b_invoices" USING btree ("partner_id","created_at" DESC NULLS LAST);