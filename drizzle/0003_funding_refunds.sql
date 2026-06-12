ALTER TABLE "transfers" ADD COLUMN "funding_ref" text;
--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "refund_ref" text;
--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "refund_status" text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "refunded_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_refund_status_check" CHECK ("refund_status" IN ('none','requested','pending','completed','failed'));
--> statement-breakpoint
CREATE INDEX "transfers_refund_status" ON "transfers" USING btree ("refund_status") WHERE "refund_status" <> 'none';
