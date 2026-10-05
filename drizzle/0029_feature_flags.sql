-- 0029 — Release safety Batch 2 part A: the feature_flags table (flags and kill switches).
--   One row per (key, scope). scope_type 'global' (scope_id ''), 'partner' or 'corridor'
--   (destination country code). Read by src/lib/flags.ts; written only by the platform-admin
--   switch action on /admin-dashboard/switches, with a flag.change audit row in the same transaction.
--
-- NEW TABLE ONLY: no existing table is altered, so every explicit column list keeps its shape.
-- SAFE FOR BOTH BUILDS: the previous build never reads or writes this table. With no rows, every
-- flag reads as off, which is today's behaviour. No FK to partners, so this table never blocks a
-- partner erasure.
--
-- Apply with /migrate-prod FROM THE PR BRANCH before the merge (CI's migration safety job stays
-- red until it is applied).
--
-- Rollback (only while no build that reads it is live): DROP TABLE "feature_flags";
CREATE TABLE "feature_flags" (
	"key" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"reason" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flags_key_scope_type_scope_id_pk" PRIMARY KEY("key","scope_type","scope_id"),
	CONSTRAINT "feature_flags_scope_type" CHECK ("feature_flags"."scope_type" IN ('global','partner','corridor')),
	CONSTRAINT "feature_flags_global_scope_id" CHECK ("feature_flags"."scope_type" <> 'global' OR "feature_flags"."scope_id" = '')
);
