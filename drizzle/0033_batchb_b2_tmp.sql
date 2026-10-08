CREATE TABLE "payees" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"legal_name" text NOT NULL,
	"account_holder_enc" text NOT NULL,
	"payout_destination_enc" text NOT NULL,
	"payout_last4" text NOT NULL,
	"country" text DEFAULT 'IN' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"screening" text NOT NULL,
	"created_by" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payees_status" CHECK ("payees"."status" IN ('pending','approved','rejected','suspended')),
	CONSTRAINT "payees_screening" CHECK ("payees"."screening" IN ('clear','review'))
);
--> statement-breakpoint
CREATE TABLE "payment_links" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"payee_id" text NOT NULL,
	"token" text NOT NULL,
	"reference" text NOT NULL,
	"customer_name_enc" text NOT NULL,
	"customer_phone" text NOT NULL,
	"amount_inr" numeric(14, 2) NOT NULL,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"transfer_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"used_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_links_status" CHECK ("payment_links"."status" IN ('open','used','cancelled','expired')),
	CONSTRAINT "payment_links_amount" CHECK ("payment_links"."amount_inr" > 0)
);
--> statement-breakpoint
ALTER TABLE "payees" ADD CONSTRAINT "payees_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_payee_id_payees_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payees_partner_created" ON "payees" USING btree ("partner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payees_status_created" ON "payees" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "payment_links_token" ON "payment_links" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_links_partner_reference" ON "payment_links" USING btree ("partner_id","reference");--> statement-breakpoint
CREATE INDEX "payment_links_partner_created" ON "payment_links" USING btree ("partner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_links_status_expires" ON "payment_links" USING btree ("status","expires_at");