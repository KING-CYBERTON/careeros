# P1-C01 review 1

**PR:** #16 · **Spec:** docs/plans/P1-C01-db-role-split.md · **Reviewer:** Opus (CI/CD + QA) · **Date:** 2026-10-31

## Verdict: Approved, merge after green careeros-ci.

## Checks

| Item                                                                                                   | Result                       |
| ------------------------------------------------------------------------------------------------------ | ---------------------------- |
| Bootstrap SQL idempotent, no DROP, no hard-coded passwords, fails on empty passwords                   | ✅                           |
| `careeros_app`: NOSUPERUSER, NOBYPASSRLS, no CREATE on `public`, no `drizzle` access, owns nothing     | ✅ (SQL + CI assertion step) |
| Default privileges for future owner-created tables and sequences                                       | ✅                           |
| Existing-database path moves ownership without DROP                                                    | ✅                           |
| CI e2e: `DATABASE_URL` = app role, migrations as owner, bootstrap run twice                            | ✅                           |
| Staging: `db_bootstrap` one-shot service, app depends on it; template tracked (Q5 fix in `.gitignore`) | ✅                           |
| Single source of truth (testing package now uses `infra/db/bootstrap-roles.sql`)                       | ✅                           |
| Upstream files listed (`.env.example`, `.gitignore`)                                                   | ✅                           |

## Notes

- Q5 found a real gap from P0-C03: `.env.staging.example` was ignored by the root `.env*` rule, so the deploy workflow's `install` step would have failed. Fixed here.
- Q6 answered by Opus: assertion after migrate is sufficient; the e2e suite passing as `careeros_app` is the functional proof.

## Findings

None.
