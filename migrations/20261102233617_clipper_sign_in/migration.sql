CREATE TABLE "clipper_token" (
	"id" text PRIMARY KEY,
	"token_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"host" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_code" (
	"id" text PRIMARY KEY,
	"device_code" text NOT NULL,
	"user_code" text NOT NULL,
	"user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"last_polled_at" timestamp with time zone,
	"polling_interval" integer,
	"client_id" text,
	"scope" text,
	"organization_id" text NOT NULL,
	"request_host" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "clipper_token_token_hash_idx" ON "clipper_token" ("token_hash");--> statement-breakpoint
CREATE INDEX "clipper_token_user_id_idx" ON "clipper_token" ("user_id","organization_id");--> statement-breakpoint
CREATE INDEX "clipper_token_expires_at_idx" ON "clipper_token" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "device_code_device_code_idx" ON "device_code" ("device_code");--> statement-breakpoint
CREATE UNIQUE INDEX "device_code_user_code_idx" ON "device_code" ("user_code");--> statement-breakpoint
CREATE INDEX "device_code_expires_at_idx" ON "device_code" ("expires_at");--> statement-breakpoint
CREATE INDEX "device_code_user_id_organization_id_idx" ON "device_code" ("user_id","organization_id");--> statement-breakpoint
ALTER TABLE "clipper_token" ADD CONSTRAINT "clipper_token_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "clipper_token" ADD CONSTRAINT "clipper_token_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "device_code" ADD CONSTRAINT "device_code_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "device_code" ADD CONSTRAINT "device_code_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
--> statement-breakpoint
-- CAREEROS (P5-T02): a member who leaves an organization loses their clipper sign-ins and any unredeemed device code for
-- it. A trigger, not application code, so every way of removing a member (the organization plugin, an admin, SQL) is
-- covered. Runs as the caller; neither table has row level security. Table names are unqualified so the test replay
-- of every migration into a throwaway schema resolves them there.
CREATE OR REPLACE FUNCTION public.careeros_clipper_revoke_on_member_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	DELETE FROM clipper_token WHERE user_id = OLD.user_id AND organization_id = OLD.organization_id;
	DELETE FROM device_code WHERE user_id = OLD.user_id AND organization_id = OLD.organization_id;
	RETURN OLD;
END
$$;--> statement-breakpoint
CREATE TRIGGER careeros_clipper_member_delete AFTER DELETE ON "member"
	FOR EACH ROW EXECUTE FUNCTION public.careeros_clipper_revoke_on_member_delete();--> statement-breakpoint
-- A platform suspension of the account (ban) revokes every clipper sign-in of that account.
CREATE OR REPLACE FUNCTION public.careeros_clipper_revoke_on_ban() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	DELETE FROM clipper_token WHERE user_id = NEW.id;
	DELETE FROM device_code WHERE user_id = NEW.id;
	RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER careeros_clipper_user_ban AFTER UPDATE OF banned ON "user"
	FOR EACH ROW WHEN (NEW.banned IS TRUE AND OLD.banned IS DISTINCT FROM TRUE)
	EXECUTE FUNCTION public.careeros_clipper_revoke_on_ban();--> statement-breakpoint
DO $$ BEGIN
	REVOKE ALL ON FUNCTION public.careeros_clipper_revoke_on_member_delete() FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_clipper_revoke_on_ban() FROM PUBLIC;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'careeros_app') THEN
		GRANT EXECUTE ON FUNCTION public.careeros_clipper_revoke_on_member_delete() TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_clipper_revoke_on_ban() TO careeros_app;
	END IF;
END $$;
