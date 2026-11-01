-- CAREEROS P1-T08 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- Restores the per-user keys (the default connection is one per user), the single-column foreign keys, and the
-- server-managed connection id server-ai:<user>. It REFUSES to run while a user has assistant or AI rows in more than one
-- organization, because those keys allow one default connection per user: delete or merge the extra organization's rows
-- first. Organizations the up migration may have backfilled (same marker as P1-T04) are left for P1-T04's down migration.
-- Links the up migration cleared (a connection or document in another organization than its conversation) are not
-- restored.
DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM (
	SELECT user_id, organization_id FROM "ai_providers"
	UNION
	SELECT user_id, organization_id FROM "agent_threads"
	UNION
	SELECT user_id, organization_id FROM "agent_messages"
	UNION
	SELECT user_id, organization_id FROM "agent_attachments"
	UNION
	SELECT user_id, organization_id FROM "agent_actions"
	UNION
	SELECT user_id, organization_id FROM "ai_content_report"
		) r GROUP BY user_id HAVING count(DISTINCT organization_id) > 1
	) THEN
		RAISE EXCEPTION 'P1-T08 down migration refused: a user has assistant or AI rows in more than one organization';
	END IF;
END $$;
DROP FUNCTION IF EXISTS public.careeros_orgs_with_active_agent_runs();
DROP FUNCTION IF EXISTS public.careeros_move_guest_agent(text, text, text);
DROP POLICY IF EXISTS "owner_access" ON "ai_providers";
DROP POLICY IF EXISTS "tenant_isolation" ON "ai_providers";
ALTER TABLE "ai_providers" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ai_providers" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "agent_threads";
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_threads";
ALTER TABLE "agent_threads" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "agent_threads" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "agent_messages";
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_messages";
ALTER TABLE "agent_messages" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "agent_messages" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "agent_attachments";
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_attachments";
ALTER TABLE "agent_attachments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "agent_attachments" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "agent_actions";
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_actions";
ALTER TABLE "agent_actions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "agent_actions" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "ai_content_report";
DROP POLICY IF EXISTS "tenant_isolation" ON "ai_content_report";
ALTER TABLE "ai_content_report" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ai_content_report" DISABLE ROW LEVEL SECURITY;
-- The composite keys go first, so the managed connection id can change.
ALTER TABLE "agent_threads" DROP CONSTRAINT IF EXISTS "agent_threads_org_ai_provider_fkey";
ALTER TABLE "agent_threads" DROP CONSTRAINT IF EXISTS "agent_threads_org_source_resume_fkey";
ALTER TABLE "agent_threads" DROP CONSTRAINT IF EXISTS "agent_threads_org_working_resume_fkey";
ALTER TABLE "agent_threads" DROP CONSTRAINT IF EXISTS "agent_threads_org_cover_letter_fkey";
ALTER TABLE "agent_threads" DROP CONSTRAINT IF EXISTS "agent_threads_org_application_fkey";
ALTER TABLE "agent_messages" DROP CONSTRAINT IF EXISTS "agent_messages_org_thread_fkey";
ALTER TABLE "agent_attachments" DROP CONSTRAINT IF EXISTS "agent_attachments_org_thread_fkey";
ALTER TABLE "agent_attachments" DROP CONSTRAINT IF EXISTS "agent_attachments_org_message_fkey";
ALTER TABLE "agent_actions" DROP CONSTRAINT IF EXISTS "agent_actions_org_thread_fkey";
ALTER TABLE "agent_actions" DROP CONSTRAINT IF EXISTS "agent_actions_org_message_fkey";
ALTER TABLE "agent_actions" DROP CONSTRAINT IF EXISTS "agent_actions_org_resume_fkey";
ALTER TABLE "career_schedule" DROP CONSTRAINT IF EXISTS "career_schedule_org_ai_provider_fkey";
UPDATE "agent_threads" t SET "ai_provider_id" = 'server-ai:' || p."user_id"
	FROM "ai_providers" p WHERE t."ai_provider_id" = p."id" AND p."id" = 'server-ai:' || p."organization_id" || ':' || p."user_id";
UPDATE "career_schedule" t SET "ai_provider_id" = 'server-ai:' || p."user_id"
	FROM "ai_providers" p WHERE t."ai_provider_id" = p."id" AND p."id" = 'server-ai:' || p."organization_id" || ':' || p."user_id";
UPDATE "ai_providers" SET "id" = 'server-ai:' || "user_id" WHERE "id" = 'server-ai:' || "organization_id" || ':' || "user_id";
ALTER TABLE "agent_threads" ADD CONSTRAINT "agent_threads_ai_provider_id_ai_providers_id_fkey" FOREIGN KEY ("ai_provider_id") REFERENCES "ai_providers"("id") ON DELETE SET NULL;
ALTER TABLE "agent_threads" ADD CONSTRAINT "agent_threads_source_resume_id_resume_id_fkey" FOREIGN KEY ("source_resume_id") REFERENCES "resume"("id") ON DELETE SET NULL;
ALTER TABLE "agent_threads" ADD CONSTRAINT "agent_threads_working_resume_id_resume_id_fkey" FOREIGN KEY ("working_resume_id") REFERENCES "resume"("id") ON DELETE SET NULL;
ALTER TABLE "agent_threads" ADD CONSTRAINT "agent_threads_cover_letter_id_cover_letter_id_fkey" FOREIGN KEY ("cover_letter_id") REFERENCES "cover_letter"("id") ON DELETE SET NULL;
ALTER TABLE "agent_threads" ADD CONSTRAINT "agent_threads_application_id_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE CASCADE;
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_thread_id_agent_threads_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "agent_threads"("id") ON DELETE CASCADE;
ALTER TABLE "agent_attachments" ADD CONSTRAINT "agent_attachments_thread_id_agent_threads_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "agent_threads"("id") ON DELETE CASCADE;
ALTER TABLE "agent_attachments" ADD CONSTRAINT "agent_attachments_message_id_agent_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "agent_messages"("id") ON DELETE SET NULL;
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_thread_id_agent_threads_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "agent_threads"("id") ON DELETE CASCADE;
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_message_id_agent_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "agent_messages"("id") ON DELETE SET NULL;
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_resume_id_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "resume"("id") ON DELETE SET NULL;
ALTER TABLE "career_schedule" ADD CONSTRAINT "career_schedule_ai_provider_id_ai_providers_id_fkey" FOREIGN KEY ("ai_provider_id") REFERENCES "ai_providers"("id") ON DELETE SET NULL;
ALTER TABLE "resume" DROP CONSTRAINT IF EXISTS "resume_organization_id_id_unique";
ALTER TABLE "cover_letter" DROP CONSTRAINT IF EXISTS "cover_letter_organization_id_id_unique";
ALTER TABLE "ai_providers" DROP CONSTRAINT IF EXISTS "ai_providers_organization_id_id_unique";
ALTER TABLE "agent_threads" DROP CONSTRAINT IF EXISTS "agent_threads_organization_id_id_unique";
ALTER TABLE "agent_messages" DROP CONSTRAINT IF EXISTS "agent_messages_organization_id_id_unique";
DROP INDEX IF EXISTS "ai_providers_organization_id_user_id_index";
CREATE UNIQUE INDEX IF NOT EXISTS "ai_providers_user_id_index" ON "ai_providers" ("user_id") WHERE "is_default";
DROP INDEX IF EXISTS "ai_providers_organization_id_user_id_enabled_index";
CREATE INDEX IF NOT EXISTS "ai_providers_user_id_enabled_index" ON "ai_providers" ("user_id","enabled");
DROP INDEX IF EXISTS "ai_providers_organization_id_user_id_last_used_at_index";
CREATE INDEX IF NOT EXISTS "ai_providers_user_id_last_used_at_index" ON "ai_providers" ("user_id","last_used_at" DESC NULLS LAST);
DROP INDEX IF EXISTS "ai_providers_organization_id_user_id_created_at_index";
CREATE INDEX IF NOT EXISTS "ai_providers_user_id_created_at_index" ON "ai_providers" ("user_id","created_at");
DROP INDEX IF EXISTS "agent_threads_organization_id_user_id_status_last_message_at_index";
CREATE INDEX IF NOT EXISTS "agent_threads_user_id_status_last_message_at_index" ON "agent_threads" ("user_id","status","last_message_at" DESC NULLS LAST);
DROP INDEX IF EXISTS "agent_messages_organization_id_user_id_created_at_index";
CREATE INDEX IF NOT EXISTS "agent_messages_user_id_created_at_index" ON "agent_messages" ("user_id","created_at" DESC NULLS LAST);
DROP INDEX IF EXISTS "agent_attachments_organization_id_user_id_index";
CREATE INDEX IF NOT EXISTS "agent_attachments_user_id_index" ON "agent_attachments" ("user_id");
DROP INDEX IF EXISTS "agent_actions_organization_id_user_id_index";
DROP INDEX IF EXISTS "ai_content_report_organization_id_user_id_index";
ALTER TABLE "ai_providers" DROP CONSTRAINT IF EXISTS "ai_providers_organization_id_organization_id_fkey";
ALTER TABLE "ai_providers" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "agent_threads" DROP CONSTRAINT IF EXISTS "agent_threads_organization_id_organization_id_fkey";
ALTER TABLE "agent_threads" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "agent_messages" DROP CONSTRAINT IF EXISTS "agent_messages_organization_id_organization_id_fkey";
ALTER TABLE "agent_messages" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "agent_attachments" DROP CONSTRAINT IF EXISTS "agent_attachments_organization_id_organization_id_fkey";
ALTER TABLE "agent_attachments" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "agent_actions" DROP CONSTRAINT IF EXISTS "agent_actions_organization_id_organization_id_fkey";
ALTER TABLE "agent_actions" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "ai_content_report" DROP CONSTRAINT IF EXISTS "ai_content_report_organization_id_organization_id_fkey";
ALTER TABLE "ai_content_report" DROP COLUMN IF EXISTS "organization_id";
