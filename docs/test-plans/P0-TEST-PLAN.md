# Phase 0 — Test Plan (overview)

**Status:** Approved (Opus, 2026-10-31) · **Thread:** 2 QA & Testing

## Strategy
Phase 0 changes no product behaviour, so the upstream suite is the regression baseline: every upstream unit and e2e test that passes in `docs/BASELINE.md` must keep passing on `develop` for the rest of the project (a newly failing upstream test is a High finding). New CareerOS tests in this phase test the harness itself, the isolation framework (including negative cases), and the deployment path.

| Level | Tool | Runs in | Phase 0 content |
|---|---|---|---|
| Static | Vite+ lint/format, tsrs typecheck, turbo boundaries | `careeros-ci / static` | Whole repo except `mobile` |
| Unit / integration | Vitest (`vite-plus/test`) + Postgres 16 | `careeros-ci / unit` | Upstream suite; `@careeros/testing`; `@careeros/isolation-testing` self-tests |
| Isolation | `@careeros/isolation-testing` | `careeros-ci / unit` | Framework self-tests; coverage guard on `public` schema |
| E2E | Playwright (Chromium) | `careeros-ci / e2e` | Upstream suite + `careeros-smoke.spec.ts` |
| Deployment smoke | `tooling/deployment/smoke.mjs` | `careeros-deploy-staging` | Against staging after each deploy |
| Manual | Checklist in each task test plan | Opus during review | Repo settings, branch protection, rollback drill |

## Coverage targets
- `@careeros/*` packages: ≥ 90% lines/branches for Phase 0 helper code (small, pure helpers). Measured with `test:coverage`; reported, not enforced as a CI gate until Phase 1.
- Upstream: no decrease vs baseline in passing test count.

## Review checklist additions for Thread 2 (on top of PRODUCT.md §1.6)
- Isolation code never runs reads as a superuser/BYPASSRLS role.
- Negative tests exist for every check (a check that cannot fail is not a check).
- Tests clean up schemas/rows they create; no test depends on order.
- No real secrets in fixtures; CI fixture values are clearly disposable.

## Per-task plans
[P0-T01](P0-T01.md) · [P0-T02](P0-T02.md) · [P0-T03](P0-T03.md) · [P0-Q01](P0-Q01.md) · [P0-Q02](P0-Q02.md) · [P0-C01](P0-C01.md) · [P0-C02](P0-C02.md) · [P0-C03](P0-C03.md) · [P0-C04](P0-C04.md)
