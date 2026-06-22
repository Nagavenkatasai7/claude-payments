CREATE TABLE "partner_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"company_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"corridors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"comments" text,
	"captured_at" timestamp with time zone NOT NULL
);
