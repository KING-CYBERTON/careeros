-- CAREEROS P1-T05: cover_letter and cover_letter_version get organization_id, a backfill, and row-level security (D4),
-- following P1-T04 (resumes). Every statement is idempotent so the migration can run twice. Runs as the migration
-- (owner) role. Down migration: down.sql in this folder.
--> statement-breakpoint
-- 1. D7 safety net: a user with letters but no membership (T04 backfilled everyone that existed then, and sign-up makes
-- an organization since T03) still gets a personal organization, so the NOT NULL below cannot fail. Same ids and marker
-- as the T04 backfill, so a second run (or T04's) finds them.
INSERT INTO "organization" ("id", "name", "slug", "metadata")
SELECT
	'bf_' || md5(u."id"),
	CASE WHEN coalesce(nullif(btrim(u."name"), ''), nullif(btrim(u."username"), '')) IS NULL THEN 'Personal workspace'
		ELSE left(coalesce(nullif(btrim(u."name"), ''), nullif(btrim(u."username"), '')) || '''s workspace', 100) END,
	'u-' || right(md5(u."id"), 16),
	'{"careeros_backfill":true}'
FROM "user" u
WHERE NOT EXISTS (SELECT 1 FROM "member" m WHERE m."user_id" = u."id")
	AND EXISTS (SELECT 1 FROM "cover_letter" c WHERE c."user_id" = u."id")
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "member" ("id", "organization_id", "user_id", "role")
SELECT 'bf_' || md5(u."id"), 'bf_' || md5(u."id"), u."id", 'owner'
FROM "user" u
WHERE NOT EXISTS (SELECT 1 FROM "member" m WHERE m."user_id" = u."id")
	AND EXISTS (SELECT 1 FROM "cover_letter" c WHERE c."user_id" = u."id")
	AND EXISTS (SELECT 1 FROM "organization" o WHERE o."id" = 'bf_' || md5(u."id"))
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 2. organization_id: nullable first, backfilled, then NOT NULL with its foreign key.
ALTER TABLE "cover_letter" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "cover_letter_version" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
-- Letters take the owner's oldest membership (the T04 resume rule); versions follow their letter.
UPDATE "cover_letter" c
SET "organization_id" = (
	SELECT m."organization_id" FROM "member" m WHERE m."user_id" = c."user_id" ORDER BY m."created_at", m."id" LIMIT 1
)
WHERE c."organization_id" IS NULL;--> statement-breakpoint
UPDATE "cover_letter_version" v SET "organization_id" = c."organization_id" FROM "cover_letter" c WHERE c."id" = v."cover_letter_id" AND v."organization_id" IS NULL;--> statement-breakpoint
ALTER TABLE "cover_letter" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cover_letter_version" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cover_letter_organization_id_organization_id_fkey' AND conrelid = '"cover_letter"'::regclass) THEN
		ALTER TABLE "cover_letter" ADD CONSTRAINT "cover_letter_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cover_letter_version_organization_id_organization_id_fkey' AND conrelid = '"cover_letter_version"'::regclass) THEN
		ALTER TABLE "cover_letter_version" ADD CONSTRAINT "cover_letter_version_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cover_letter_organization_id_user_id_updated_at_id_index" ON "cover_letter" ("organization_id","user_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cover_letter_version_organization_id_cover_letter_id_created_at_index" ON "cover_letter_version" ("organization_id","cover_letter_id","created_at" DESC NULLS LAST);--> statement-breakpoint
-- 3. Row-level security (D4), exactly as P1-T04: FORCE applies the policy to the table owner too, so only owner_access
-- lets the owner role (migrations, definer functions) see every organization. careeros_app only matches its own
-- organization; an unset setting is NULL and matches nothing (fail closed).
ALTER TABLE "cover_letter" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cover_letter" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "cover_letter";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "cover_letter"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "cover_letter";--> statement-breakpoint
CREATE POLICY "owner_access" ON "cover_letter" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "cover_letter_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cover_letter_version" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "cover_letter_version";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "cover_letter_version"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "cover_letter_version";--> statement-breakpoint
CREATE POLICY "owner_access" ON "cover_letter_version" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
-- 4. Guest linking: moves an anonymous (guest) user's cover letters and their versions to the account the guest
-- signed in as, and to an organization that account belongs to. Crossing organizations is forbidden to the application
-- role, hence a definer function, narrowed like careeros_move_guest_resumes: the source must be an anonymous user and
-- the target organization must have the target user as a member. The upload-path rewrite is the one linkAnonymousAccount
-- applied before. Execute is revoked from PUBLIC and granted to careeros_app only.
CREATE OR REPLACE FUNCTION public.careeros_move_guest_cover_letters(from_user text, to_user text, to_org text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
	IF from_user = to_user THEN RETURN; END IF;
	IF to_org IS NULL THEN
		IF EXISTS (SELECT 1 FROM public.cover_letter WHERE user_id = from_user) THEN
			RAISE EXCEPTION 'careeros_move_guest_cover_letters: the target user has no organization';
		END IF;
		RETURN;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public."user" WHERE id = from_user AND is_anonymous) THEN
		RAISE EXCEPTION 'careeros_move_guest_cover_letters: the source is not a guest account';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public.member WHERE organization_id = to_org AND user_id = to_user) THEN
		RAISE EXCEPTION 'careeros_move_guest_cover_letters: the target user is not a member of the target organization';
	END IF;
	UPDATE public.cover_letter
		SET user_id = to_user,
			organization_id = to_org,
			style = replace(style::text, 'uploads/' || from_user || '/', 'uploads/' || to_user || '/')::jsonb
		WHERE user_id = from_user;
	UPDATE public.cover_letter_version
		SET user_id = to_user,
			organization_id = to_org,
			data = replace(data::text, 'uploads/' || from_user || '/', 'uploads/' || to_user || '/')::jsonb
		WHERE user_id = from_user;
END
$$;--> statement-breakpoint
-- 5. Scheduled Trash purge: the scheduler has no organization, and row-level security hides every row from it. This
-- returns only the ids of organizations that hold trashed resumes or cover letters older than the cutoff (never row
-- data), so the purge can then run once per organization inside withOrgContext. Review 1 H1.
CREATE OR REPLACE FUNCTION public.careeros_orgs_with_expired_trash(cutoff timestamptz) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT r.organization_id FROM public.resume r WHERE r.trashed_at < $1
	UNION
	SELECT c.organization_id FROM public.cover_letter c WHERE c.trashed_at < $1
$$;--> statement-breakpoint
DO $$ BEGIN
	REVOKE ALL ON FUNCTION public.careeros_move_guest_cover_letters(text, text, text) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_orgs_with_expired_trash(timestamptz) FROM PUBLIC;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'careeros_app') THEN
		GRANT EXECUTE ON FUNCTION public.careeros_move_guest_cover_letters(text, text, text) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_orgs_with_expired_trash(timestamptz) TO careeros_app;
	END IF;
END $$;
