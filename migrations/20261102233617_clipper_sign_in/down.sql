-- CAREEROS P5-T02 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- Drops the clipper sign-in tables and triggers. Every clipper token stops working; members sign the extension in again.
DROP TRIGGER IF EXISTS careeros_clipper_member_delete ON public."member";
DROP TRIGGER IF EXISTS careeros_clipper_user_ban ON public."user";
DROP FUNCTION IF EXISTS public.careeros_clipper_revoke_on_member_delete();
DROP FUNCTION IF EXISTS public.careeros_clipper_revoke_on_ban();
DROP TABLE IF EXISTS "clipper_token";
DROP TABLE IF EXISTS "device_code";
