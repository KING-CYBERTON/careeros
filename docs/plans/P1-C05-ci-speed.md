# P1-C05: Faster CI

**Status:** Approved (Opus, 2026-10-31) · **Thread:** 3 CI/CD · **Depends on:** P1-Q04 (merged)

## Goal

Stephen finds CI too slow. A run takes about 10 to 12 minutes: unit runs packages one at a time, e2e uses one worker, and nothing is cached between runs. Targets: about 2 minutes for a docs-only change and about 5 to 6 minutes for a typical code PR, with the same checks still guarding `develop`.

## Scope (`.github/workflows/careeros-ci.yml`, `playwright.config.ts` only where needed)

1. **Docs-only fast path.**
   - Add a first job, `changes`, that computes `code=true|false` from `git diff --name-only` against the base. For a PR use the base SHA, and for a push use `github.event.before`, falling back to `true` when that is missing or all zeros.
   - `code=false` when every changed path matches `docs/**`, `**/*.md` (except `apps/**` and `packages/**` READMEs, which stay code), `.github/ISSUE_TEMPLATE/**` or `LICENSE*`.
   - Do it with plain git and bash, with no new third-party action.
   - `unit` and `e2e` must still **run and report success** when `code=false`, because branch protection will require them by name. Guard each heavy step with `if: needs.changes.outputs.code == 'true'`, and add one step that echoes "docs-only change, tests skipped".
   - `static` always runs in full, because lint and fmt cover docs.
2. **Turbo cache.**
   - Persist `.turbo/cache` with `actions/cache` (SHA-pinned, reuse the repo's existing pin if there is one). Key it on `runner.os`, the job name, the lockfile hash and `github.sha`, with restore-keys falling back to the lockfile prefix.
   - Make sure `test:ci` outputs (the reports dirs) are declared in `turbo.json` so cached tasks restore their JUnit files. The P1-C02 summary must still list every package.
   - Integration suites that need a live database must not be cached. Check the existing `cache: false` opt-outs in `turbo.json`, and keep or add them for the api, auth, tenancy, isolation-testing, testing and db packages. Explain each one in the PR.
3. **Unit parallelism.** Change `--concurrency=1` to `--concurrency=3`.
   - Packages share one Postgres database, so first check that the integration suites in different packages use isolated schemas or databases (`createTestSchema`, separate DB URLs).
   - If any pair can't run side by side, keep those packages serial with a turbo `dependsOn` or a second turbo invocation, and list them. Do not lower test coverage.
   - Run the full unit job locally at concurrency 3, three times, against one Postgres, and report.
4. **e2e workers.**
   - Use `--workers=3` in CI and make `playwright.config.ts` read `PLAYWRIGHT_WORKERS`, defaulting to 1.
   - Tests own separate accounts (see tests/e2e/README). Check the specs for shared global state, such as `organization.spec.ts` or fixed usernames.
   - If any spec can't run in parallel, mark it `test.describe.configure({ mode: "serial" })` or give it a separate project, with a reason.
5. **Measure.**
   - Put the PR's own run durations (static, unit, e2e, total) in the PR body.
   - Push a second, docs-only commit to the PR to show the fast path, then report its duration.

## Acceptance

- The PR's CI is green with the new settings, and a docs-only commit finishes unit and e2e in under 1 minute each.
- No test is skipped on code changes, and the JUnit summary still lists every package.
- Actions are pinned by SHA.
- Every upstream edit (`playwright.config.ts`, `turbo.json`) is marked `CAREEROS:` and listed in UPSTREAM_PATCHES.
