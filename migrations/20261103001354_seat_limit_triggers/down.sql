-- CAREEROS P3-T02 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- It drops the two triggers and their function. No data is lost; the database stops enforcing the seat limit (the
-- TypeScript checks remain, but are not safe against concurrent requests).
DROP TRIGGER IF EXISTS "careeros_invitation_seat_limit" ON "invitation";
DROP TRIGGER IF EXISTS "careeros_member_seat_limit" ON "member";
DROP FUNCTION IF EXISTS public.careeros_enforce_seat_limit();
