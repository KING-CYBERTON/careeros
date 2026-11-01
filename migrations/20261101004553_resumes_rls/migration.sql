-- CAREEROS P1-T04: resume tenant tables get organization_id, backfill (D7), row-level security (D4) and the
-- public lookup functions (D10). Written to be re-runnable: every statement is idempotent. Runs as the migration
-- (owner) role. Down migration: down.sql in this folder.
--> statement-breakpoint
-- 1. D7: a personal organization (with an owner member) for every user that has no membership. Ids are derived from
-- the user id, so a second run finds them and changes nothing. The metadata marker lets down.sql find them.
INSERT INTO "organization" ("id", "name", "slug", "metadata")
SELECT
	'bf_' || md5(u."id"),
	CASE WHEN coalesce(nullif(btrim(u."name"), ''), nullif(btrim(u."username"), '')) IS NULL THEN 'Personal workspace'
		ELSE left(coalesce(nullif(btrim(u."name"), ''), nullif(btrim(u."username"), '')) || '''s workspace', 100) END,
	'u-' || right(md5(u."id"), 16),
	'{"careeros_backfill":true}'
FROM "user" u
WHERE NOT EXISTS (SELECT 1 FROM "member" m WHERE m."user_id" = u."id")
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "member" ("id", "organization_id", "user_id", "role")
SELECT 'bf_' || md5(u."id"), 'bf_' || md5(u."id"), u."id", 'owner'
FROM "user" u
WHERE NOT EXISTS (SELECT 1 FROM "member" m WHERE m."user_id" = u."id")
	AND EXISTS (SELECT 1 FROM "organization" o WHERE o."id" = 'bf_' || md5(u."id"))
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Sessions without an active organization get the user's oldest membership (the same rule as the sign-in hook).
UPDATE "session" s
SET "active_organization_id" = (
	SELECT m."organization_id" FROM "member" m WHERE m."user_id" = s."user_id" ORDER BY m."created_at", m."id" LIMIT 1
)
WHERE s."active_organization_id" IS NULL
	AND EXISTS (SELECT 1 FROM "member" m WHERE m."user_id" = s."user_id");--> statement-breakpoint
-- Keys created before P1-T03 have no organization; they get the owner's oldest membership (the sign-in hook's rule), so
-- existing API keys keep working. Review 1 M1. Keys of users with no membership stay NULL and fail closed.
UPDATE "apikey" k
SET "organization_id" = (
	SELECT m."organization_id" FROM "member" m WHERE m."user_id" = k."reference_id" ORDER BY m."created_at", m."id" LIMIT 1
)
WHERE k."organization_id" IS NULL;--> statement-breakpoint
-- 2. organization_id: nullable first, backfilled, then NOT NULL with its foreign key.
ALTER TABLE "resume" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "resume_version" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "resume_slug_redirect" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "resume_statistics" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "resume_statistics_daily" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
-- Resumes take the owner's oldest membership (their personal organization); child rows follow their resume.
UPDATE "resume" r
SET "organization_id" = (
	SELECT m."organization_id" FROM "member" m WHERE m."user_id" = r."user_id" ORDER BY m."created_at", m."id" LIMIT 1
)
WHERE r."organization_id" IS NULL;--> statement-breakpoint
UPDATE "resume_version" c SET "organization_id" = r."organization_id" FROM "resume" r WHERE r."id" = c."resume_id" AND c."organization_id" IS NULL;--> statement-breakpoint
UPDATE "resume_slug_redirect" c SET "organization_id" = r."organization_id" FROM "resume" r WHERE r."id" = c."resume_id" AND c."organization_id" IS NULL;--> statement-breakpoint
UPDATE "resume_statistics" c SET "organization_id" = r."organization_id" FROM "resume" r WHERE r."id" = c."resume_id" AND c."organization_id" IS NULL;--> statement-breakpoint
UPDATE "resume_statistics_daily" c SET "organization_id" = r."organization_id" FROM "resume" r WHERE r."id" = c."resume_id" AND c."organization_id" IS NULL;--> statement-breakpoint
ALTER TABLE "resume" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "resume_version" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "resume_slug_redirect" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "resume_statistics" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "resume_statistics_daily" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resume_organization_id_organization_id_fkey' AND conrelid = '"resume"'::regclass) THEN
		ALTER TABLE "resume" ADD CONSTRAINT "resume_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resume_version_organization_id_organization_id_fkey' AND conrelid = '"resume_version"'::regclass) THEN
		ALTER TABLE "resume_version" ADD CONSTRAINT "resume_version_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resume_slug_redirect_organization_id_organization_id_fkey' AND conrelid = '"resume_slug_redirect"'::regclass) THEN
		ALTER TABLE "resume_slug_redirect" ADD CONSTRAINT "resume_slug_redirect_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resume_statistics_organization_id_organization_id_fkey' AND conrelid = '"resume_statistics"'::regclass) THEN
		ALTER TABLE "resume_statistics" ADD CONSTRAINT "resume_statistics_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resume_statistics_daily_organization_id_organization_id_fkey' AND conrelid = '"resume_statistics_daily"'::regclass) THEN
		ALTER TABLE "resume_statistics_daily" ADD CONSTRAINT "resume_statistics_daily_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resume_organization_id_user_id_updated_at_index" ON "resume" ("organization_id","user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resume_version_organization_id_resume_id_created_at_index" ON "resume_version" ("organization_id","resume_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resume_slug_redirect_organization_id_resume_id_index" ON "resume_slug_redirect" ("organization_id","resume_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resume_statistics_organization_id_resume_id_index" ON "resume_statistics" ("organization_id","resume_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resume_statistics_daily_organization_id_resume_id_date_index" ON "resume_statistics_daily" ("organization_id","resume_id","date" DESC NULLS LAST);--> statement-breakpoint
-- 3. Row-level security (D4). FORCE applies the policy to the table owner too, so only the explicit owner_access
-- policy below lets the owner role (migrations and the security definer functions) see every organization's rows.
-- The application role (careeros_app, NOBYPASSRLS) only ever matches its own organization; an unset setting is NULL
-- and matches nothing (fail closed).
ALTER TABLE "resume" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "resume" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "resume";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "resume"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "resume";--> statement-breakpoint
CREATE POLICY "owner_access" ON "resume" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "resume_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "resume_version" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "resume_version";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "resume_version"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "resume_version";--> statement-breakpoint
CREATE POLICY "owner_access" ON "resume_version" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "resume_slug_redirect" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "resume_slug_redirect" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "resume_slug_redirect";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "resume_slug_redirect"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "resume_slug_redirect";--> statement-breakpoint
CREATE POLICY "owner_access" ON "resume_slug_redirect" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "resume_statistics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "resume_statistics" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "resume_statistics";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "resume_statistics"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "resume_statistics";--> statement-breakpoint
CREATE POLICY "owner_access" ON "resume_statistics" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "resume_statistics_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "resume_statistics_daily" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "resume_statistics_daily";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "resume_statistics_daily"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "resume_statistics_daily";--> statement-breakpoint
CREATE POLICY "owner_access" ON "resume_statistics_daily" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
-- 4. Public lookups (D10). Each function is SECURITY DEFINER with a fixed search_path and runs as the migration
-- (owner) role, so it reads through owner_access. It returns an organization id (or public listing data) only for a
-- resume that is public, outside Trash, with an owner who is not banned: the same rule findResume applies in the
-- application. A password-protected resume is public too (the password gates the content, not the address), so this
-- one rule covers both. Execute is revoked from PUBLIC and granted to careeros_app only.
CREATE OR REPLACE FUNCTION public.careeros_public_resume_org(username text, slug text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT r.organization_id
	FROM public.resume r
	JOIN public."user" u ON u.id = r.user_id
	WHERE u.username = lower($1) AND r.slug = $2 AND r.is_public AND r.trashed_at IS NULL
		AND (u.banned IS NOT TRUE OR u.ban_expires <= now())
	LIMIT 1
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.careeros_public_resume_org_by_redirect(username text, slug text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT r.organization_id
	FROM public.resume_slug_redirect s
	JOIN public.resume r ON r.id = s.resume_id AND r.user_id = s.user_id
	JOIN public."user" u ON u.id = r.user_id
	WHERE u.username = lower($1) AND s.slug = $2 AND s.expires_at > now()
		AND r.is_public AND r.trashed_at IS NULL AND (u.banned IS NOT TRUE OR u.ban_expires <= now())
	LIMIT 1
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.careeros_public_primary_resume_org(username text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT r.organization_id
	FROM public.resume r
	JOIN public."user" u ON u.id = r.user_id
	WHERE u.username = lower($1) AND r.is_primary AND r.is_public AND r.trashed_at IS NULL
		AND (u.banned IS NOT TRUE OR u.ban_expires <= now())
	LIMIT 1
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.careeros_public_resume_org_by_id(resume_id text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT r.organization_id
	FROM public.resume r
	JOIN public."user" u ON u.id = r.user_id
	WHERE r.id = $1 AND r.is_public AND r.trashed_at IS NULL AND (u.banned IS NOT TRUE OR u.ban_expires <= now())
$$;--> statement-breakpoint
-- The sitemap: public listing data only (never an organization id), for resumes whose owners let search engines list
-- them. $3 excludes a primary resume whose owner has a verified custom domain (that domain is its address).
CREATE OR REPLACE FUNCTION public.careeros_public_indexable_resumes(page_offset integer, page_limit integer, exclude_custom_domain boolean)
RETURNS TABLE (username text, slug text, is_primary boolean, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT u.username, r.slug, r.is_primary, r.updated_at
	FROM public.resume r
	JOIN public."user" u ON u.id = r.user_id
	WHERE r.is_public AND r.show_in_search_engines AND r.password IS NULL AND r.trashed_at IS NULL
		AND (u.banned IS NOT TRUE OR u.ban_expires <= now())
		AND NOT ($3 AND r.is_primary AND EXISTS (
			SELECT 1 FROM public.custom_domain d WHERE d.user_id = r.user_id AND d.verified_at IS NOT NULL))
	ORDER BY r.id
	LIMIT $2 OFFSET $1
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.careeros_public_indexable_resume_count(exclude_custom_domain boolean) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT count(*)
	FROM public.resume r
	JOIN public."user" u ON u.id = r.user_id
	WHERE r.is_public AND r.show_in_search_engines AND r.password IS NULL AND r.trashed_at IS NULL
		AND (u.banned IS NOT TRUE OR u.ban_expires <= now())
		AND NOT ($1 AND r.is_primary AND EXISTS (
			SELECT 1 FROM public.custom_domain d WHERE d.user_id = r.user_id AND d.verified_at IS NOT NULL))
$$;--> statement-breakpoint
-- The public landing page's "resumes created" number: one aggregate, nothing else.
CREATE OR REPLACE FUNCTION public.careeros_resume_count() RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT count(*) FROM public.resume
$$;--> statement-breakpoint
-- Guest linking: moves an anonymous (guest) user's resumes, versions, slug redirects and statistics to the account the
-- guest signed in as, and to an organization that account belongs to. This crosses organizations, which row-level
-- security forbids to the application role, hence a definer function. Narrow on purpose: the source must be an
-- anonymous user and the target organization must have the target user as a member.
CREATE OR REPLACE FUNCTION public.careeros_move_guest_resumes(from_user text, to_user text, to_org text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
	IF from_user = to_user THEN RETURN; END IF;
	IF to_org IS NULL THEN
		-- No organization to move into: fine when the guest has no resumes, otherwise refuse instead of losing them.
		IF EXISTS (SELECT 1 FROM public.resume WHERE user_id = from_user) THEN
			RAISE EXCEPTION 'careeros_move_guest_resumes: the target user has no organization';
		END IF;
		RETURN;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public."user" WHERE id = from_user AND is_anonymous) THEN
		RAISE EXCEPTION 'careeros_move_guest_resumes: the source is not a guest account';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public.member WHERE organization_id = to_org AND user_id = to_user) THEN
		RAISE EXCEPTION 'careeros_move_guest_resumes: the target user is not a member of the target organization';
	END IF;

	WITH moved AS (
		UPDATE public.resume
		SET user_id = to_user,
			organization_id = to_org,
			slug = CASE WHEN EXISTS (SELECT 1 FROM public.resume x WHERE x.user_id = to_user AND x.slug = resume.slug)
				THEN resume.slug || '-' || right(resume.id, 6) ELSE resume.slug END,
			data = replace(resume.data::text, 'uploads/' || from_user || '/', 'uploads/' || to_user || '/')::jsonb
		WHERE user_id = from_user
		RETURNING id
	), counted AS (
		UPDATE public.resume_statistics SET organization_id = to_org WHERE resume_id IN (SELECT id FROM moved) RETURNING 1
	)
	UPDATE public.resume_statistics_daily SET organization_id = to_org WHERE resume_id IN (SELECT id FROM moved);
	UPDATE public.resume_version
		SET user_id = to_user,
			organization_id = to_org,
			data = replace(data::text, 'uploads/' || from_user || '/', 'uploads/' || to_user || '/')::jsonb
		WHERE user_id = from_user;
	DELETE FROM public.resume_slug_redirect
		WHERE user_id = from_user
			AND EXISTS (SELECT 1 FROM public.resume_slug_redirect x WHERE x.user_id = to_user AND x.slug = resume_slug_redirect.slug);
	UPDATE public.resume_slug_redirect SET user_id = to_user, organization_id = to_org WHERE user_id = from_user;
END
$$;--> statement-breakpoint
DO $$ BEGIN
	REVOKE ALL ON FUNCTION public.careeros_public_resume_org(text, text) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_public_resume_org_by_redirect(text, text) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_public_primary_resume_org(text) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_public_resume_org_by_id(text) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_public_indexable_resumes(integer, integer, boolean) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_public_indexable_resume_count(boolean) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_resume_count() FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_move_guest_resumes(text, text, text) FROM PUBLIC;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'careeros_app') THEN
		GRANT EXECUTE ON FUNCTION public.careeros_public_resume_org(text, text) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_public_resume_org_by_redirect(text, text) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_public_primary_resume_org(text) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_public_resume_org_by_id(text) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_public_indexable_resumes(integer, integer, boolean) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_public_indexable_resume_count(boolean) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_resume_count() TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_move_guest_resumes(text, text, text) TO careeros_app;
	END IF;
END $$;
