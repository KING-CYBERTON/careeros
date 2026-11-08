-- CAREEROS P4-T02: discovery runs on the scheduler, AI match on the top N, review queue and accept. Everything below the
-- generated DDL is written by hand, following P4-T01 and P1-T07. Runs as the migration (owner) role. No new table is
-- created, so the three discovery tables keep the row-level security policies of P4-T01. Down migration: down.sql.
-- 0. The generated key to `application` is rewritten to clear only its own column when the application is deleted
-- (PostgreSQL 15+, never the tenant column) and to be DEFERRABLE INITIALLY DEFERRED: the guest move changes the
-- organization of one table at a time inside one transaction and the keys are checked when it commits.
ALTER TABLE "discovered_job" ADD COLUMN "application_id" text;--> statement-breakpoint
ALTER TABLE "discovered_job" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "discovery_run" ADD COLUMN "trigger" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_run" ADD COLUMN "ai_planned" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_run" ADD COLUMN "ai_skipped_reason" text;--> statement-breakpoint
ALTER TABLE "job_source" ADD COLUMN "last_scheduled_run_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "discovered_job_application_idx" ON "discovered_job" ("organization_id","application_id");--> statement-breakpoint
ALTER TABLE "discovered_job" ADD CONSTRAINT "discovered_job_org_application_fkey" FOREIGN KEY ("organization_id","application_id") REFERENCES "application"("organization_id","id") ON DELETE SET NULL ("application_id") DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "discovery_run" ADD CONSTRAINT "discovery_run_trigger_check" CHECK ("trigger" in ('manual', 'scheduled'));--> statement-breakpoint
ALTER TABLE "discovery_run" ADD CONSTRAINT "discovery_run_ai_skipped_reason_check" CHECK ("ai_skipped_reason" is null or "ai_skipped_reason" in ('no_platform_ai', 'quota_exhausted', 'provider_error'));--> statement-breakpoint
ALTER TABLE "discovery_run" ADD CONSTRAINT "discovery_run_ai_planned_check" CHECK ("ai_planned" >= 0 and "ai_matched" <= "ai_planned");--> statement-breakpoint
-- 1. The three composite keys of P4-T01 become DEFERRABLE INITIALLY DEFERRED for the same reason (the guest move).
-- Their referential actions (SET NULL on a deleted run or automation, CASCADE of runs) still fire at statement time.
ALTER TABLE "discovered_job" ALTER CONSTRAINT "discovered_job_org_job_source_fkey" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "discovered_job" ALTER CONSTRAINT "discovered_job_org_first_run_fkey" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "discovery_run" ALTER CONSTRAINT "discovery_run_org_job_source_fkey" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
-- 2. Automations that already exist (created by P4-T01 with no next run) get one, a full period from now plus up to 30
-- minutes of jitter, so they do not all fire at the same minute after the deploy. A paused one stays without.
UPDATE "job_source" SET "next_run_at" = now()
	+ (CASE "schedule" WHEN 'weekly' THEN interval '7 days' ELSE interval '1 day' END)
	+ (random() * interval '30 minutes')
	WHERE "schedule" <> 'paused' AND "next_run_at" IS NULL;--> statement-breakpoint
-- 3. The scheduler has no organization and row-level security hides every discovery row from it. Two definer functions
-- answer with ids only (never row data), as P1-T07 did for career jobs; everything else is read and written inside
-- withOrgContext, one source at a time.
--   careeros_due_discovery_sources: the (id, organization_id) of automations that are not paused and are due, oldest
--     due first, at most max_rows of them. The caller claims each one inside its organization (a conditional UPDATE
--     that moves next_run_at on, so two servers never run the same source).
--   careeros_orgs_with_stale_discovery_runs: organizations with a run still `running` after stale_after_minutes.
CREATE OR REPLACE FUNCTION public.careeros_due_discovery_sources(now timestamptz, max_rows integer)
RETURNS TABLE (id text, organization_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT s.id, s.organization_id FROM public.job_source s
	WHERE s.schedule <> 'paused' AND s.next_run_at IS NOT NULL AND s.next_run_at <= $1
	ORDER BY s.next_run_at, s.id
	LIMIT greatest($2, 0)
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.careeros_orgs_with_stale_discovery_runs(now timestamptz, stale_after_minutes integer)
RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT DISTINCT r.organization_id FROM public.discovery_run r
	WHERE r.status = 'running' AND r.started_at <= $1 - make_interval(mins => greatest($2, 0))
$$;--> statement-breakpoint
-- 4. Guest linking. careeros_move_guest_discovery(from_user, to_user, to_org) moves the guest's automations (with their
-- runs) and found jobs into the target user's organization, after the applications the jobs may point at (the same
-- checks as the other guest moves: the source must be an anonymous user and the target organization must have the
-- target user as a member). Notes:
--   - A user keeps at most 20 automations per organization (Q228). Only as many of the guest's automations as fit
--     (oldest first) move; the rest, with their runs, stay with the guest and go with the guest account.
--   - A job the target already has (same source and external id) is dropped from the guest's side: the target's row,
--     with its dismissed or accepted status, wins.
--   - A job whose automation or first run did not move loses that link (the job stays; a dismissal must outlive the
--     automation). A job's application link moves only when that application is now in the target organization.
--   - The composite keys are deferred, so the order of the updates inside the transaction does not matter.
CREATE OR REPLACE FUNCTION public.careeros_move_guest_discovery(from_user text, to_user text, to_org text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	room integer;
	moved text[];
BEGIN
	IF from_user = to_user THEN RETURN; END IF;
	IF to_org IS NULL THEN
		IF EXISTS (SELECT 1 FROM public.job_source WHERE user_id = from_user)
			OR EXISTS (SELECT 1 FROM public.discovered_job WHERE user_id = from_user) THEN
			RAISE EXCEPTION 'careeros_move_guest_discovery: the target user has no organization';
		END IF;
		RETURN;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public."user" WHERE id = from_user AND is_anonymous) THEN
		RAISE EXCEPTION 'careeros_move_guest_discovery: the source is not a guest account';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public.member WHERE organization_id = to_org AND user_id = to_user) THEN
		RAISE EXCEPTION 'careeros_move_guest_discovery: the target user is not a member of the target organization';
	END IF;

	SELECT greatest(20 - count(*), 0) INTO room FROM public.job_source WHERE organization_id = to_org AND user_id = to_user;
	SELECT coalesce(array_agg(id), ARRAY[]::text[]) INTO moved FROM (
		SELECT id FROM public.job_source WHERE user_id = from_user ORDER BY created_at, id LIMIT room
	) AS fits;

	-- Jobs first: drop what the target has, then re-link what stays. The unique key is not deferred, so the drop comes first.
	DELETE FROM public.discovered_job g WHERE g.user_id = from_user AND EXISTS (
		SELECT 1 FROM public.discovered_job t
		WHERE t.organization_id = to_org AND t.user_id = to_user AND t.source = g.source AND t.external_id = g.external_id);
	UPDATE public.discovered_job SET
		job_source_id = CASE WHEN job_source_id = ANY (moved) THEN job_source_id END,
		first_seen_run_id = CASE WHEN first_seen_run_id IN (
			SELECT r.id FROM public.discovery_run r WHERE r.job_source_id = ANY (moved)) THEN first_seen_run_id END,
		application_id = CASE WHEN application_id IN (
			SELECT a.id FROM public.application a WHERE a.organization_id = to_org) THEN application_id END,
		user_id = to_user, organization_id = to_org
		WHERE user_id = from_user;
	UPDATE public.discovery_run SET organization_id = to_org WHERE job_source_id = ANY (moved);
	UPDATE public.job_source SET user_id = to_user, organization_id = to_org WHERE id = ANY (moved);
END;
$$;--> statement-breakpoint
DO $$ BEGIN
	REVOKE ALL ON FUNCTION public.careeros_due_discovery_sources(timestamptz, integer) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_orgs_with_stale_discovery_runs(timestamptz, integer) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_move_guest_discovery(text, text, text) FROM PUBLIC;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'careeros_app') THEN
		GRANT EXECUTE ON FUNCTION public.careeros_due_discovery_sources(timestamptz, integer) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_orgs_with_stale_discovery_runs(timestamptz, integer) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_move_guest_discovery(text, text, text) TO careeros_app;
	END IF;
END $$;
