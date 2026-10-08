CREATE TABLE "referral_attributions" (
	"partner_id" text NOT NULL,
	"phone" text NOT NULL,
	"referral_partner_id" text NOT NULL,
	"code" text NOT NULL,
	"channel" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_attributions_partner_id_phone_pk" PRIMARY KEY("partner_id","phone"),
	CONSTRAINT "referral_attributions_channel" CHECK ("referral_attributions"."channel" IN ('whatsapp','portal'))
);
--> statement-breakpoint
CREATE TABLE "referral_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"referral_partner_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_codes_format" CHECK ("referral_codes"."code" ~ '^REF-[A-Z0-9]{6}$')
);
--> statement-breakpoint
CREATE TABLE "referral_partners" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"contact" text DEFAULT '' NOT NULL,
	"commission_cents" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_partners_status" CHECK ("referral_partners"."status" IN ('active','inactive')),
	CONSTRAINT "referral_partners_commission" CHECK ("referral_partners"."commission_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "referral_program_settings" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"plum_portal_url" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_program_settings_singleton" CHECK ("referral_program_settings"."id" = 'global')
);
--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_referral_partner_id_referral_partners_id_fk" FOREIGN KEY ("referral_partner_id") REFERENCES "public"."referral_partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_referral_partner_id_referral_partners_id_fk" FOREIGN KEY ("referral_partner_id") REFERENCES "public"."referral_partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "referral_attributions_partner" ON "referral_attributions" USING btree ("referral_partner_id");--> statement-breakpoint
CREATE INDEX "referral_codes_partner" ON "referral_codes" USING btree ("referral_partner_id");