-- CAREEROS P1-T06 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- Restores the per-user keys: application_pipeline and application_profile keyed by user_id, application_lane keyed by
-- id, the lane unique keys and the application lane foreign key on user_id. THIS FAILS if a user has rows in two
-- organizations (two pipelines, two profiles, or the same default lane id in two organizations), because those keys
-- allow one row per user. Delete or merge the extra organization's rows first. Organizations the up migration may have
-- backfilled (same marker as P1-T04) are left for P1-T04's down migration, which owns that marker.
DROP FUNCTION IF EXISTS public.careeros_application_org(text, text);
DROP FUNCTION IF EXISTS public.careeros_application_is_open(text, text);
DROP FUNCTION IF EXISTS public.careeros_move_guest_applications(text, text, text);
DROP POLICY IF EXISTS "owner_access" ON "application";
DROP POLICY IF EXISTS "tenant_isolation" ON "application";
ALTER TABLE "application" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "application" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "application_lane";
DROP POLICY IF EXISTS "tenant_isolation" ON "application_lane";
ALTER TABLE "application_lane" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "application_lane" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "application_pipeline";
DROP POLICY IF EXISTS "tenant_isolation" ON "application_pipeline";
ALTER TABLE "application_pipeline" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "application_pipeline" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "application_profile";
DROP POLICY IF EXISTS "tenant_isolation" ON "application_profile";
ALTER TABLE "application_profile" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "application_profile" DISABLE ROW LEVEL SECURITY;
-- The lane trigger as 20261029063845 defined it.
DROP TRIGGER IF EXISTS application_assign_lane_trigger ON "application";
CREATE OR REPLACE FUNCTION application_assign_lane() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE chosen application_lane%ROWTYPE;
BEGIN
 IF NEW.lane_id IS NOT NULL THEN
  SELECT * INTO chosen FROM application_lane WHERE id = NEW.lane_id AND user_id = NEW.user_id;
 END IF;
 IF NEW.lane_id IS NULL OR
  (TG_OP = 'UPDATE' AND NEW.lane_id IS NOT DISTINCT FROM OLD.lane_id AND
   (chosen.id IS NULL OR NEW.status IS DISTINCT FROM OLD.status OR
    (chosen.closed_reason IS NOT NULL AND NEW.closed_reason IS DISTINCT FROM chosen.closed_reason))) THEN
  INSERT INTO application_pipeline (user_id) VALUES (NEW.user_id) ON CONFLICT DO NOTHING;
  INSERT INTO application_lane (id, user_id, category, label, color, position, system_key)
  SELECT 'application-lane:' || NEW.user_id || ':' || d.category, NEW.user_id, d.category, NULL, d.color, d.position, d.category
  FROM (VALUES
   ('saved', '#8D8C80', 0), ('applied', '#578BC7', 1), ('screening', '#319FA8', 2),
   ('interview', '#BB9135', 3), ('offer', '#449D70', 4), ('closed', '#C36B5C', 5)
  ) AS d(category, color, position) ON CONFLICT DO NOTHING;
  SELECT * INTO chosen FROM application_lane WHERE user_id = NEW.user_id AND system_key = NEW.status;
  NEW.lane_id := chosen.id;
 END IF;
 IF chosen.id IS NULL OR chosen.category <> NEW.status OR chosen.retired_at IS NOT NULL OR
  (chosen.closed_reason IS NOT NULL AND chosen.closed_reason IS DISTINCT FROM NEW.closed_reason) THEN
  RAISE EXCEPTION 'Application lane must be active, owned and compatible with its category and outcome' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END;
$$;
ALTER TABLE "application" DROP CONSTRAINT IF EXISTS "application_lane_owner_fk";
ALTER TABLE "application_lane" DROP CONSTRAINT IF EXISTS "application_lane_owner_id_unique";
ALTER TABLE "application_lane" ADD CONSTRAINT "application_lane_owner_id_unique" UNIQUE ("user_id", "id");
ALTER TABLE "application_lane" DROP CONSTRAINT IF EXISTS "application_lane_owner_system_unique";
ALTER TABLE "application_lane" ADD CONSTRAINT "application_lane_owner_system_unique" UNIQUE ("user_id", "system_key");
ALTER TABLE "application_lane" DROP CONSTRAINT "application_lane_pkey";
ALTER TABLE "application_lane" ADD PRIMARY KEY ("id");
ALTER TABLE "application_pipeline" DROP CONSTRAINT "application_pipeline_pkey";
ALTER TABLE "application_pipeline" ADD PRIMARY KEY ("user_id");
ALTER TABLE "application_profile" DROP CONSTRAINT "application_profile_pkey";
ALTER TABLE "application_profile" ADD PRIMARY KEY ("user_id");
ALTER TABLE "application" ADD CONSTRAINT "application_lane_owner_fk" FOREIGN KEY ("user_id", "lane_id") REFERENCES "application_lane"("user_id", "id");
DROP INDEX IF EXISTS "application_organization_id_user_id_lane_id_index";
DROP INDEX IF EXISTS "application_organization_id_user_id_updated_at_index";
DROP INDEX IF EXISTS "application_lane_organization_id_user_id_index";
CREATE INDEX IF NOT EXISTS "application_lane_user_id_index" ON "application_lane" ("user_id");
CREATE TRIGGER application_assign_lane_trigger BEFORE INSERT OR UPDATE OF user_id, status, lane_id, closed_reason ON "application"
FOR EACH ROW EXECUTE FUNCTION application_assign_lane();
ALTER TABLE "application" DROP CONSTRAINT IF EXISTS "application_organization_id_organization_id_fkey";
ALTER TABLE "application" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "application_lane" DROP CONSTRAINT IF EXISTS "application_lane_organization_id_organization_id_fkey";
ALTER TABLE "application_lane" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "application_pipeline" DROP CONSTRAINT IF EXISTS "application_pipeline_organization_id_organization_id_fkey";
ALTER TABLE "application_pipeline" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "application_profile" DROP CONSTRAINT IF EXISTS "application_profile_organization_id_organization_id_fkey";
ALTER TABLE "application_profile" DROP COLUMN IF EXISTS "organization_id";
