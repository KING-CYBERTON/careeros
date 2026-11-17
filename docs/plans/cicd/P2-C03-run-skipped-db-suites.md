# P2-C03: CI runs the org-host database suites it has been skipping

**Status:** Approved (Opus, 2026-11-02). **Thread:** 3 CI/CD. **Origin:** Phase 2 exit review, finding M1. **Branch:** `ci/P2-C03-db-suites`. **Questions:** start at Q170.

## Problem

In the develop run 41404157247 (commit `423c27f`), three database integration suites skipped, 43 tests in all:

- `packages/auth/src/org-host.integration.test.ts` (13);
- `packages/auth/src/email-links.integration.test.ts` (6);
- `apps/server/src/http/handoff.integration.test.ts` (24).

They skip unless `CAREEROS_TEST_DATABASE_URL` and `CAREEROS_TEST_APP_DATABASE_URL` are set. The unit job sets both, but Turborepo strict env mode hides them from these two packages. `packages/auth/turbo.json` and `apps/server/turbo.json` do not list them, while `packages/api/turbo.json` does (`CAREEROS_TEST_*`). The T03, T04 and T05 security tests have therefore run only on agents' machines, never in CI.

## Requirements

1. **Pass the variables through.** Add `CAREEROS_TEST_*` to the `test`, `test:ci` and `test:coverage` `env` arrays in `packages/auth/turbo.json` and `apps/server/turbo.json`, the same way `packages/api/turbo.json` does. Then check every other workspace `turbo.json` whose tests read a `*_TEST_DATABASE_URL`, and fix any other gap the same way. List what you found in the PR.
2. **Make the suites pass in CI.** If a suite fails once it runs (database setup, role grants, env), fix the test setup, not the assertions. Anything that looks like a product defect is logged as a question and not changed.
3. **Guard against a repeat.** Add `tooling/careeros/skipped-db-suites.mjs`, a Node script with no dependencies, plus its `node:test` self-test. It reads the JUnit reports that `test:ci` already writes under each package's `reports/`. It fails if any test in a file matching `*.integration.test.ts` is skipped, unless the file is listed in an allowlist in the script, each entry with a reason of at least 10 characters. Run it in each unit shard after the tests, and add its self-test to the `static` job's `node --test` step.
   - If the JUnit files are not produced the way this assumes, read the Vitest summary instead and say so. Do not weaken the check.
   - The allowlist starts empty, unless a suite truly needs a service CI does not have. Each such entry needs a question.
4. **Docs.** A line in `CHANGELOG-CAREEROS.md`, and a short "Database suites must run in CI" note in `docs/CODING-STANDARDS.md`.

## Acceptance

- CI is fully green with the three suites running: 43 more tests pass and 0 are skipped in `auth` and `server`.
- The guard fails on a deliberately skipped integration file in its self-test.
- Lint and format are clean.
