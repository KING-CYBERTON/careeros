-- CAREEROS P1-T07: the eleven career tables get organization_id, a backfill, organization-led keys (D11) and
-- row-level security (D4), following P1-T04 to P1-T06. career_workspace stays keyed by application_id and gets a
-- composite foreign key that forces its organization to equal its application's. The scheduler functions of P1-T06
-- are replaced by per-organization list functions (D9), and the guest move covers the career tables. Every statement is
-- idempotent so the migration can run twice. Runs as the migration (owner) role. Down migration: down.sql here.
--> statement-breakpoint
-- 1. D7 safety net: a user with career data but no membership (T04 backfilled everyone that existed then, and sign-up
-- makes an organization since T03) still gets a personal organization, so the NOT NULL below cannot fail. Same ids and
-- marker as the T04 backfill, so a second run (or T04's, T05's or T06's) finds them.
INSERT INTO "organization" ("id", "name", "slug", "metadata")
SELECT
	'bf_' || md5(u."id"),
	CASE WHEN coalesce(nullif(btrim(u."name"), ''), nullif(btrim(u."username"), '')) IS NULL THEN 'Personal workspace'
		ELSE left(coalesce(nullif(btrim(u."name"), ''), nullif(btrim(u."username"), '')) || '''s workspace', 100) END,
	'u-' || right(md5(u."id"), 16),
	'{"careeros_backfill":true}'
FROM "user" u
WHERE NOT EXISTS (SELECT 1 FROM "member" m WHERE m."user_id" = u."id")
	AND (EXISTS (SELECT 1 FROM "career_profile" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "career_fact" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "career_story" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "career_artifact" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "career_schedule" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "career_job" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "career_notification" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "career_opportunity" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "career_workspace" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "career_transcript" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "career_answer" x WHERE x."user_id" = u."id"))
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "member" ("id", "organization_id", "user_id", "role")
SELECT 'bf_' || md5(u."id"), 'bf_' || md5(u."id"), u."id", 'owner'
FROM "user" u
WHERE NOT EXISTS (SELECT 1 FROM "member" m WHERE m."user_id" = u."id")
	AND (EXISTS (SELECT 1 FROM "career_profile" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "career_fact" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "career_story" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "career_artifact" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "career_schedule" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "career_job" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "career_notification" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "career_opportunity" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "career_workspace" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "career_transcript" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "career_answer" x WHERE x."user_id" = u."id"))
	AND EXISTS (SELECT 1 FROM "organization" o WHERE o."id" = 'bf_' || md5(u."id"))
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 2. organization_id: nullable first, backfilled, then NOT NULL with its foreign key. A row linked to an application
-- (or, for a job, to a schedule that has one; for an artifact, to a job that has one) takes that application's
-- organization; every other row takes the owner's oldest membership (the T04 resume rule). Schedules go first because
-- jobs read theirs, and jobs before artifacts for the same reason.
ALTER TABLE "career_profile" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "career_fact" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "career_story" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "career_artifact" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "career_schedule" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "career_job" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "career_notification" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "career_opportunity" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "career_workspace" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "career_transcript" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "career_answer" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
UPDATE "career_schedule" t SET "organization_id" = coalesce(
	(SELECT a."organization_id" FROM "application" a WHERE a."id" = t."application_id"),
	(SELECT m."organization_id" FROM "member" m WHERE m."user_id" = t."user_id" ORDER BY m."created_at", m."id" LIMIT 1)
) WHERE t."organization_id" IS NULL;--> statement-breakpoint
UPDATE "career_job" t SET "organization_id" = coalesce(
	(SELECT s."organization_id" FROM "career_schedule" s WHERE s."id" = t."schedule_id"),
	(SELECT m."organization_id" FROM "member" m WHERE m."user_id" = t."user_id" ORDER BY m."created_at", m."id" LIMIT 1)
) WHERE t."organization_id" IS NULL;--> statement-breakpoint
UPDATE "career_artifact" t SET "organization_id" = coalesce(
	(SELECT a."organization_id" FROM "application" a WHERE a."id" = t."application_id"),
	(SELECT j."organization_id" FROM "career_job" j WHERE j."id" = t."job_id"),
	(SELECT m."organization_id" FROM "member" m WHERE m."user_id" = t."user_id" ORDER BY m."created_at", m."id" LIMIT 1)
) WHERE t."organization_id" IS NULL;--> statement-breakpoint
UPDATE "career_fact" t SET "organization_id" = coalesce(
	(SELECT a."organization_id" FROM "application" a WHERE a."id" = t."application_id"),
	(SELECT m."organization_id" FROM "member" m WHERE m."user_id" = t."user_id" ORDER BY m."created_at", m."id" LIMIT 1)
) WHERE t."organization_id" IS NULL;--> statement-breakpoint
UPDATE "career_story" t SET "organization_id" = coalesce(
	(SELECT a."organization_id" FROM "application" a WHERE a."id" = t."application_id"),
	(SELECT m."organization_id" FROM "member" m WHERE m."user_id" = t."user_id" ORDER BY m."created_at", m."id" LIMIT 1)
) WHERE t."organization_id" IS NULL;--> statement-breakpoint
UPDATE "career_notification" t SET "organization_id" = coalesce(
	(SELECT a."organization_id" FROM "application" a WHERE a."id" = t."application_id"),
	(SELECT m."organization_id" FROM "member" m WHERE m."user_id" = t."user_id" ORDER BY m."created_at", m."id" LIMIT 1)
) WHERE t."organization_id" IS NULL;--> statement-breakpoint
UPDATE "career_transcript" t SET "organization_id" = coalesce(
	(SELECT a."organization_id" FROM "application" a WHERE a."id" = t."application_id"),
	(SELECT m."organization_id" FROM "member" m WHERE m."user_id" = t."user_id" ORDER BY m."created_at", m."id" LIMIT 1)
) WHERE t."organization_id" IS NULL;--> statement-breakpoint
UPDATE "career_workspace" t SET "organization_id" = coalesce(
	(SELECT a."organization_id" FROM "application" a WHERE a."id" = t."application_id"),
	(SELECT m."organization_id" FROM "member" m WHERE m."user_id" = t."user_id" ORDER BY m."created_at", m."id" LIMIT 1)
) WHERE t."organization_id" IS NULL;--> statement-breakpoint
UPDATE "career_opportunity" t SET "organization_id" = coalesce(
	(SELECT a."organization_id" FROM "application" a WHERE a."id" = t."tracked_application_id"),
	(SELECT m."organization_id" FROM "member" m WHERE m."user_id" = t."user_id" ORDER BY m."created_at", m."id" LIMIT 1)
) WHERE t."organization_id" IS NULL;--> statement-breakpoint
UPDATE "career_answer" t SET "organization_id" = coalesce(
	(SELECT a."organization_id" FROM "application" a WHERE a."id" = t."application_id"),
	(SELECT a."organization_id" FROM "application" a WHERE a."id" = t."source_application_id"),
	(SELECT m."organization_id" FROM "member" m WHERE m."user_id" = t."user_id" ORDER BY m."created_at", m."id" LIMIT 1)
) WHERE t."organization_id" IS NULL;--> statement-breakpoint
UPDATE "career_profile" t SET "organization_id" = coalesce(
	(SELECT m."organization_id" FROM "member" m WHERE m."user_id" = t."user_id" ORDER BY m."created_at", m."id" LIMIT 1)
) WHERE t."organization_id" IS NULL;--> statement-breakpoint
ALTER TABLE "career_profile" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "career_fact" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "career_story" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "career_artifact" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "career_schedule" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "career_job" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "career_notification" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "career_opportunity" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "career_workspace" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "career_transcript" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "career_answer" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'career_profile_organization_id_organization_id_fkey' AND conrelid = '"career_profile"'::regclass) THEN
		ALTER TABLE "career_profile" ADD CONSTRAINT "career_profile_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'career_fact_organization_id_organization_id_fkey' AND conrelid = '"career_fact"'::regclass) THEN
		ALTER TABLE "career_fact" ADD CONSTRAINT "career_fact_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'career_story_organization_id_organization_id_fkey' AND conrelid = '"career_story"'::regclass) THEN
		ALTER TABLE "career_story" ADD CONSTRAINT "career_story_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'career_artifact_organization_id_organization_id_fkey' AND conrelid = '"career_artifact"'::regclass) THEN
		ALTER TABLE "career_artifact" ADD CONSTRAINT "career_artifact_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'career_schedule_organization_id_organization_id_fkey' AND conrelid = '"career_schedule"'::regclass) THEN
		ALTER TABLE "career_schedule" ADD CONSTRAINT "career_schedule_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'career_job_organization_id_organization_id_fkey' AND conrelid = '"career_job"'::regclass) THEN
		ALTER TABLE "career_job" ADD CONSTRAINT "career_job_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'career_notification_organization_id_organization_id_fkey' AND conrelid = '"career_notification"'::regclass) THEN
		ALTER TABLE "career_notification" ADD CONSTRAINT "career_notification_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'career_opportunity_organization_id_organization_id_fkey' AND conrelid = '"career_opportunity"'::regclass) THEN
		ALTER TABLE "career_opportunity" ADD CONSTRAINT "career_opportunity_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'career_workspace_organization_id_organization_id_fkey' AND conrelid = '"career_workspace"'::regclass) THEN
		ALTER TABLE "career_workspace" ADD CONSTRAINT "career_workspace_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'career_transcript_organization_id_organization_id_fkey' AND conrelid = '"career_transcript"'::regclass) THEN
		ALTER TABLE "career_transcript" ADD CONSTRAINT "career_transcript_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'career_answer_organization_id_organization_id_fkey' AND conrelid = '"career_answer"'::regclass) THEN
		ALTER TABLE "career_answer" ADD CONSTRAINT "career_answer_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
END $$;--> statement-breakpoint
-- 3. career_workspace keeps application_id as its key. Its organization must equal its application's, so the single
-- foreign key becomes the composite (organization_id, application_id) -> application(organization_id, id), which needs
-- that unique key on application. A composite foreign key is chosen over a trigger because both columns are NOT NULL,
-- it is checked by the database for every writer (including the definer functions), and ON UPDATE CASCADE keeps the
-- workspace in step when the guest move changes the application's organization.
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'application_organization_id_id_unique' AND conrelid = '"application"'::regclass) THEN
		ALTER TABLE "application" ADD CONSTRAINT "application_organization_id_id_unique" UNIQUE ("organization_id", "id");
	END IF;
	IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'career_workspace_application_id_application_id_fkey' AND conrelid = '"career_workspace"'::regclass) THEN
		ALTER TABLE "career_workspace" DROP CONSTRAINT "career_workspace_application_id_application_id_fkey";
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'career_workspace_org_application_fkey' AND conrelid = '"career_workspace"'::regclass) THEN
		ALTER TABLE "career_workspace" ADD CONSTRAINT "career_workspace_org_application_fkey" FOREIGN KEY ("organization_id", "application_id") REFERENCES "application"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
	END IF;
END $$;--> statement-breakpoint
-- 4. D11: the career profile is per (organization, user), and every unique key or index that led with user_id leads
-- with the organization first.
DO $$ BEGIN
	IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"career_profile"'::regclass AND contype = 'p' AND cardinality(conkey) = 1) THEN
		ALTER TABLE "career_profile" DROP CONSTRAINT "career_profile_pkey";
		ALTER TABLE "career_profile" ADD PRIMARY KEY ("organization_id", "user_id");
	END IF;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "career_answer_user_id_duplicate_key_index";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "career_answer_organization_id_user_id_duplicate_key_index" ON "career_answer" ("organization_id","user_id","duplicate_key");--> statement-breakpoint
DROP INDEX IF EXISTS "career_artifact_user_id_application_id_created_at_index";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "career_artifact_organization_id_user_id_application_id_created_at_index" ON "career_artifact" ("organization_id","user_id","application_id","created_at");--> statement-breakpoint
DROP INDEX IF EXISTS "career_fact_user_id_application_id_status_index";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "career_fact_organization_id_user_id_application_id_status_index" ON "career_fact" ("organization_id","user_id","application_id","status");--> statement-breakpoint
DROP INDEX IF EXISTS "career_fact_user_id_source_key_index";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "career_fact_organization_id_user_id_source_key_index" ON "career_fact" ("organization_id","user_id","source_key");--> statement-breakpoint
DROP INDEX IF EXISTS "career_notification_user_id_key_index";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "career_notification_organization_id_user_id_key_index" ON "career_notification" ("organization_id","user_id","key");--> statement-breakpoint
DROP INDEX IF EXISTS "career_notification_user_id_created_at_index";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "career_notification_organization_id_user_id_created_at_index" ON "career_notification" ("organization_id","user_id","created_at");--> statement-breakpoint
DROP INDEX IF EXISTS "career_opportunity_user_id_url_index";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "career_opportunity_organization_id_user_id_url_index" ON "career_opportunity" ("organization_id","user_id","url");--> statement-breakpoint
DROP INDEX IF EXISTS "career_story_user_id_application_id_index";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "career_story_organization_id_user_id_application_id_index" ON "career_story" ("organization_id","user_id","application_id");--> statement-breakpoint
DROP INDEX IF EXISTS "career_transcript_user_id_application_id_index";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "career_transcript_organization_id_user_id_application_id_index" ON "career_transcript" ("organization_id","user_id","application_id");--> statement-breakpoint
-- 5. Row-level security (D4), exactly as P1-T04: FORCE applies the policy to the table owner too, so only owner_access
-- lets the owner role (migrations, definer functions) see every organization. careeros_app only matches its own
-- organization; an unset setting is NULL and matches nothing (fail closed).
ALTER TABLE "career_profile" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "career_profile" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "career_profile";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "career_profile"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "career_profile";--> statement-breakpoint
CREATE POLICY "owner_access" ON "career_profile" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "career_fact" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "career_fact" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "career_fact";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "career_fact"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "career_fact";--> statement-breakpoint
CREATE POLICY "owner_access" ON "career_fact" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "career_story" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "career_story" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "career_story";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "career_story"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "career_story";--> statement-breakpoint
CREATE POLICY "owner_access" ON "career_story" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "career_artifact" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "career_artifact" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "career_artifact";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "career_artifact"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "career_artifact";--> statement-breakpoint
CREATE POLICY "owner_access" ON "career_artifact" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "career_schedule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "career_schedule" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "career_schedule";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "career_schedule"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "career_schedule";--> statement-breakpoint
CREATE POLICY "owner_access" ON "career_schedule" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "career_job" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "career_job" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "career_job";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "career_job"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "career_job";--> statement-breakpoint
CREATE POLICY "owner_access" ON "career_job" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "career_notification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "career_notification" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "career_notification";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "career_notification"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "career_notification";--> statement-breakpoint
CREATE POLICY "owner_access" ON "career_notification" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "career_opportunity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "career_opportunity" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "career_opportunity";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "career_opportunity"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "career_opportunity";--> statement-breakpoint
CREATE POLICY "owner_access" ON "career_opportunity" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "career_workspace" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "career_workspace" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "career_workspace";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "career_workspace"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "career_workspace";--> statement-breakpoint
CREATE POLICY "owner_access" ON "career_workspace" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "career_transcript" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "career_transcript" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "career_transcript";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "career_transcript"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "career_transcript";--> statement-breakpoint
CREATE POLICY "owner_access" ON "career_transcript" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "career_answer" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "career_answer" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "career_answer";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "career_answer"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "career_answer";--> statement-breakpoint
CREATE POLICY "owner_access" ON "career_answer" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
-- 6. Guest linking: moves an anonymous (guest) user's saved application answers, and the career rows that belong to
-- the guest's applications, to the account the guest signed in as and to an organization that account belongs to.
-- Crossing organizations is forbidden to the application role, hence a definer function, narrowed like
-- careeros_move_guest_applications: the source must be an anonymous user and the target organization must have the
-- target user as a member. It runs after careeros_move_guest_applications, because the career rows follow their
-- application: facts, stories, saved items, transcripts, schedules (with their jobs), notifications and workspaces of
-- an application that is now the target's move with it. A saved answer on both sides under the same duplicate key is a
-- conflict (SQLSTATE CR004), as before. Knowledge that is not tied to an application (the career profile, general
-- facts and stories, discovery schedules and roles) stays with the guest, as before. A row that would collide with one
-- the target already has is left with the guest.
CREATE OR REPLACE FUNCTION public.careeros_move_guest_career(from_user text, to_user text, to_org text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
	IF from_user = to_user THEN RETURN; END IF;
	IF to_org IS NULL THEN
		IF EXISTS (SELECT 1 FROM public.career_answer WHERE user_id = from_user)
			OR EXISTS (SELECT 1 FROM public.career_workspace WHERE user_id = from_user) THEN
			RAISE EXCEPTION 'careeros_move_guest_career: the target user has no organization';
		END IF;
		RETURN;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public."user" WHERE id = from_user AND is_anonymous) THEN
		RAISE EXCEPTION 'careeros_move_guest_career: the source is not a guest account';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public.member WHERE organization_id = to_org AND user_id = to_user) THEN
		RAISE EXCEPTION 'careeros_move_guest_career: the target user is not a member of the target organization';
	END IF;

	IF EXISTS (
		SELECT 1 FROM public.career_answer s JOIN public.career_answer t
			ON t.organization_id = to_org AND t.user_id = to_user AND t.duplicate_key = s.duplicate_key
		WHERE s.user_id = from_user
	) THEN
		RAISE EXCEPTION 'careeros_move_guest_career: both accounts have the same saved application answer' USING ERRCODE = 'CR004';
	END IF;
	-- Preserve wording: updated_at is kept.
	UPDATE public.career_answer SET user_id = to_user, organization_id = to_org WHERE user_id = from_user;

	UPDATE public.career_workspace SET user_id = to_user, organization_id = to_org
		WHERE user_id = from_user AND application_id IN (SELECT a.id FROM public.application a WHERE a.user_id = to_user AND a.organization_id = to_org);
	UPDATE public.career_fact t SET user_id = to_user, organization_id = to_org
		WHERE t.user_id = from_user AND t.application_id IN (SELECT a.id FROM public.application a WHERE a.user_id = to_user AND a.organization_id = to_org)
			AND NOT EXISTS (SELECT 1 FROM public.career_fact x WHERE x.organization_id = to_org AND x.user_id = to_user AND x.source_key = t.source_key);
	UPDATE public.career_story SET user_id = to_user, organization_id = to_org
		WHERE user_id = from_user AND application_id IN (SELECT a.id FROM public.application a WHERE a.user_id = to_user AND a.organization_id = to_org);
	UPDATE public.career_transcript SET user_id = to_user, organization_id = to_org
		WHERE user_id = from_user AND application_id IN (SELECT a.id FROM public.application a WHERE a.user_id = to_user AND a.organization_id = to_org);
	UPDATE public.career_schedule SET user_id = to_user, organization_id = to_org
		WHERE user_id = from_user AND application_id IN (SELECT a.id FROM public.application a WHERE a.user_id = to_user AND a.organization_id = to_org);
	UPDATE public.career_job SET user_id = to_user, organization_id = to_org
		WHERE user_id = from_user AND schedule_id IN (SELECT id FROM public.career_schedule WHERE user_id = to_user AND organization_id = to_org);
	UPDATE public.career_artifact SET user_id = to_user, organization_id = to_org
		WHERE user_id = from_user AND application_id IN (SELECT a.id FROM public.application a WHERE a.user_id = to_user AND a.organization_id = to_org);
	UPDATE public.career_notification t SET user_id = to_user, organization_id = to_org
		WHERE t.user_id = from_user AND t.application_id IN (SELECT a.id FROM public.application a WHERE a.user_id = to_user AND a.organization_id = to_org)
			AND NOT EXISTS (SELECT 1 FROM public.career_notification x WHERE x.organization_id = to_org AND x.user_id = to_user AND x.key = t.key);
	UPDATE public.career_opportunity t SET user_id = to_user, organization_id = to_org
		WHERE t.user_id = from_user AND t.tracked_application_id IN (SELECT a.id FROM public.application a WHERE a.user_id = to_user AND a.organization_id = to_org)
			AND NOT EXISTS (SELECT 1 FROM public.career_opportunity x WHERE x.organization_id = to_org AND x.user_id = to_user AND x.url = t.url);
END
$$;--> statement-breakpoint
-- 7. Career scheduler (D9). It has no organization, and row-level security hides every career row from it. These
-- return only organization ids (and job ids), never row data, so the runner can then work inside withOrgContext, one
-- organization or job at a time. They replace the two interim functions of P1-T06.
--   careeros_due_career_jobs: the (id, organization_id) of jobs that may be claimed now: due, fewer than 3 attempts,
--     queued with no live lease or running with an expired one, and whose owner has no other live running job. Oldest
--     due first, at most lease_limit of them. The runner claims and leases each one inside its organization.
--   careeros_orgs_with_due_career_schedules: organizations with an enabled schedule that is due and whose application,
--     if it has one, is still open (the schedules are then materialised into jobs inside each organization).
--   careeros_orgs_with_career_upkeep: organizations with exhausted running jobs to fail, completed jobs whose email is
--     still to send, or read notifications past the 90-day retention.
CREATE OR REPLACE FUNCTION public.careeros_due_career_jobs(now timestamptz, lease_limit integer)
RETURNS TABLE (id text, organization_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT j.id, j.organization_id FROM public.career_job j
	WHERE j.due_at <= $1 AND j.attempts < 3
		AND ((j.status = 'queued' AND (j.lease_until IS NULL OR j.lease_until <= $1))
			OR (j.status = 'running' AND j.lease_until <= $1))
		AND NOT EXISTS (
			SELECT 1 FROM public.career_job r
			WHERE r.user_id = j.user_id AND r.status = 'running' AND r.id <> j.id AND r.lease_until > $1)
	ORDER BY j.due_at, j.id
	LIMIT greatest($2, 0)
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.careeros_orgs_with_due_career_schedules(now timestamptz) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT DISTINCT s.organization_id FROM public.career_schedule s
	WHERE s.enabled AND s.next_run_at <= $1
		AND (s.last_queued_at IS NULL OR s.next_run_at > s.last_queued_at)
		AND (s.application_id IS NULL OR EXISTS (
			SELECT 1 FROM public.application a WHERE a.id = s.application_id AND a.status <> 'closed'))
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.careeros_orgs_with_career_upkeep(now timestamptz) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT j.organization_id FROM public.career_job j
		WHERE j.status = 'running' AND j.attempts >= 3 AND j.lease_until <= $1
	UNION
	SELECT n.organization_id FROM public.career_notification n
		JOIN public.career_job j ON j.id = n.key
		JOIN public.career_schedule s ON s.id = j.schedule_id
		WHERE j.status = 'completed' AND s.email AND s.enabled AND n.emailed_at IS NULL
	UNION
	SELECT n.organization_id FROM public.career_notification n
		WHERE n.read_at <= $1 - interval '90 days'
$$;--> statement-breakpoint
DROP FUNCTION IF EXISTS public.careeros_application_is_open(text, text);--> statement-breakpoint
DROP FUNCTION IF EXISTS public.careeros_application_org(text, text);--> statement-breakpoint
DO $$ BEGIN
	REVOKE ALL ON FUNCTION public.careeros_move_guest_career(text, text, text) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_due_career_jobs(timestamptz, integer) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_orgs_with_due_career_schedules(timestamptz) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_orgs_with_career_upkeep(timestamptz) FROM PUBLIC;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'careeros_app') THEN
		GRANT EXECUTE ON FUNCTION public.careeros_move_guest_career(text, text, text) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_due_career_jobs(timestamptz, integer) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_orgs_with_due_career_schedules(timestamptz) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_orgs_with_career_upkeep(timestamptz) TO careeros_app;
	END IF;
END $$;
