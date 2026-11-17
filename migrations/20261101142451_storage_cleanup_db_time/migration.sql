-- CAREEROS P1-Q09 (Q73): the storage cleanup worker compares next_attempt_at, which the database defaults to now(), against
-- the database clock instead of a JavaScript Date. Postgres keeps microseconds and JavaScript milliseconds, so a job
-- enqueued in the same millisecond as the pass counted as "not yet due" and was missed by the pass right after a delete.
-- The new overload takes no time argument and reads now() itself. The timestamp overload from P1-T09 stays for one
-- release so a server that has not been redeployed yet keeps working; drop it in the next release.
CREATE OR REPLACE FUNCTION public.careeros_due_storage_cleanup(max_rows integer, for_owner text DEFAULT NULL, for_keys text[] DEFAULT NULL, for_org text DEFAULT NULL)
RETURNS TABLE (id text, organization_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT j.id, j.organization_id FROM public.storage_cleanup_job j
	WHERE j.status = 'pending' AND j.next_attempt_at <= pg_catalog.now()
		AND ($2 IS NULL OR j.owner_id = $2)
		AND ($3 IS NULL OR j.storage_key = ANY($3))
		AND ($4 IS NULL OR j.organization_id = $4)
	ORDER BY j.next_attempt_at, j.id
	LIMIT $1
$$;--> statement-breakpoint
DO $$ BEGIN
	REVOKE ALL ON FUNCTION public.careeros_due_storage_cleanup(integer, text, text[], text) FROM PUBLIC;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'careeros_app') THEN
		GRANT EXECUTE ON FUNCTION public.careeros_due_storage_cleanup(integer, text, text[], text) TO careeros_app;
	END IF;
END $$;
