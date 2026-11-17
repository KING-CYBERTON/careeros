-- CAREEROS P1-T08: the assistant and AI tables (ai_providers, agent_threads, agent_messages, agent_attachments,
-- agent_actions, ai_content_report) get organization_id, a backfill, organization-led keys (D11) and row-level security
-- (D4), following P1-T04 to P1-T07. A reference to another tenant row becomes a composite foreign key
-- (organization_id, x_id) -> parent(organization_id, id), so the database refuses a cross-organization link for every
-- writer. Those keys are DEFERRABLE INITIALLY DEFERRED because the guest move changes one table's organization at a time
-- inside one transaction, and use ON DELETE SET NULL (x_id) (PostgreSQL 15+) so the tenant column is never nulled.
-- Two definer functions follow: the guest move and the boot-time list of organizations with a running assistant reply.
-- Every statement is idempotent so the migration can run twice. Runs as the migration (owner) role. Down migration:
-- down.sql here.
--> statement-breakpoint
-- 1. D7 safety net: a user with assistant or AI rows but no membership (T04 backfilled everyone that existed then, and
-- sign-up makes an organization since T03) still gets a personal organization, so the NOT NULL below cannot fail. Same
-- ids and marker as the T04 backfill, so a second run (or T04's to T07's) finds them.
INSERT INTO "organization" ("id", "name", "slug", "metadata")
SELECT
	'bf_' || md5(u."id"),
	CASE WHEN coalesce(nullif(btrim(u."name"), ''), nullif(btrim(u."username"), '')) IS NULL THEN 'Personal workspace'
		ELSE left(coalesce(nullif(btrim(u."name"), ''), nullif(btrim(u."username"), '')) || '''s workspace', 100) END,
	'u-' || right(md5(u."id"), 16),
	'{"careeros_backfill":true}'
FROM "user" u
WHERE NOT EXISTS (SELECT 1 FROM "member" m WHERE m."user_id" = u."id")
	AND (EXISTS (SELECT 1 FROM "ai_providers" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "agent_threads" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "agent_messages" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "agent_attachments" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "agent_actions" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "ai_content_report" x WHERE x."user_id" = u."id"))
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "member" ("id", "organization_id", "user_id", "role")
SELECT 'bf_' || md5(u."id"), 'bf_' || md5(u."id"), u."id", 'owner'
FROM "user" u
WHERE NOT EXISTS (SELECT 1 FROM "member" m WHERE m."user_id" = u."id")
	AND (EXISTS (SELECT 1 FROM "ai_providers" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "agent_threads" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "agent_messages" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "agent_attachments" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "agent_actions" x WHERE x."user_id" = u."id") OR EXISTS (SELECT 1 FROM "ai_content_report" x WHERE x."user_id" = u."id"))
	AND EXISTS (SELECT 1 FROM "organization" o WHERE o."id" = 'bf_' || md5(u."id"))
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 2. organization_id: nullable first, backfilled, then NOT NULL with its foreign key. A conversation takes the
-- organization of the application it is about, else of its working resume, its cover letter or its source resume; every
-- other row takes the owner's oldest membership (the T04 resume rule). Messages, attachments and actions take their
-- conversation's. Conversations go first because their children read theirs.
ALTER TABLE "ai_providers" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "agent_threads" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "agent_attachments" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "ai_content_report" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
UPDATE "ai_providers" t SET "organization_id" = (SELECT m."organization_id" FROM "member" m WHERE m."user_id" = t."user_id" ORDER BY m."created_at", m."id" LIMIT 1) WHERE t."organization_id" IS NULL;--> statement-breakpoint
UPDATE "agent_threads" t SET "organization_id" = coalesce(
	(SELECT a."organization_id" FROM "application" a WHERE a."id" = t."application_id"),
	(SELECT r."organization_id" FROM "resume" r WHERE r."id" = t."working_resume_id"),
	(SELECT c."organization_id" FROM "cover_letter" c WHERE c."id" = t."cover_letter_id"),
	(SELECT r."organization_id" FROM "resume" r WHERE r."id" = t."source_resume_id"),
	(SELECT m."organization_id" FROM "member" m WHERE m."user_id" = t."user_id" ORDER BY m."created_at", m."id" LIMIT 1)
) WHERE t."organization_id" IS NULL;--> statement-breakpoint
UPDATE "agent_messages" t SET "organization_id" = coalesce(
	(SELECT h."organization_id" FROM "agent_threads" h WHERE h."id" = t."thread_id"),
	(SELECT m."organization_id" FROM "member" m WHERE m."user_id" = t."user_id" ORDER BY m."created_at", m."id" LIMIT 1)
) WHERE t."organization_id" IS NULL;--> statement-breakpoint
UPDATE "agent_attachments" t SET "organization_id" = coalesce(
	(SELECT h."organization_id" FROM "agent_threads" h WHERE h."id" = t."thread_id"),
	(SELECT m."organization_id" FROM "member" m WHERE m."user_id" = t."user_id" ORDER BY m."created_at", m."id" LIMIT 1)
) WHERE t."organization_id" IS NULL;--> statement-breakpoint
UPDATE "agent_actions" t SET "organization_id" = coalesce(
	(SELECT h."organization_id" FROM "agent_threads" h WHERE h."id" = t."thread_id"),
	(SELECT m."organization_id" FROM "member" m WHERE m."user_id" = t."user_id" ORDER BY m."created_at", m."id" LIMIT 1)
) WHERE t."organization_id" IS NULL;--> statement-breakpoint
UPDATE "ai_content_report" t SET "organization_id" = (SELECT m."organization_id" FROM "member" m WHERE m."user_id" = t."user_id" ORDER BY m."created_at", m."id" LIMIT 1) WHERE t."organization_id" IS NULL;--> statement-breakpoint
-- 3. The old single-column foreign keys go first, so the next steps can change ids and clear links. The composite keys
-- in step 6 replace them.
ALTER TABLE "agent_actions" DROP CONSTRAINT IF EXISTS "agent_actions_thread_id_agent_threads_id_fkey";--> statement-breakpoint
ALTER TABLE "agent_actions" DROP CONSTRAINT IF EXISTS "agent_actions_message_id_agent_messages_id_fkey";--> statement-breakpoint
ALTER TABLE "agent_actions" DROP CONSTRAINT IF EXISTS "agent_actions_resume_id_resume_id_fkey";--> statement-breakpoint
ALTER TABLE "agent_attachments" DROP CONSTRAINT IF EXISTS "agent_attachments_thread_id_agent_threads_id_fkey";--> statement-breakpoint
ALTER TABLE "agent_attachments" DROP CONSTRAINT IF EXISTS "agent_attachments_message_id_agent_messages_id_fkey";--> statement-breakpoint
ALTER TABLE "agent_messages" DROP CONSTRAINT IF EXISTS "agent_messages_thread_id_agent_threads_id_fkey";--> statement-breakpoint
ALTER TABLE "agent_threads" DROP CONSTRAINT IF EXISTS "agent_threads_ai_provider_id_ai_providers_id_fkey";--> statement-breakpoint
ALTER TABLE "agent_threads" DROP CONSTRAINT IF EXISTS "agent_threads_source_resume_id_resume_id_fkey";--> statement-breakpoint
ALTER TABLE "agent_threads" DROP CONSTRAINT IF EXISTS "agent_threads_working_resume_id_resume_id_fkey";--> statement-breakpoint
ALTER TABLE "agent_threads" DROP CONSTRAINT IF EXISTS "agent_threads_cover_letter_id_cover_letter_id_fkey";--> statement-breakpoint
ALTER TABLE "agent_threads" DROP CONSTRAINT IF EXISTS "agent_threads_application_id_application_id_fkey";--> statement-breakpoint
ALTER TABLE "career_schedule" DROP CONSTRAINT IF EXISTS "career_schedule_ai_provider_id_ai_providers_id_fkey";--> statement-breakpoint
-- 4. The server-managed connection ("Server AI", set up by the administrator through the environment) had the id
-- server-ai:<user>. It is now per organization, server-ai:<organization>:<user>, so one user can have one in each
-- organization. The row holds no secret, so it is renamed in place and the links to it follow.
UPDATE "agent_threads" t SET "ai_provider_id" = 'server-ai:' || p."organization_id" || ':' || p."user_id"
	FROM "ai_providers" p WHERE t."ai_provider_id" = p."id" AND p."id" = 'server-ai:' || p."user_id";--> statement-breakpoint
UPDATE "career_schedule" t SET "ai_provider_id" = 'server-ai:' || p."organization_id" || ':' || p."user_id"
	FROM "ai_providers" p WHERE t."ai_provider_id" = p."id" AND p."id" = 'server-ai:' || p."user_id";--> statement-breakpoint
UPDATE "ai_providers" SET "id" = 'server-ai:' || "organization_id" || ':' || "user_id" WHERE "id" = 'server-ai:' || "user_id";--> statement-breakpoint
-- 5. A link that points into another organization than its row (a user with several memberships whose connection or
-- document sits in a different one) cannot be kept: it is cleared, so the conversation stays readable and the user
-- picks a connection or document of its own organization. The application link always matches, because a conversation
-- takes its application's organization.
UPDATE "agent_threads" t SET "ai_provider_id" = NULL WHERE t."ai_provider_id" IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM "ai_providers" p WHERE p."id" = t."ai_provider_id" AND p."organization_id" = t."organization_id");--> statement-breakpoint
UPDATE "agent_threads" t SET "source_resume_id" = NULL WHERE t."source_resume_id" IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM "resume" r WHERE r."id" = t."source_resume_id" AND r."organization_id" = t."organization_id");--> statement-breakpoint
UPDATE "agent_threads" t SET "working_resume_id" = NULL WHERE t."working_resume_id" IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM "resume" r WHERE r."id" = t."working_resume_id" AND r."organization_id" = t."organization_id");--> statement-breakpoint
UPDATE "agent_threads" t SET "cover_letter_id" = NULL WHERE t."cover_letter_id" IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM "cover_letter" c WHERE c."id" = t."cover_letter_id" AND c."organization_id" = t."organization_id");--> statement-breakpoint
UPDATE "agent_actions" t SET "resume_id" = NULL WHERE t."resume_id" IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM "resume" r WHERE r."id" = t."resume_id" AND r."organization_id" = t."organization_id");--> statement-breakpoint
UPDATE "agent_actions" t SET "message_id" = NULL WHERE t."message_id" IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM "agent_messages" m WHERE m."id" = t."message_id" AND m."organization_id" = t."organization_id");--> statement-breakpoint
UPDATE "agent_attachments" t SET "message_id" = NULL WHERE t."message_id" IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM "agent_messages" m WHERE m."id" = t."message_id" AND m."organization_id" = t."organization_id");--> statement-breakpoint
UPDATE "career_schedule" t SET "ai_provider_id" = NULL WHERE t."ai_provider_id" IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM "ai_providers" p WHERE p."id" = t."ai_provider_id" AND p."organization_id" = t."organization_id");--> statement-breakpoint
ALTER TABLE "ai_providers" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_threads" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_messages" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_attachments" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_actions" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_content_report" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_providers_organization_id_organization_id_fkey' AND conrelid = '"ai_providers"'::regclass) THEN
		ALTER TABLE "ai_providers" ADD CONSTRAINT "ai_providers_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_threads_organization_id_organization_id_fkey' AND conrelid = '"agent_threads"'::regclass) THEN
		ALTER TABLE "agent_threads" ADD CONSTRAINT "agent_threads_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_messages_organization_id_organization_id_fkey' AND conrelid = '"agent_messages"'::regclass) THEN
		ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_attachments_organization_id_organization_id_fkey' AND conrelid = '"agent_attachments"'::regclass) THEN
		ALTER TABLE "agent_attachments" ADD CONSTRAINT "agent_attachments_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_actions_organization_id_organization_id_fkey' AND conrelid = '"agent_actions"'::regclass) THEN
		ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_content_report_organization_id_organization_id_fkey' AND conrelid = '"ai_content_report"'::regclass) THEN
		ALTER TABLE "ai_content_report" ADD CONSTRAINT "ai_content_report_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
END $$;--> statement-breakpoint
-- 6. Composite foreign keys. Each parent needs the unique key (organization_id, id) first. A cascade (the messages of a
-- conversation, a conversation of a deleted application) deletes the row; a SET NULL link clears only its own id column.
-- DEFERRABLE INITIALLY DEFERRED: the guest move updates organization_id table by table inside one transaction, and the
-- keys are checked when it commits.
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resume_organization_id_id_unique' AND conrelid = '"resume"'::regclass) THEN
		ALTER TABLE "resume" ADD CONSTRAINT "resume_organization_id_id_unique" UNIQUE ("organization_id", "id");
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cover_letter_organization_id_id_unique' AND conrelid = '"cover_letter"'::regclass) THEN
		ALTER TABLE "cover_letter" ADD CONSTRAINT "cover_letter_organization_id_id_unique" UNIQUE ("organization_id", "id");
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_providers_organization_id_id_unique' AND conrelid = '"ai_providers"'::regclass) THEN
		ALTER TABLE "ai_providers" ADD CONSTRAINT "ai_providers_organization_id_id_unique" UNIQUE ("organization_id", "id");
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_threads_organization_id_id_unique' AND conrelid = '"agent_threads"'::regclass) THEN
		ALTER TABLE "agent_threads" ADD CONSTRAINT "agent_threads_organization_id_id_unique" UNIQUE ("organization_id", "id");
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_messages_organization_id_id_unique' AND conrelid = '"agent_messages"'::regclass) THEN
		ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_organization_id_id_unique" UNIQUE ("organization_id", "id");
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_threads_org_ai_provider_fkey' AND conrelid = '"agent_threads"'::regclass) THEN
		ALTER TABLE "agent_threads" ADD CONSTRAINT "agent_threads_org_ai_provider_fkey" FOREIGN KEY ("organization_id", "ai_provider_id") REFERENCES "ai_providers"("organization_id", "id") ON DELETE SET NULL ("ai_provider_id") DEFERRABLE INITIALLY DEFERRED;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_threads_org_source_resume_fkey' AND conrelid = '"agent_threads"'::regclass) THEN
		ALTER TABLE "agent_threads" ADD CONSTRAINT "agent_threads_org_source_resume_fkey" FOREIGN KEY ("organization_id", "source_resume_id") REFERENCES "resume"("organization_id", "id") ON DELETE SET NULL ("source_resume_id") DEFERRABLE INITIALLY DEFERRED;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_threads_org_working_resume_fkey' AND conrelid = '"agent_threads"'::regclass) THEN
		ALTER TABLE "agent_threads" ADD CONSTRAINT "agent_threads_org_working_resume_fkey" FOREIGN KEY ("organization_id", "working_resume_id") REFERENCES "resume"("organization_id", "id") ON DELETE SET NULL ("working_resume_id") DEFERRABLE INITIALLY DEFERRED;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_threads_org_cover_letter_fkey' AND conrelid = '"agent_threads"'::regclass) THEN
		ALTER TABLE "agent_threads" ADD CONSTRAINT "agent_threads_org_cover_letter_fkey" FOREIGN KEY ("organization_id", "cover_letter_id") REFERENCES "cover_letter"("organization_id", "id") ON DELETE SET NULL ("cover_letter_id") DEFERRABLE INITIALLY DEFERRED;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_threads_org_application_fkey' AND conrelid = '"agent_threads"'::regclass) THEN
		ALTER TABLE "agent_threads" ADD CONSTRAINT "agent_threads_org_application_fkey" FOREIGN KEY ("organization_id", "application_id") REFERENCES "application"("organization_id", "id") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_messages_org_thread_fkey' AND conrelid = '"agent_messages"'::regclass) THEN
		ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_org_thread_fkey" FOREIGN KEY ("organization_id", "thread_id") REFERENCES "agent_threads"("organization_id", "id") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_attachments_org_thread_fkey' AND conrelid = '"agent_attachments"'::regclass) THEN
		ALTER TABLE "agent_attachments" ADD CONSTRAINT "agent_attachments_org_thread_fkey" FOREIGN KEY ("organization_id", "thread_id") REFERENCES "agent_threads"("organization_id", "id") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_attachments_org_message_fkey' AND conrelid = '"agent_attachments"'::regclass) THEN
		ALTER TABLE "agent_attachments" ADD CONSTRAINT "agent_attachments_org_message_fkey" FOREIGN KEY ("organization_id", "message_id") REFERENCES "agent_messages"("organization_id", "id") ON DELETE SET NULL ("message_id") DEFERRABLE INITIALLY DEFERRED;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_actions_org_thread_fkey' AND conrelid = '"agent_actions"'::regclass) THEN
		ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_org_thread_fkey" FOREIGN KEY ("organization_id", "thread_id") REFERENCES "agent_threads"("organization_id", "id") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_actions_org_message_fkey' AND conrelid = '"agent_actions"'::regclass) THEN
		ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_org_message_fkey" FOREIGN KEY ("organization_id", "message_id") REFERENCES "agent_messages"("organization_id", "id") ON DELETE SET NULL ("message_id") DEFERRABLE INITIALLY DEFERRED;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_actions_org_resume_fkey' AND conrelid = '"agent_actions"'::regclass) THEN
		ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_org_resume_fkey" FOREIGN KEY ("organization_id", "resume_id") REFERENCES "resume"("organization_id", "id") ON DELETE SET NULL ("resume_id") DEFERRABLE INITIALLY DEFERRED;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'career_schedule_org_ai_provider_fkey' AND conrelid = '"career_schedule"'::regclass) THEN
		ALTER TABLE "career_schedule" ADD CONSTRAINT "career_schedule_org_ai_provider_fkey" FOREIGN KEY ("organization_id", "ai_provider_id") REFERENCES "ai_providers"("organization_id", "id") ON DELETE SET NULL ("ai_provider_id") DEFERRABLE INITIALLY DEFERRED;
	END IF;
END $$;--> statement-breakpoint
-- 7. D11: saved connections are per (organization, user), and the one default is per (organization, user). Every index
-- that led with user_id leads with the organization first.
DROP INDEX IF EXISTS "ai_providers_user_id_index";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_providers_organization_id_user_id_index" ON "ai_providers" ("organization_id","user_id") WHERE "is_default";--> statement-breakpoint
DROP INDEX IF EXISTS "ai_providers_user_id_enabled_index";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_providers_organization_id_user_id_enabled_index" ON "ai_providers" ("organization_id","user_id","enabled");--> statement-breakpoint
DROP INDEX IF EXISTS "ai_providers_user_id_last_used_at_index";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_providers_organization_id_user_id_last_used_at_index" ON "ai_providers" ("organization_id","user_id","last_used_at" DESC NULLS LAST);--> statement-breakpoint
DROP INDEX IF EXISTS "ai_providers_user_id_created_at_index";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_providers_organization_id_user_id_created_at_index" ON "ai_providers" ("organization_id","user_id","created_at");--> statement-breakpoint
DROP INDEX IF EXISTS "agent_threads_user_id_status_last_message_at_index";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_threads_organization_id_user_id_status_last_message_at_index" ON "agent_threads" ("organization_id","user_id","status","last_message_at" DESC NULLS LAST);--> statement-breakpoint
DROP INDEX IF EXISTS "agent_messages_user_id_created_at_index";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_messages_organization_id_user_id_created_at_index" ON "agent_messages" ("organization_id","user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
DROP INDEX IF EXISTS "agent_attachments_user_id_index";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_attachments_organization_id_user_id_index" ON "agent_attachments" ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_actions_organization_id_user_id_index" ON "agent_actions" ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_content_report_organization_id_user_id_index" ON "ai_content_report" ("organization_id","user_id");--> statement-breakpoint
-- 8. Row-level security (D4), exactly as P1-T04: FORCE applies the policy to the table owner too, so only owner_access
-- lets the owner role (migrations, definer functions) see every organization. careeros_app only matches its own
-- organization; an unset setting is NULL and matches nothing (fail closed).
ALTER TABLE "ai_providers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_providers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "ai_providers";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_providers"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "ai_providers";--> statement-breakpoint
CREATE POLICY "owner_access" ON "ai_providers" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "agent_threads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_threads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_threads";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_threads"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "agent_threads";--> statement-breakpoint
CREATE POLICY "owner_access" ON "agent_threads" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "agent_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_messages";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_messages"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "agent_messages";--> statement-breakpoint
CREATE POLICY "owner_access" ON "agent_messages" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "agent_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_attachments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_attachments";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_attachments"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "agent_attachments";--> statement-breakpoint
CREATE POLICY "owner_access" ON "agent_attachments" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "agent_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_actions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_actions";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_actions"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "agent_actions";--> statement-breakpoint
CREATE POLICY "owner_access" ON "agent_actions" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "ai_content_report" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_content_report" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "ai_content_report";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_content_report"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "ai_content_report";--> statement-breakpoint
CREATE POLICY "owner_access" ON "ai_content_report" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
-- 9. Guest linking. careeros_move_guest_agent(from_user, to_user, to_org) moves the guest's saved connections,
-- conversations (with their messages, attachments and actions) and content reports into the target user's organization,
-- after the documents and applications they point at (the same checks as the other guest moves: the source must be an
-- anonymous user and the target organization must have the target user as a member). Notes:
--   - The server-managed connection (id server-ai:<organization>:<user>) is not moved. The target's own managed
--     connection is created if missing, the guest's links to it are re-pointed, and the guest's row is deleted.
--   - The guest's default connection yields to the target's: when the target already has a default in the target
--     organization, the guest's connections arrive without the default flag.
--   - A schedule that stays with the guest (not tied to an application of the target) loses its connection link, because
--     the connection moves away from the guest's organization.
--   - A conversation moves only when its application, if it has one, is now in the target organization. Its links to a
--     resume or cover letter outside the target organization are cleared. Messages, attachments and actions follow
--     their conversation; attachment storage keys follow the owner's id, as the stored files do.
--   - The composite foreign keys are deferred, so the order of the updates inside the transaction does not matter; they
--     are checked when it commits.
CREATE OR REPLACE FUNCTION public.careeros_move_guest_agent(from_user text, to_user text, to_org text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	guest_managed text[];
	target_managed text := 'server-ai:' || to_org || ':' || to_user;
BEGIN
	IF from_user = to_user THEN RETURN; END IF;
	IF to_org IS NULL THEN
		IF EXISTS (SELECT 1 FROM public.ai_providers WHERE user_id = from_user)
			OR EXISTS (SELECT 1 FROM public.agent_threads WHERE user_id = from_user)
			OR EXISTS (SELECT 1 FROM public.ai_content_report WHERE user_id = from_user) THEN
			RAISE EXCEPTION 'careeros_move_guest_agent: the target user has no organization';
		END IF;
		RETURN;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public."user" WHERE id = from_user AND is_anonymous) THEN
		RAISE EXCEPTION 'careeros_move_guest_agent: the source is not a guest account';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public.member WHERE organization_id = to_org AND user_id = to_user) THEN
		RAISE EXCEPTION 'careeros_move_guest_agent: the target user is not a member of the target organization';
	END IF;

	-- Schedules that stay with the guest cannot keep a connection that moves.
	UPDATE public.career_schedule SET ai_provider_id = NULL
		WHERE user_id = from_user AND organization_id <> to_org AND ai_provider_id IS NOT NULL;

	-- The server-managed connection: re-point the guest's links to the target's own, then drop the guest's row.
	SELECT coalesce(array_agg(id), ARRAY[]::text[]) INTO guest_managed FROM public.ai_providers
		WHERE user_id = from_user AND id = 'server-ai:' || organization_id || ':' || user_id;
	IF cardinality(guest_managed) > 0 THEN
		INSERT INTO public.ai_providers (id, user_id, organization_id, label, provider, model, base_url, encrypted_api_key,
			api_key_salt, api_key_hash, api_key_preview, test_status, enabled, is_default)
		SELECT target_managed, to_user, to_org, g.label, g.provider, g.model, g.base_url, g.encrypted_api_key,
			g.api_key_salt, g.api_key_hash, g.api_key_preview, g.test_status, g.enabled,
			NOT EXISTS (SELECT 1 FROM public.ai_providers d WHERE d.organization_id = to_org AND d.user_id = to_user AND d.is_default)
		FROM public.ai_providers g WHERE g.id = guest_managed[1]
		ON CONFLICT (id) DO NOTHING;
		UPDATE public.agent_threads SET ai_provider_id = target_managed WHERE ai_provider_id = ANY (guest_managed);
		UPDATE public.career_schedule SET ai_provider_id = target_managed WHERE ai_provider_id = ANY (guest_managed);
		DELETE FROM public.ai_providers WHERE id = ANY (guest_managed);
	END IF;

	-- Defaults must not conflict: the guest's default yields to the target's.
	IF EXISTS (SELECT 1 FROM public.ai_providers WHERE organization_id = to_org AND user_id = to_user AND is_default) THEN
		UPDATE public.ai_providers SET is_default = false WHERE user_id = from_user AND is_default;
	END IF;
	UPDATE public.ai_providers SET user_id = to_user, organization_id = to_org WHERE user_id = from_user;

	-- Conversations: only those whose application (if any) is now in the target organization.
	UPDATE public.agent_threads SET
		source_resume_id = CASE WHEN EXISTS (SELECT 1 FROM public.resume r WHERE r.id = source_resume_id AND r.organization_id = to_org)
			THEN source_resume_id END,
		working_resume_id = CASE WHEN EXISTS (SELECT 1 FROM public.resume r WHERE r.id = working_resume_id AND r.organization_id = to_org)
			THEN working_resume_id END,
		cover_letter_id = CASE WHEN EXISTS (SELECT 1 FROM public.cover_letter c WHERE c.id = cover_letter_id AND c.organization_id = to_org)
			THEN cover_letter_id END
		WHERE user_id = from_user
			AND (application_id IS NULL OR EXISTS (SELECT 1 FROM public.application a WHERE a.id = application_id AND a.organization_id = to_org));
	UPDATE public.agent_threads SET user_id = to_user, organization_id = to_org
		WHERE user_id = from_user
			AND (application_id IS NULL OR EXISTS (SELECT 1 FROM public.application a WHERE a.id = application_id AND a.organization_id = to_org));
	UPDATE public.agent_messages SET user_id = to_user, organization_id = to_org
		WHERE user_id = from_user AND thread_id IN (SELECT id FROM public.agent_threads WHERE organization_id = to_org AND user_id = to_user);
	UPDATE public.agent_attachments SET user_id = to_user, organization_id = to_org,
		storage_key = replace(storage_key, 'uploads/' || from_user || '/', 'uploads/' || to_user || '/')
		WHERE user_id = from_user AND thread_id IN (SELECT id FROM public.agent_threads WHERE organization_id = to_org AND user_id = to_user);
	UPDATE public.agent_actions SET user_id = to_user, organization_id = to_org,
		resume_id = CASE WHEN EXISTS (SELECT 1 FROM public.resume r WHERE r.id = resume_id AND r.organization_id = to_org)
			THEN resume_id END
		WHERE user_id = from_user AND thread_id IN (SELECT id FROM public.agent_threads WHERE organization_id = to_org AND user_id = to_user);
	-- Reports belong to the reporting account; they follow it.
	UPDATE public.ai_content_report SET user_id = to_user, organization_id = to_org WHERE user_id = from_user;
END
$$;--> statement-breakpoint
-- 10. Assistant replies (D9). At boot the server has no organization, and row-level security hides every conversation
-- from it. This returns only organization ids (never row data): those with a conversation that still holds a run
-- claim. The reaper then works inside withOrgContext, one organization at a time.
CREATE OR REPLACE FUNCTION public.careeros_orgs_with_active_agent_runs() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT DISTINCT t.organization_id FROM public.agent_threads t WHERE t.active_run_id IS NOT NULL
$$;--> statement-breakpoint
DO $$ BEGIN
	REVOKE ALL ON FUNCTION public.careeros_move_guest_agent(text, text, text) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_orgs_with_active_agent_runs() FROM PUBLIC;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'careeros_app') THEN
		GRANT EXECUTE ON FUNCTION public.careeros_move_guest_agent(text, text, text) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_orgs_with_active_agent_runs() TO careeros_app;
	END IF;
END $$;

