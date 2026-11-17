-- CAREEROS P1-T06: application, application_lane, application_pipeline and application_profile get organization_id, a
-- backfill, new composite keys (D11) and row-level security (D4), following P1-T04 (resumes) and P1-T05 (cover
-- letters). Every statement is idempotent so the migration can run twice. Runs as the migration (owner) role. Down
-- migration: down.sql in this folder.
--> statement-breakpoint
-- 1. D7 safety net: a user with application data but no membership (T04 backfilled everyone that existed then, and
-- sign-up makes an organization since T03) still gets a personal organization, so the NOT NULL below cannot fail. Same
-- ids and marker as the T04 backfill, so a second run (or T04's, or T05's) finds them.
INSERT INTO "organization" ("id", "name", "slug", "metadata")
SELECT
	'bf_' || md5(u."id"),
	CASE WHEN coalesce(nullif(btrim(u."name"), ''), nullif(btrim(u."username"), '')) IS NULL THEN 'Personal workspace'
		ELSE left(coalesce(nullif(btrim(u."name"), ''), nullif(btrim(u."username"), '')) || '''s workspace', 100) END,
	'u-' || right(md5(u."id"), 16),
	'{"careeros_backfill":true}'
FROM "user" u
WHERE NOT EXISTS (SELECT 1 FROM "member" m WHERE m."user_id" = u."id")
	AND (EXISTS (SELECT 1 FROM "application" x WHERE x."user_id" = u."id")
		OR EXISTS (SELECT 1 FROM "application_lane" x WHERE x."user_id" = u."id")
		OR EXISTS (SELECT 1 FROM "application_pipeline" x WHERE x."user_id" = u."id")
		OR EXISTS (SELECT 1 FROM "application_profile" x WHERE x."user_id" = u."id"))
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "member" ("id", "organization_id", "user_id", "role")
SELECT 'bf_' || md5(u."id"), 'bf_' || md5(u."id"), u."id", 'owner'
FROM "user" u
WHERE NOT EXISTS (SELECT 1 FROM "member" m WHERE m."user_id" = u."id")
	AND (EXISTS (SELECT 1 FROM "application" x WHERE x."user_id" = u."id")
		OR EXISTS (SELECT 1 FROM "application_lane" x WHERE x."user_id" = u."id")
		OR EXISTS (SELECT 1 FROM "application_pipeline" x WHERE x."user_id" = u."id")
		OR EXISTS (SELECT 1 FROM "application_profile" x WHERE x."user_id" = u."id"))
	AND EXISTS (SELECT 1 FROM "organization" o WHERE o."id" = 'bf_' || md5(u."id"))
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 2. organization_id: nullable first, backfilled, then NOT NULL with its foreign key. Every row of a user (pipeline,
-- profile, lanes and applications) goes to the owner's oldest membership (the T04 resume rule), so a lane is always in
-- the organization of its pipeline and of the applications that sit in it.
ALTER TABLE "application" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "application_lane" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "application_pipeline" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "application_profile" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
UPDATE "application" t SET "organization_id" = (
	SELECT m."organization_id" FROM "member" m WHERE m."user_id" = t."user_id" ORDER BY m."created_at", m."id" LIMIT 1
) WHERE t."organization_id" IS NULL;--> statement-breakpoint
UPDATE "application_lane" t SET "organization_id" = (
	SELECT m."organization_id" FROM "member" m WHERE m."user_id" = t."user_id" ORDER BY m."created_at", m."id" LIMIT 1
) WHERE t."organization_id" IS NULL;--> statement-breakpoint
UPDATE "application_pipeline" t SET "organization_id" = (
	SELECT m."organization_id" FROM "member" m WHERE m."user_id" = t."user_id" ORDER BY m."created_at", m."id" LIMIT 1
) WHERE t."organization_id" IS NULL;--> statement-breakpoint
UPDATE "application_profile" t SET "organization_id" = (
	SELECT m."organization_id" FROM "member" m WHERE m."user_id" = t."user_id" ORDER BY m."created_at", m."id" LIMIT 1
) WHERE t."organization_id" IS NULL;--> statement-breakpoint
ALTER TABLE "application" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "application_lane" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "application_pipeline" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "application_profile" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'application_organization_id_organization_id_fkey' AND conrelid = '"application"'::regclass) THEN
		ALTER TABLE "application" ADD CONSTRAINT "application_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'application_lane_organization_id_organization_id_fkey' AND conrelid = '"application_lane"'::regclass) THEN
		ALTER TABLE "application_lane" ADD CONSTRAINT "application_lane_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'application_pipeline_organization_id_organization_id_fkey' AND conrelid = '"application_pipeline"'::regclass) THEN
		ALTER TABLE "application_pipeline" ADD CONSTRAINT "application_pipeline_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'application_profile_organization_id_organization_id_fkey' AND conrelid = '"application_profile"'::regclass) THEN
		ALTER TABLE "application_profile" ADD CONSTRAINT "application_profile_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
END $$;--> statement-breakpoint
-- 3. D11: the pipeline and the application profile are per (organization, user); lanes are keyed per organization (the
-- default lanes keep their deterministic ids in every organization a user belongs to) and scoped to (organization,
-- user). The application's lane foreign key goes first, because it depends on the lane unique key it is rebuilt on.
DO $$ BEGIN
	IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'application_lane_owner_fk' AND conrelid = '"application"'::regclass AND cardinality(conkey) = 2) THEN
		ALTER TABLE "application" DROP CONSTRAINT "application_lane_owner_fk";
	END IF;
	IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"application_pipeline"'::regclass AND contype = 'p' AND cardinality(conkey) = 1) THEN
		ALTER TABLE "application_pipeline" DROP CONSTRAINT "application_pipeline_pkey";
		ALTER TABLE "application_pipeline" ADD PRIMARY KEY ("organization_id", "user_id");
	END IF;
	IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"application_profile"'::regclass AND contype = 'p' AND cardinality(conkey) = 1) THEN
		ALTER TABLE "application_profile" DROP CONSTRAINT "application_profile_pkey";
		ALTER TABLE "application_profile" ADD PRIMARY KEY ("organization_id", "user_id");
	END IF;
	IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"application_lane"'::regclass AND contype = 'p' AND cardinality(conkey) = 1) THEN
		ALTER TABLE "application_lane" DROP CONSTRAINT "application_lane_pkey";
		ALTER TABLE "application_lane" ADD PRIMARY KEY ("organization_id", "id");
	END IF;
	IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'application_lane_owner_id_unique' AND conrelid = '"application_lane"'::regclass AND cardinality(conkey) = 2) THEN
		ALTER TABLE "application_lane" DROP CONSTRAINT "application_lane_owner_id_unique";
		ALTER TABLE "application_lane" ADD CONSTRAINT "application_lane_owner_id_unique" UNIQUE ("organization_id", "user_id", "id");
	END IF;
	IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'application_lane_owner_system_unique' AND conrelid = '"application_lane"'::regclass AND cardinality(conkey) = 2) THEN
		ALTER TABLE "application_lane" DROP CONSTRAINT "application_lane_owner_system_unique";
		ALTER TABLE "application_lane" ADD CONSTRAINT "application_lane_owner_system_unique" UNIQUE ("organization_id", "user_id", "system_key");
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'application_lane_owner_fk' AND conrelid = '"application"'::regclass) THEN
		ALTER TABLE "application" ADD CONSTRAINT "application_lane_owner_fk" FOREIGN KEY ("organization_id", "user_id", "lane_id") REFERENCES "application_lane"("organization_id", "user_id", "id");
	END IF;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "application_lane_user_id_index";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "application_lane_organization_id_user_id_index" ON "application_lane" ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "application_organization_id_user_id_updated_at_index" ON "application" ("organization_id","user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "application_organization_id_user_id_lane_id_index" ON "application" ("organization_id","user_id","lane_id");--> statement-breakpoint
-- 4. The lane trigger of 20261029063845 seeds a missing pipeline and default lanes, and resolves an omitted lane. It now
-- does that inside the application's organization. It stays SECURITY INVOKER (as before), so row-level security still
-- applies to the writes it makes; created unqualified so a migration test with its own schema gets its own copy.
CREATE OR REPLACE FUNCTION application_assign_lane() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE chosen application_lane%ROWTYPE;
BEGIN
 IF NEW.lane_id IS NOT NULL THEN
  SELECT * INTO chosen FROM application_lane WHERE id = NEW.lane_id AND user_id = NEW.user_id AND organization_id = NEW.organization_id;
 END IF;
 IF NEW.lane_id IS NULL OR
  (TG_OP = 'UPDATE' AND NEW.lane_id IS NOT DISTINCT FROM OLD.lane_id AND
   (chosen.id IS NULL OR NEW.status IS DISTINCT FROM OLD.status OR
    (chosen.closed_reason IS NOT NULL AND NEW.closed_reason IS DISTINCT FROM chosen.closed_reason))) THEN
  INSERT INTO application_pipeline (organization_id, user_id) VALUES (NEW.organization_id, NEW.user_id) ON CONFLICT DO NOTHING;
  INSERT INTO application_lane (id, organization_id, user_id, category, label, color, position, system_key)
  SELECT 'application-lane:' || NEW.user_id || ':' || d.category, NEW.organization_id, NEW.user_id, d.category, NULL, d.color, d.position, d.category
  FROM (VALUES
   ('saved', '#8D8C80', 0), ('applied', '#578BC7', 1), ('screening', '#319FA8', 2),
   ('interview', '#BB9135', 3), ('offer', '#449D70', 4), ('closed', '#C36B5C', 5)
  ) AS d(category, color, position) ON CONFLICT DO NOTHING;
  SELECT * INTO chosen FROM application_lane WHERE organization_id = NEW.organization_id AND user_id = NEW.user_id AND system_key = NEW.status;
  NEW.lane_id := chosen.id;
 END IF;
 IF chosen.id IS NULL OR chosen.category <> NEW.status OR chosen.retired_at IS NOT NULL OR
  (chosen.closed_reason IS NOT NULL AND chosen.closed_reason IS DISTINCT FROM NEW.closed_reason) THEN
  RAISE EXCEPTION 'Application lane must be active, owned and compatible with its category and outcome' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS application_assign_lane_trigger ON "application";--> statement-breakpoint
CREATE TRIGGER application_assign_lane_trigger BEFORE INSERT OR UPDATE OF organization_id, user_id, status, lane_id, closed_reason ON "application"
FOR EACH ROW EXECUTE FUNCTION application_assign_lane();--> statement-breakpoint
-- 5. Row-level security (D4), exactly as P1-T04: FORCE applies the policy to the table owner too, so only owner_access
-- lets the owner role (migrations, definer functions) see every organization. careeros_app only matches its own
-- organization; an unset setting is NULL and matches nothing (fail closed).
ALTER TABLE "application" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "application" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "application";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "application"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "application";--> statement-breakpoint
CREATE POLICY "owner_access" ON "application" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "application_lane" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "application_lane" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "application_lane";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "application_lane"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "application_lane";--> statement-breakpoint
CREATE POLICY "owner_access" ON "application_lane" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "application_pipeline" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "application_pipeline" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "application_pipeline";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "application_pipeline"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "application_pipeline";--> statement-breakpoint
CREATE POLICY "owner_access" ON "application_pipeline" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "application_profile" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "application_profile" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "application_profile";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "application_profile"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "application_profile";--> statement-breakpoint
CREATE POLICY "owner_access" ON "application_profile" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
-- 6. Guest linking: moves an anonymous (guest) user's application profile, lanes, pipeline and applications to the
-- account the guest signed in as, and to an organization that account belongs to. Crossing organizations is forbidden
-- to the application role, hence a definer function, narrowed like careeros_move_guest_resumes: the source must be an
-- anonymous user and the target organization must have the target user as a member. It reproduces what
-- linkAnonymousAccount did in application code: a profile on both sides is a conflict (SQLSTATE CR001), a merged
-- pipeline over 40 active lanes is a conflict (CR002), system lanes map to the target's, custom lanes are copied, and
-- applications, their stage history and their upload paths follow. Lane references are keyed by organization and id,
-- because the default lane ids repeat in every organization.
CREATE OR REPLACE FUNCTION public.careeros_move_guest_applications(from_user text, to_user text, to_org text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	guest_profiles integer;
	target_lanes integer;
	target_active integer;
	source_custom integer;
	next_position integer;
	lane_map jsonb := '{}'::jsonb;
	source_lane record;
	new_id text;
BEGIN
	IF from_user = to_user THEN RETURN; END IF;
	IF to_org IS NULL THEN
		IF EXISTS (SELECT 1 FROM public.application WHERE user_id = from_user)
			OR EXISTS (SELECT 1 FROM public.application_profile WHERE user_id = from_user)
			OR EXISTS (SELECT 1 FROM public.application_lane WHERE user_id = from_user AND system_key IS NULL) THEN
			RAISE EXCEPTION 'careeros_move_guest_applications: the target user has no organization';
		END IF;
		RETURN;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public."user" WHERE id = from_user AND is_anonymous) THEN
		RAISE EXCEPTION 'careeros_move_guest_applications: the source is not a guest account';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public.member WHERE organization_id = to_org AND user_id = to_user) THEN
		RAISE EXCEPTION 'careeros_move_guest_applications: the target user is not a member of the target organization';
	END IF;

	SELECT count(*) INTO guest_profiles FROM public.application_profile WHERE user_id = from_user;
	IF guest_profiles > 0 AND (guest_profiles > 1 OR EXISTS (
		SELECT 1 FROM public.application_profile WHERE user_id = to_user AND organization_id = to_org
	)) THEN
		RAISE EXCEPTION 'careeros_move_guest_applications: both accounts have an application profile' USING ERRCODE = 'CR001';
	END IF;

	SELECT count(*), count(*) FILTER (WHERE retired_at IS NULL) INTO target_lanes, target_active
		FROM public.application_lane WHERE organization_id = to_org AND user_id = to_user;
	IF target_lanes = 0 THEN target_active := 6; END IF;
	SELECT count(*) INTO source_custom
		FROM public.application_lane WHERE user_id = from_user AND system_key IS NULL AND retired_at IS NULL;
	IF target_active + source_custom > 40 THEN
		RAISE EXCEPTION 'careeros_move_guest_applications: the combined pipeline exceeds 40 active lanes' USING ERRCODE = 'CR002';
	END IF;

	INSERT INTO public.application_pipeline (organization_id, user_id) VALUES (to_org, to_user) ON CONFLICT DO NOTHING;
	INSERT INTO public.application_lane (id, organization_id, user_id, category, label, color, position, system_key)
	SELECT 'application-lane:' || to_user || ':' || d.category, to_org, to_user, d.category, NULL, d.color, d.position, d.category
	FROM (VALUES
		('saved', '#8D8C80', 0), ('applied', '#578BC7', 1), ('screening', '#319FA8', 2),
		('interview', '#BB9135', 3), ('offer', '#449D70', 4), ('closed', '#C36B5C', 5)
	) AS d(category, color, position) ON CONFLICT DO NOTHING;

	SELECT greatest(5, coalesce(max(position), 0)) + 1 INTO next_position
		FROM public.application_lane WHERE organization_id = to_org AND user_id = to_user;
	FOR source_lane IN
		SELECT * FROM public.application_lane WHERE user_id = from_user ORDER BY position, id
	LOOP
		IF source_lane.system_key IS NOT NULL THEN
			SELECT id INTO new_id FROM public.application_lane
				WHERE organization_id = to_org AND user_id = to_user AND system_key = source_lane.system_key;
			new_id := coalesce(new_id, 'application-lane:' || to_user || ':' || source_lane.system_key);
		ELSE
			new_id := replace(gen_random_uuid()::text, '-', '');
			INSERT INTO public.application_lane
				(id, organization_id, user_id, category, label, color, position, system_key, closed_reason, retired_at)
			VALUES (new_id, to_org, to_user, source_lane.category, source_lane.label, source_lane.color, next_position,
				NULL, source_lane.closed_reason, source_lane.retired_at);
			next_position := next_position + 1;
		END IF;
		lane_map := lane_map || jsonb_build_object(source_lane.organization_id || '/' || source_lane.id, new_id);
	END LOOP;
	UPDATE public.application_pipeline SET revision = revision + 1 WHERE organization_id = to_org AND user_id = to_user;

	UPDATE public.application_profile
		SET user_id = to_user, organization_id = to_org, revision = replace(gen_random_uuid()::text, '-', '')
		WHERE user_id = from_user;

	UPDATE public.application a SET
		user_id = to_user,
		organization_id = to_org,
		lane_id = coalesce(lane_map ->> (a.organization_id || '/' || a.lane_id), 'application-lane:' || to_user || ':' || a.status),
		activity = coalesce((
			SELECT jsonb_agg(
				CASE WHEN e ->> 'type' = 'stage' AND e ->> 'laneId' IS NOT NULL AND lane_map ? (a.organization_id || '/' || (e ->> 'laneId'))
					THEN jsonb_set(e, '{laneId}', to_jsonb(lane_map ->> (a.organization_id || '/' || (e ->> 'laneId'))))
					ELSE e END
				ORDER BY ord)
			FROM jsonb_array_elements(a.activity) WITH ORDINALITY AS t(e, ord)
		), '[]'::jsonb),
		resume_file_url = CASE WHEN a.resume_file_url IS NOT NULL
			THEN replace(a.resume_file_url, 'uploads/' || from_user || '/', 'uploads/' || to_user || '/') END,
		cover_letter_url = CASE WHEN a.cover_letter_url IS NOT NULL
			THEN replace(a.cover_letter_url, 'uploads/' || from_user || '/', 'uploads/' || to_user || '/') END
	WHERE a.user_id = from_user;
END
$$;--> statement-breakpoint
-- 7. Career scheduler: it has no organization (career tables join the tenant boundary in P1-T07), and row-level
-- security now hides every application from it. These two return one small fact about one application the caller names
-- by id and owner (never row data): whether it is still open, and which organization it belongs to, so the scheduler
-- can run that job inside withOrgContext.
CREATE OR REPLACE FUNCTION public.careeros_application_is_open(application_id text, owner_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT EXISTS (SELECT 1 FROM public.application a WHERE a.id = $1 AND a.user_id = $2 AND a.status <> 'closed')
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.careeros_application_org(application_id text, owner_id text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT a.organization_id FROM public.application a WHERE a.id = $1 AND a.user_id = $2
$$;--> statement-breakpoint
DO $$ BEGIN
	REVOKE ALL ON FUNCTION public.careeros_move_guest_applications(text, text, text) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_application_is_open(text, text) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_application_org(text, text) FROM PUBLIC;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'careeros_app') THEN
		GRANT EXECUTE ON FUNCTION public.careeros_move_guest_applications(text, text, text) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_application_is_open(text, text) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_application_org(text, text) TO careeros_app;
	END IF;
END $$;
