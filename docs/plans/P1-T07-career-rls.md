# P1-T07: Career tables and the career scheduler join the tenant boundary

**Status:** Approved (Opus, 2026-11-01). **Thread:** 1 Build. **Phase plan:** P1-PHASE-PLAN.md (D4, D9, D11).
**Depends on:** P1-T06. This branch stacks on `feature/P1-T06-applications-rls`, and the PR is retargeted to develop once T06 merges.
**Branch:** `feature/P1-T07-career-rls`

## Scope

These eleven tables get `organization_id`, ENABLE and FORCE RLS, and the `tenant_isolation` and `owner_access` policies, exactly as in T04 to T06:
`career_profile`, `career_fact`, `career_story`, `career_artifact`, `career_schedule`, `career_job`, `career_notification`, `career_opportunity`, `career_workspace`, `career_transcript`, `career_answer`.

## Requirements

1. **Columns and backfill.**
   - Add `organization_id text NOT NULL`, with an FK to `organization(id)` ON DELETE CASCADE. Every index that currently leads with `user_id` becomes org-led.
   - Rows linked to an application, or to a job, schedule or workspace that has one, take the application's `organization_id`.
   - Every other row takes the owner's oldest membership (`ORDER BY created_at, id`), using the same personal-org fallback as T05 and T06.
   - The migration is idempotent and ships a `down.sql`, refusing to run where a user has rows in two orgs (as in T06).
2. **Keys (D11).**
   - `career_profile` is keyed `(organization_id, user_id)`.
   - The unique keys `(user_id, source_key)`, `(user_id, key)` and `(user_id, url)` become `(organization_id, user_id, …)`.
   - `career_workspace` stays keyed by `application_id`. Its `organization_id` must equal its application's; enforce that with a composite FK `(organization_id, application_id) → application(organization_id, id)`, or a trigger if the FK is impractical, and explain the choice.
3. **Cross-org references.** Every `application_id`, `source_application_id`, `tracked_application_id`, `job_id`, `schedule_id` and `ai_provider_id` written from the API must point at a row in the same org.
   - Use scoped reads, and add helpers where the service trusts client ids.
   - A cross-org id answers NOT_FOUND.
   - `ai_provider` gets no RLS until T08, so just check its `user_id` ownership as today and leave a TODO(P1-T08).
4. **Scheduler (D9).**
   - Replace the T06 interim functions `careeros_application_is_open` and `careeros_application_org`. Drop them in this migration, and recreate them in `down.sql`.
   - New definer functions, with the pinned search_path, EXECUTE revoked from PUBLIC and granted to `careeros_app`:
     - `careeros_due_career_jobs(now timestamptz, lease_limit int)` returns only `(id, organization_id)` of claimable jobs.
     - `careeros_orgs_with_due_career_schedules(now timestamptz)` returns org ids, if schedule materialisation scans across users.
   - The runner claims and leases each job, and reads or writes everything else for it, inside `withOrgContext(job.organization_id, …)`. Discovery schedules are no longer unscoped.
   - A per-job or per-org failure must not stop the others. Keep the existing lease and retry semantics.
5. **Guest linking.** Extend the guest move to the career tables, either with `careeros_move_guest_career(from_user, to_user, to_org)` or by folding it into the existing function. Use the same anonymous-source and target-membership checks. Profile conflicts keep the current CONFLICT behaviour.
6. **Code.**
   - Every insert and upsert sets `organizationId`, and every upsert conflict target matches the new keys.
   - The tenant column is omitted from outputs and from the account export, which covers the active org only, as decided in the T06 review.
7. **Tests.**
   - Register all eleven tables in `packages/isolation-testing`.
   - A `career-tenancy.integration.test.ts` covering:
     - two-org separation, including the profile per (org, user);
     - cross-org id refusals;
     - the scheduler running jobs from two orgs, each under its own context, with a failure in one not blocking the other;
     - the guest move.
   - A migration test covering backfill, key change, rerun, the down refusal and down/up.
   - Update the e2e seed in `tests/e2e/specs/discovery.spec.ts` (Q37 from P1-Q07): insert `organization_id` into `career_opportunity`, taken from the user's active org. Seed through `withSeedPool` or `createSeedPool`.
8. **Upstream edits** carry `CAREEROS:` markers, with rows in `docs/UPSTREAM_PATCHES.md`. Log open points in `docs/questions.md`, using the next free number after whatever is on develop when you push.

## Acceptance

- careeros-ci is fully green on the PR, including e2e.
- The isolation coverage check lists no career table as uncovered.
- Running as `careeros_app` with no org context, a select on any career table returns zero rows.
