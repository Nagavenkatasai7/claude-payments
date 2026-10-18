CREATE TABLE "agent_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"auth_method" text NOT NULL,
	"secret_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"phone" text NOT NULL,
	"client_id" text NOT NULL,
	"scopes" text[] NOT NULL,
	"refresh_hash" text,
	"prev_refresh_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);
--> statement-breakpoint
ALTER TABLE "agent_clients" ADD CONSTRAINT "agent_clients_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_client_id_agent_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."agent_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_clients_partner" ON "agent_clients" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "agent_grants_partner_phone" ON "agent_grants" USING btree ("partner_id","phone");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_grants_refresh_hash" ON "agent_grants" USING btree ("refresh_hash");--> statement-breakpoint
CREATE INDEX "agent_grants_prev_refresh_hash" ON "agent_grants" USING btree ("prev_refresh_hash");