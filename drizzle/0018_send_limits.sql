ALTER TABLE "customers" ADD COLUMN "send_limit_override" jsonb;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "send_limits" jsonb;