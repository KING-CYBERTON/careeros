# P0-Q02 — Review 1

**PR:** https://github.com/KING-CYBERTON/careeros/pull/9 · **Reviewer:** Opus (Thread 2) · **Date:** 2026-10-31

All 15 test-plan rows are automated and pass locally (18 tests). The Q01 rollback finding is fixed with a test. No upstream files are touched.

Checks Opus verified in the code:

- The superuser/BYPASSRLS guard runs before every read in the DB, coverage and no-org checks.
- Seeding uses the owner pool. Every read goes through `withOrgContext` on the app pool.
- Org A sanity check (exactly 1 row) prevents a vacuous pass.
- Row 14 asserts that the upstream `user` table exists, so the coverage check on `public` isn't vacuous.

Deviation accepted: the coverage check reads `pg_attribute`, because `information_schema.columns` hides columns from an unprivileged role and would make the check vacuous. This is the correct call.

## Answers to open questions

1. **FORCE RLS on real tenant tables:** yes. Phase 1 makes FORCE ROW LEVEL SECURITY mandatory (decision D8, inventory F4). This goes into the Phase 1a spec as a fourth coverage condition. It is not added to this PR, which matches its spec.
2. **Seeded rows left in real tables:** acceptable. Isolation suites run only against disposable CI and test databases. Phase 1 will state that the suite must never point at staging or production.

## Findings

None at Critical, High or Medium.

## Verdict

**Approved, merge after green careeros-ci.**
