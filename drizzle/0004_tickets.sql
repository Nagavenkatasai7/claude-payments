CREATE TABLE "tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"kind" text DEFAULT 'customer' NOT NULL,
	"customer_phone" text DEFAULT '' NOT NULL,
	"opened_by" text,
	"transfer_id" text,
	"subject" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"category" text,
	"assigned_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "tickets_kind_check" CHECK ("kind" IN ('customer','internal')),
	CONSTRAINT "tickets_status_check" CHECK ("status" IN ('open','pending','waiting_admin','resolved','closed')),
	CONSTRAINT "tickets_priority_check" CHECK ("priority" IN ('low','normal','urgent'))
);
--> statement-breakpoint
CREATE TABLE "ticket_messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ticket_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ticket_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"body" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "support_config" jsonb;
--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "tickets_partner_status" ON "tickets" USING btree ("partner_id","status");
--> statement-breakpoint
CREATE INDEX "tickets_assigned_updated" ON "tickets" USING btree ("assigned_to","updated_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "tickets_customer_partner" ON "tickets" USING btree ("customer_phone","partner_id");
--> statement-breakpoint
CREATE INDEX "tickets_kind_status" ON "tickets" USING btree ("kind","status");
--> statement-breakpoint
CREATE INDEX "ticket_messages_ticket" ON "ticket_messages" USING btree ("ticket_id","created_at");
