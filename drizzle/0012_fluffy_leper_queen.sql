ALTER TABLE "b2b_invoices" ADD COLUMN "seller_id" text;--> statement-breakpoint
ALTER TABLE "b2b_invoices" ADD COLUMN "invoiced_amount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "b2b_invoices" ADD COLUMN "invoiced_currency" text;--> statement-breakpoint
ALTER TABLE "b2b_invoices" ADD CONSTRAINT "b2b_invoices_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;