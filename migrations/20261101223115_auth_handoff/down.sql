-- CAREEROS P2-T05 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- Drops the handoff table. Rows are short-lived (10 minutes) and hold only hashes, so nothing of value is lost; any
-- sign-in in flight simply has to be started again.
DROP TABLE IF EXISTS "auth_handoff";
