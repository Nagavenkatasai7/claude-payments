ALTER TABLE "outbox" ADD COLUMN "lease_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "lease_owner" text;
--> statement-breakpoint
DROP INDEX "outbox_drain";
--> statement-breakpoint
CREATE INDEX "outbox_drain" ON "outbox" USING btree ("status","next_attempt_at") WHERE "outbox"."status" IN ('pending','failed','processing');
--> statement-breakpoint
CREATE INDEX "outbox_lease" ON "outbox" USING btree ("lease_until") WHERE "outbox"."status" = 'processing';
--> statement-breakpoint
UPDATE "outbox" SET "lease_until" = coalesce("locked_at", now()) + interval '5 minutes', "lease_owner" = "locked_by" WHERE "status" = 'processing';
