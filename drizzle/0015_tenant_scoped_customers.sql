ALTER TABLE "customers" DROP CONSTRAINT "customers_pkey";--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_partner_id_phone_pk" PRIMARY KEY("partner_id","phone");--> statement-breakpoint
CREATE INDEX "customers_phone" ON "customers" USING btree ("phone");--> statement-breakpoint
ALTER TABLE "recipients" ADD COLUMN "partner_id" text;--> statement-breakpoint
UPDATE "recipients" r SET "partner_id" = COALESCE((SELECT t."partner_id" FROM "transfers" t WHERE t."phone" = r."sender_phone" AND t."recipient_phone" = r."recipient_phone" ORDER BY t."created_at" DESC LIMIT 1), (SELECT c."partner_id" FROM "customers" c WHERE c."phone" = r."sender_phone" ORDER BY c."created_at" LIMIT 1), 'default');--> statement-breakpoint
ALTER TABLE "recipients" ALTER COLUMN "partner_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "recipients" DROP CONSTRAINT "recipients_sender_phone_recipient_phone_pk";--> statement-breakpoint
ALTER TABLE "recipients" ADD CONSTRAINT "recipients_partner_id_sender_phone_recipient_phone_pk" PRIMARY KEY("partner_id","sender_phone","recipient_phone");--> statement-breakpoint
ALTER TABLE "recipients" ADD CONSTRAINT "recipients_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "partner_integrations_wa_pnid" ON "partner_integrations" USING btree ("wa_phone_number_id") WHERE "partner_integrations"."wa_phone_number_id" IS NOT NULL;
