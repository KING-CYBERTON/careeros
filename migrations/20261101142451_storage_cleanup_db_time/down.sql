-- CAREEROS P1-Q09 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- Removes the database-clock overload. The timestamp overload from P1-T09 was never touched, so servers built before
-- P1-Q09 keep working.
DROP FUNCTION IF EXISTS public.careeros_due_storage_cleanup(integer, text, text[], text);
