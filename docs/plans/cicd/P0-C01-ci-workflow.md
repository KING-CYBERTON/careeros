# P0-C01 — CareerOS CI workflow

**Status:** Approved (Opus, 2026-10-31) · **Thread:** 3 CI/CD · **Depends on:** P0-T01 · **Test plan:** [../../test-plans/P0-C01.md](../../test-plans/P0-C01.md)

## Goal

One required CI workflow that gates every PR to `develop` and `main` and runs the upstream checks that matter for CareerOS.

## File: `.github/workflows/careeros-ci.yml`

- `name: careeros-ci`. Triggers: `pull_request` (branches `develop`, `main`), `push` (branches `develop`, `main`), `workflow_dispatch`.
- `permissions: contents: read`. Concurrency group per workflow + ref; cancel in progress for PRs only.
- Use the same action major versions upstream `ci.yml` uses (checkout, pnpm/action-setup, setup-node with `.nvmrc` and pnpm cache). Runner: `ubuntu-latest` only (no Blacksmith, no Vercel remote cache).
- **Job `static`**: install (`--frozen-lockfile`), `pnpm lint`, `pnpm format:check`, `pnpm exec turbo boundaries`, `pnpm exec turbo run typecheck --filter=!mobile`.
- **Job `unit`**: Postgres 16 service (as upstream). Env vars: copy the `test` job env block from upstream `ci.yml` (public CI fixture values), plus `CAREEROS_TEST_DATABASE_URL` (owner) and `CAREEROS_TEST_APP_DATABASE_URL` (careeros_app) once P0-Q01 lands (add them in this task as unused variables so Q01 needs no workflow edit). Steps: install poppler-utils, migrate, create + migrate `oauth_test` DB (as upstream), run `pnpm --filter @careeros/testing db:test-role` **only if that script exists** (guard with a check so this task can merge before Q01), then `pnpm exec turbo run test:ci --concurrency=1 --filter=!mobile`.
- **Job `e2e`**: needs `static`. Same Postgres service and env as upstream Browser suite; install Chromium with deps; migrate; `pnpm build`; `pnpm exec playwright test --workers=1`; upload `playwright-report` and `test-results` artifacts on failure, 7-day retention.
- No jobs for Cloudflare, Vercel, mobile or live smoke.
- Timeouts: static 15 min, unit 30 min, e2e 40 min.

## Settings (done by Sonnet with `gh` CLI if it has admin rights, else listed in the PR for Opus/Stephen)

- Disable upstream workflows: `ci.yml`, `docker-publish.yml`, `autofix.yml`, `issue-maintenance.yml`, `mobile-forme-build.yml`, `mobile-ota-update.yml`, `mobile-release.yml` (`gh workflow disable`).
- Add a row to `docs/UPSTREAM_PATCHES.md`: "Actions settings · P0-C01 · upstream workflows disabled, files unchanged · None".

## Acceptance criteria

- PR for this task shows `careeros-ci` with jobs `static`, `unit`, `e2e` all green.
- Upstream workflows show as disabled; none ran on the PR.
- Filter excludes `mobile` (visible in logs).
- No upstream file modified.
