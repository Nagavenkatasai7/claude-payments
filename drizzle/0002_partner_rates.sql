CREATE TABLE "partner_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"source_currency" text NOT NULL,
	"destination_currency" text NOT NULL,
	"effective_rate" numeric(14, 6),
	"expires_at" timestamp with time zone,
	"pushed_at" timestamp with time zone,
	"margin_bps" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "settlement_partner_id" text;
--> statement-breakpoint
ALTER TABLE "partner_rates" ADD CONSTRAINT "partner_rates_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_settlement_partner_id_partners_id_fk" FOREIGN KEY ("settlement_partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "partner_rates_corridor" ON "partner_rates" USING btree ("partner_id","source_currency","destination_currency");
--> statement-breakpoint
CREATE INDEX "partner_rates_pair" ON "partner_rates" USING btree ("source_currency","destination_currency");
