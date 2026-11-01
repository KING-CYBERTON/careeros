# P1-Q09: Storage cleanup uses database time, and the remaining suites are isolated

**Status:** Approved (Opus, 2026-11-01). **Thread:** 2 QA. **Depends on:** P1-Q08 merged.
**Branch:** `fix/P1-Q09-cleanup-db-time` (from develop)

## 1. Production fix (Q73)

- `runStorageCleanup` and `careeros_due_storage_cleanup` compare `next_attempt_at` against Postgres `now()`, not a JavaScript `Date`. A pass made right after a delete must see the job that delete just enqueued.
  - Change the function to take no time argument, or make that argument optional and default it to `now()`, keeping the function signature backward compatible for one release.
  - Do the same for any other D9 worker that passes JavaScript time into a "due" comparison against database-defaulted timestamps: career jobs, the DNS re-check and the trash purge. Audit them, and fix each one only where the column is defaulted by the database.
- Tests:
  - enqueue then immediately run, as the same request, picks up the job;
  - the existing fixtures still pass without the backdating workaround. Remove the Q08 backdating where it is no longer needed.

## 2. Remaining shared-database suites (Q08 review, F2)

- Move every suite that replays migrations into a schema of the shared database onto `createIsolatedTestDatabase`. Replaying function DDL rewrites the real `public` definer functions and their grants.
- For `agent-tenancy`, make the module-level db injectable (or resolve it lazily), so that the suite can bind to its isolated database. Production behaviour must not change.
- Suites with hand-built schemas (`cover-letters/service`, `web-access/credentials`, `listing`) also move, unless they demonstrably never run function DDL. In that case, document why in a comment.
- **Proof:** run the converted suites 20 times concurrently with the rest of the api suite, then run the full api, tenancy and db suites twice.

## Acceptance

- careeros-ci is fully green. Develop's push run after the merge is green.
- No skips, retries or loosened assertions.
