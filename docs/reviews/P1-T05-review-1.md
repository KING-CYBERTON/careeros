# P1-T05 Cover letters RLS: Opus review 1

**Branch:** `feature/P1-T05-cover-letters-rls` @ `ade6de1ec` · **Spec:** [plans/P1-T05-cover-letters-rls.md](../plans/P1-T05-cover-letters-rls.md) · **Verdict:** Changes requested (1 High)

The batch follows the T04 pattern closely. The migration, the policies, the `sourceResumeId` check, and the 7-test isolation suite against `careeros_app` are all right.

## Findings

### H1 (High): Q33, the scheduled trash purge does nothing since T04

`documentsService.purgeExpiredTrash` runs from the scheduler with no org scope. Under FORCE RLS it sees no rows, so expired trashed resumes (since T04) and cover letters (now) are never purged. That silently breaks the retention promise users get when they move something to Trash. It is a T04 regression, fixed here because this batch extends it.

**Fix (the pattern D9 will reuse for the career scheduler in T07):**

1. Add a security-definer function `careeros_orgs_with_expired_trash(cutoff timestamptz) RETURNS SETOF text`. It returns the distinct `organization_id`s that have trashed resumes or cover letters older than the cutoff. It returns ids only, never row data. Pin `search_path`, revoke EXECUTE from PUBLIC and grant it to `careeros_app`, as in T04.
2. The scheduled purge calls it, then runs the existing purge once per org inside `withOrgContext(orgId, …)`. One org's failure is logged and does not stop the others.
3. Tests:
   - Expired trash in two orgs is purged by one tick.
   - Non-expired trash stays.
   - A failure in one org does not stop the other.
   - The function returns nothing to a role without EXECUTE.

## Questions answered

- **Q32:** `careeros_move_guest_cover_letters` is accepted, with the same narrowing as the T04 resume function.
- **Q33:** see H1.
- **Q34:** the D7 safety net is accepted.
- **Q35:** a sibling migration test is accepted.
- **Q36:** the extra scoped read is accepted.
