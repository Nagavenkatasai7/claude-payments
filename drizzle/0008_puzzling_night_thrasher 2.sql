CREATE TABLE "partner_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_request_id" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"documents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "partner_requests" ADD COLUMN "application_token_hash" text;--> statement-breakpoint
ALTER TABLE "partner_requests" ADD COLUMN "token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "partner_requests" ADD COLUMN "application_status" text DEFAULT 'invited' NOT NULL;--> statement-breakpoint
CREATE INDEX "partner_applications_request" ON "partner_applications" USING btree ("partner_request_id");