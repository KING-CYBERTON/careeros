# P2-C03 review 1 (Opus, PR #61)

## Checked

- Turborepo env fix confirmed by dry run: `CAREEROS_TEST_*` now reaches the `auth` and `server` test tasks.
- Guard design: reads the JUnit reports `test:ci` writes, fails on any skipped test in a guarded file, empty allowlist with a reason rule.
- No assertions or test expectations were changed.

## Answers

- Q170: also guard the database-backed files not named `*.integration.test.ts`, through an explicit list in the script (`packages/api/.../account-storage.test.ts`, `packages/careeros-testing/src/index.test.ts` and `isolated-db.test.ts`, plus any other file whose skip depends on a `*_TEST_DATABASE_URL`). Self-test required.
- Q171: yes. Fail when a package that contains guarded files has no JUnit report in that shard, with a clear message. Each shard checks only the packages its turbo filter ran. Self-test required.
- Q172: Opus confirms the test counts in the PR's CI run.

## Verdict

Approved. Merge on fully green CI with `auth` 119 and `server` 294 tests, 0 skipped.
