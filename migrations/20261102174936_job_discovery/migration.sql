-- CAREEROS P4-T01: job discovery (GTM-PLAN G1 to G4). The three tables below are tenant tables. Everything under the
-- generated DDL is written by hand, following P1-T06 and P2-T01. Runs as the migration (owner) role. Down migration:
-- down.sql in this folder.
-- 0. The two SET NULL keys clear only their own id column (PostgreSQL 15+), never the tenant column: deleting an
-- automation keeps its postings (a dismissal must outlive it), and deleting a run keeps the postings it found.
CREATE TABLE "discovered_job" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"job_source_id" text,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"board_token" text NOT NULL,
	"title" text NOT NULL,
	"company" text NOT NULL,
	"location" text,
	"remote" text,
	"url" text NOT NULL,
	"posted_at" timestamp with time zone,
	"description_html" text DEFAULT '' NOT NULL,
	"local_score" numeric(5,2) NOT NULL,
	"ai_score" numeric(5,2),
	"ai_summary" text,
	"status" text DEFAULT 'new' NOT NULL,
	"first_seen_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discovered_job_owner_posting_key" UNIQUE("organization_id","user_id","source","external_id"),
	CONSTRAINT "discovered_job_source_check" CHECK ("source" in ('greenhouse', 'lever', 'lever_eu', 'ashby')),
	CONSTRAINT "discovered_job_remote_check" CHECK ("remote" is null or "remote" in ('remote', 'onsite', 'hybrid')),
	CONSTRAINT "discovered_job_status_check" CHECK ("status" in ('new', 'accepted', 'dismissed')),
	CONSTRAINT "discovered_job_url_check" CHECK ("url" like 'https://%'),
	CONSTRAINT "discovered_job_scores_check" CHECK ("local_score" between 0 and 100 and ("ai_score" is null or "ai_score" between 0 and 100)),
	CONSTRAINT "discovered_job_text_check" CHECK (char_length("title") <= 300 and char_length("company") <= 300)
);
--> statement-breakpoint
CREATE TABLE "discovery_run" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"job_source_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"fetched" integer DEFAULT 0 NOT NULL,
	"new" integer DEFAULT 0 NOT NULL,
	"duplicate" integer DEFAULT 0 NOT NULL,
	"scored" integer DEFAULT 0 NOT NULL,
	"ai_matched" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]' NOT NULL,
	CONSTRAINT "discovery_run_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "discovery_run_status_check" CHECK ("status" in ('running', 'succeeded', 'failed', 'partial')),
	CONSTRAINT "discovery_run_counts_check" CHECK ("fetched" >= 0 and "new" >= 0 and "duplicate" >= 0 and "scored" >= 0 and "ai_matched" >= 0)
);
--> statement-breakpoint
CREATE TABLE "job_source" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"titles" text[] DEFAULT '{}'::text[] NOT NULL,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"locations" text[] DEFAULT '{}'::text[] NOT NULL,
	"remote" text DEFAULT 'any' NOT NULL,
	"boards" jsonb DEFAULT '[]' NOT NULL,
	"schedule" text DEFAULT 'daily' NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"ai_top_n" integer DEFAULT 10 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_source_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "job_source_owner_id_unique" UNIQUE("organization_id","user_id","id"),
	CONSTRAINT "job_source_name_check" CHECK (char_length("name") between 1 and 120),
	CONSTRAINT "job_source_remote_check" CHECK ("remote" in ('any', 'remote', 'onsite', 'hybrid')),
	CONSTRAINT "job_source_schedule_check" CHECK ("schedule" in ('daily', 'weekly', 'paused')),
	CONSTRAINT "job_source_ai_top_n_check" CHECK ("ai_top_n" between 0 and 50),
	CONSTRAINT "job_source_boards_check" CHECK (jsonb_typeof("boards") = 'array' and jsonb_array_length("boards") <= 100),
	CONSTRAINT "job_source_lists_check" CHECK (cardinality("titles") <= 50 and cardinality("skills") <= 50 and cardinality("keywords") <= 50 and cardinality("locations") <= 50)
);
--> statement-breakpoint
CREATE INDEX "discovered_job_queue_idx" ON "discovered_job" ("organization_id","user_id","status","local_score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "discovery_run_source_started_idx" ON "discovery_run" ("organization_id","job_source_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "job_source_org_user_idx" ON "job_source" ("organization_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "job_source_due_idx" ON "job_source" ("schedule","next_run_at");--> statement-breakpoint
ALTER TABLE "discovered_job" ADD CONSTRAINT "discovered_job_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "discovered_job" ADD CONSTRAINT "discovered_job_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "discovered_job" ADD CONSTRAINT "discovered_job_org_job_source_fkey" FOREIGN KEY ("organization_id","user_id","job_source_id") REFERENCES "job_source"("organization_id","user_id","id") ON DELETE SET NULL ("job_source_id");--> statement-breakpoint
ALTER TABLE "discovered_job" ADD CONSTRAINT "discovered_job_org_first_run_fkey" FOREIGN KEY ("organization_id","first_seen_run_id") REFERENCES "discovery_run"("organization_id","id") ON DELETE SET NULL ("first_seen_run_id");--> statement-breakpoint
ALTER TABLE "discovery_run" ADD CONSTRAINT "discovery_run_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "discovery_run" ADD CONSTRAINT "discovery_run_org_job_source_fkey" FOREIGN KEY ("organization_id","job_source_id") REFERENCES "job_source"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "job_source" ADD CONSTRAINT "job_source_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "job_source" ADD CONSTRAINT "job_source_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
-- 1. Row-level security (D4), exactly as P1-T04: FORCE applies the policy to the table owner too, so only owner_access
-- lets the owner role (migrations, definer functions) see every organization. careeros_app only matches its own
-- organization; an unset setting is NULL and matches nothing (fail closed).
ALTER TABLE "job_source" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_source" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "job_source";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "job_source"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "job_source";--> statement-breakpoint
CREATE POLICY "owner_access" ON "job_source" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "discovery_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "discovery_run" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "discovery_run";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "discovery_run"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "discovery_run";--> statement-breakpoint
CREATE POLICY "owner_access" ON "discovery_run" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "discovered_job" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "discovered_job" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "discovered_job";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "discovered_job"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "discovered_job";--> statement-breakpoint
CREATE POLICY "owner_access" ON "discovered_job" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
-- 2. Table privileges for the app role. The bootstrap's default privileges already cover tables the owner creates;
-- this grant makes the migration correct on a database where the roles were created differently. Idempotent.
DO $$ BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'careeros_app') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON "job_source", "discovery_run", "discovered_job" TO careeros_app;
	END IF;
END $$;
