# CareerOS — Build Status

> Written by Opus after every plan, review and merge. Every thread reads this file first.

**Current phase:** Phases 0, 1 and 2 meet their exit criteria (staging verified live by Stephen on 2026-11-02). P2-C04 merged in #64; tags `v0.0.1`, `v0.1.0`, `v0.2.0` wait on Stephen pushing them (this session cannot push tags). 3 — Admin & Billing: [phase plan](plans/P3-PHASE-PLAN.md); every Phase 3 task is merged except the P3-Q03 security suite (in CI). D1 = Paystack; D2 prices open with Stephen. Go-to-market release (Stephen, D11): [GTM plan](plans/GTM-PLAN.md) runs job discovery, the clipper and launch basics alongside Phase 3
**Current version:** none yet (first tag will be `0.0.1` at Phase 0 exit)
**Base:** Reactive Resume v6.0.10, upstream commit `a69e48318aab3c1c3ea57d2c0467710ef0d8342f` (2026-10-31)
**Last updated:** 2026-11-09 by Opus (Thread 1)

## Phase 0 exit criteria (PRODUCT.md §13)

- [x] App runs in staging (P0-C03): https://careeros-staging.ayopa.co.ke deployed by `careeros-deploy-staging` on Stephen's VPS, 2026-11-02; default branch is `develop`
- [x] CI green on `develop` (all PRs since C01b green on static, unit, e2e)
- [x] All three threads operational (T01, Q01, C01 each completed the §1.3 loop)

## Active tasks

| Thread    | Task ID | Spec                                                                         | Test plan                                    | Status                                                                                                                                                       | Branch / PR                                              |
| --------- | ------- | ---------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| 1 — Build | P0-T01  | [plans/P0-T01-repo-bootstrap.md](plans/P0-T01-repo-bootstrap.md)             | [test-plans/P0-T01.md](test-plans/P0-T01.md) | **Merged** · [review](reviews/P0-T01-review-1.md)                                                                                                            | [#1](https://github.com/KING-CYBERTON/careeros/pull/1)   |
| 1 — Build | P0-T02  | [plans/P0-T02-agent-instructions.md](plans/P0-T02-agent-instructions.md)     | [test-plans/P0-T02.md](test-plans/P0-T02.md) | **Merged** · [review](reviews/P0-T02-review-1.md)                                                                                                            | [#2](https://github.com/KING-CYBERTON/careeros/pull/2)   |
| 1 — Build | P0-T03  | [plans/P0-T03-local-baseline.md](plans/P0-T03-local-baseline.md)             | [test-plans/P0-T03.md](test-plans/P0-T03.md) | **Merged** · [review](reviews/P0-T03-review-1.md)                                                                                                            | [#12](https://github.com/KING-CYBERTON/careeros/pull/12) |
| 2 — QA    | P0-Q01  | [plans/P0-Q01-test-harness.md](plans/P0-Q01-test-harness.md)                 | [test-plans/P0-Q01.md](test-plans/P0-Q01.md) | **Merged** · [review](reviews/P0-Q01-review-1.md)                                                                                                            | [#4](https://github.com/KING-CYBERTON/careeros/pull/4)   |
| 2 — QA    | P0-Q02  | [plans/P0-Q02-isolation-framework.md](plans/P0-Q02-isolation-framework.md)   | [test-plans/P0-Q02.md](test-plans/P0-Q02.md) | **Merged** · [review](reviews/P0-Q02-review-1.md)                                                                                                            | [#9](https://github.com/KING-CYBERTON/careeros/pull/9)   |
| 2 — QA    | P0-Q03  | [plans/P0-Q03-e2e-tag-filter-flake.md](plans/P0-Q03-e2e-tag-filter-flake.md) | (acceptance in spec)                         | **Merged** · [review](reviews/P0-Q03-review-1.md)                                                                                                            | [#11](https://github.com/KING-CYBERTON/careeros/pull/11) |
| 3 — CI/CD | P0-C01  | [plans/cicd/P0-C01-ci-workflow.md](plans/cicd/P0-C01-ci-workflow.md)         | [test-plans/P0-C01.md](test-plans/P0-C01.md) | **Merged** · [review](reviews/P0-C01-review-1.md)                                                                                                            | [#3](https://github.com/KING-CYBERTON/careeros/pull/3)   |
| 3 — CI/CD | P0-C01b | [plans/cicd/P0-C01b-test-timeout.md](plans/cicd/P0-C01b-test-timeout.md)     | (acceptance in spec)                         | **Merged** · [review](reviews/P0-C01b-review-1.md)                                                                                                           | [#8](https://github.com/KING-CYBERTON/careeros/pull/8)   |
| 3 — CI/CD | P0-C02  | [plans/cicd/P0-C02-image-publish.md](plans/cicd/P0-C02-image-publish.md)     | [test-plans/P0-C02.md](test-plans/P0-C02.md) | **Merged** · [review](reviews/P0-C02-review-1.md) · live image check waits on default branch = `develop`                                                     | [#6](https://github.com/KING-CYBERTON/careeros/pull/6)   |
| 3 — CI/CD | P0-C03  | [plans/cicd/P0-C03-staging.md](plans/cicd/P0-C03-staging.md)                 | [test-plans/P0-C03.md](test-plans/P0-C03.md) | Approved rev 2 (Cloudflare Tunnel) · **Merged** · [review](reviews/P0-C03-review-1.md) · live once Stephen completes the runbook and sets the default branch | —                                                        |
| 3 — CI/CD | P0-C04  | [plans/cicd/P0-C04-repo-hygiene.md](plans/cicd/P0-C04-repo-hygiene.md)       | [test-plans/P0-C04.md](test-plans/P0-C04.md) | **Merged** · [review](reviews/P0-C04-review-1.md) · settings part is an owner action                                                                         | [#7](https://github.com/KING-CYBERTON/careeros/pull/7)   |

## Phase 1 tasks

| Thread    | Task ID | Spec                                                                                                       | Status                                                                                           | Branch / PR                                              |
| --------- | ------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| 3 — CI/CD | P1-C01  | [plans/P1-C01-db-role-split.md](plans/P1-C01-db-role-split.md)                                             | **Merged** · [review](reviews/P1-C01-review-1.md)                                                | [#16](https://github.com/KING-CYBERTON/careeros/pull/16) |
| 1 — Build | P1-T01  | [plans/P1-T01-org-plugin.md](plans/P1-T01-org-plugin.md)                                                   | **Merged** · [review](reviews/P1-T01-review-1.md)                                                | [#17](https://github.com/KING-CYBERTON/careeros/pull/17) |
| 1 — Build | P1-T02  | [plans/P1-T02-tenancy-core.md](plans/P1-T02-tenancy-core.md)                                               | **Merged** · [review](reviews/P1-T02-review-1.md)                                                | [#19](https://github.com/KING-CYBERTON/careeros/pull/19) |
| 2 — QA    | P1-Q01  | [plans/P1-Q01-tenancy-tests.md](plans/P1-Q01-tenancy-tests.md)                                             | **Merged** · [review](reviews/P1-Q01-review-1.md)                                                | [#21](https://github.com/KING-CYBERTON/careeros/pull/21) |
| 3 — CI/CD | P1-C02  | [plans/P1-C02-junit-summary.md](plans/P1-C02-junit-summary.md)                                             | **Merged** · [review](reviews/P1-C02-review-1.md)                                                | [#22](https://github.com/KING-CYBERTON/careeros/pull/22) |
| 3 — CI/CD | P1-C03  | (folded into P1-C01)                                                                                       | Staging compose and `.env.staging.example` already split roles; verified at first staging deploy | —                                                        |
| 1 — Build | P1-T03  | [plans/P1-T03-signup-invites.md](plans/P1-T03-signup-invites.md)                                           | **Merged** · [review](reviews/P1-T03-review-1.md) (D6 confirmed by Stephen)                      | [#23](https://github.com/KING-CYBERTON/careeros/pull/23) |
| 2 — QA    | P1-Q04  | [plans/P1-Q04-cleanup-deadlock.md](plans/P1-Q04-cleanup-deadlock.md)                                       | **Merged** · [review](reviews/P1-Q04-review-1.md)                                                | [#24](https://github.com/KING-CYBERTON/careeros/pull/24) |
| 3 — CI/CD | P1-C05  | [plans/P1-C05-ci-speed.md](plans/P1-C05-ci-speed.md)                                                       | **Merged** · [review](reviews/P1-C05-review-1.md)                                                | [#25](https://github.com/KING-CYBERTON/careeros/pull/25) |
| 2 — QA    | P1-Q05  | [plans/P1-Q05-pdf-text-route.md](plans/P1-Q05-pdf-text-route.md)                                           | **Merged**                                                                                       | [#27](https://github.com/KING-CYBERTON/careeros/pull/27) |
| 2 — QA    | P1-Q06  | [plans/P1-Q06-2fa-deadline-margin.md](plans/P1-Q06-2fa-deadline-margin.md)                                 | **Merged**                                                                                       | [#28](https://github.com/KING-CYBERTON/careeros/pull/28) |
| 1 — Build | P1-T04  | [plans/P1-T04-resumes-rls.md](plans/P1-T04-resumes-rls.md)                                                 | **Merged** · [review](reviews/P1-T04-review-1.md)                                                | [#29](https://github.com/KING-CYBERTON/careeros/pull/29) |
| 1 — Build | P1-T05  | [plans/P1-T05-cover-letters-rls.md](plans/P1-T05-cover-letters-rls.md)                                     | **Merged** · [review](reviews/P1-T05-review-1.md)                                                | [#30](https://github.com/KING-CYBERTON/careeros/pull/30) |
| 2 — QA    | P1-Q07  | [plans/P1-Q07-e2e-seed-pool.md](plans/P1-Q07-e2e-seed-pool.md)                                             | **Merged** (fixed develop e2e red after T05)                                                     | [#31](https://github.com/KING-CYBERTON/careeros/pull/31) |
| 1 — Build | P1-T06  | [plans/P1-T06-applications-rls.md](plans/P1-T06-applications-rls.md)                                       | **Merged** · [review](reviews/P1-T06-review-1.md)                                                | [#32](https://github.com/KING-CYBERTON/careeros/pull/32) |
| 1 — Build | P1-T07  | [plans/P1-T07-career-rls.md](plans/P1-T07-career-rls.md)                                                   | **Merged** · [review](reviews/P1-T07-review-1.md)                                                | [#33](https://github.com/KING-CYBERTON/careeros/pull/33) |
| 1 — Build | P1-T09  | [plans/P1-T09-remaining-rls.md](plans/P1-T09-remaining-rls.md)                                             | **Merged** · [review](reviews/P1-T09-review-1.md) (H1 hardening applied)                         | [#34](https://github.com/KING-CYBERTON/careeros/pull/34) |
| 1 — Build | P1-T08  | [plans/P1-T08-agent-ai-rls.md](plans/P1-T08-agent-ai-rls.md)                                               | **Merged** · [review](reviews/P1-T08-review-1.md)                                                | [#36](https://github.com/KING-CYBERTON/careeros/pull/36) |
| 2 — QA    | P1-Q03  | [plans/P1-Q03-cross-org-id-fuzz.md](plans/P1-Q03-cross-org-id-fuzz.md)                                     | **Merged** · [review](reviews/P1-Q03-review-1.md) (157 operations, 106 MCP tools, no leaks)      | [#37](https://github.com/KING-CYBERTON/careeros/pull/37) |
| 2 — QA    | P1-Q08  | [plans/P1-Q08-shared-db-test-races.md](plans/P1-Q08-shared-db-test-races.md)                               | **Merged** · [review](reviews/P1-Q08-review-1.md)                                                | [#38](https://github.com/KING-CYBERTON/careeros/pull/38) |
| 2 — QA    | P1-Q09  | [plans/P1-Q09-cleanup-db-time-and-suite-isolation.md](plans/P1-Q09-cleanup-db-time-and-suite-isolation.md) | **Merged** · [review](reviews/P1-Q09-review-1.md)                                                | [#39](https://github.com/KING-CYBERTON/careeros/pull/39) |
| 2 — QA    | P1-Q10  | [plans/P1-Q10-auth-org-endpoint-fuzz.md](plans/P1-Q10-auth-org-endpoint-fuzz.md)                           | **Merged** · [review](reviews/P1-Q10-review-1.md) (22 endpoints, no leaks)                       | [#42](https://github.com/KING-CYBERTON/careeros/pull/42) |

## Phase 1 exit criteria (PRODUCT.md §13)

- [x] Every tenant table has `organization_id`, FORCE RLS and the tenant policy; the unclassified-tables check has an empty pending list
- [x] Cross-org ID fuzz passes (P1-Q03)
- [x] Opus security sign-off: [signed off](reviews/P1-EXIT-security-review-1.md), with no Critical or High findings; M1 closed by P1-Q10 ([#42](https://github.com/KING-CYBERTON/careeros/pull/42))
- [x] BASELINE refreshed from develop run 41320943973 ([BASELINE.md](BASELINE.md#phase-1-exit-refresh-p1-c02): 3426 unit tests, 63 e2e)
- [x] Staging verified with the database role split: the app migrates as `careeros_owner` and serves as `careeros_app` (`db_bootstrap` sets both roles on every deploy), 2026-11-02

## Phase 2 tasks

| Thread    | Task ID    | Spec                                                                                                       | Status                                                                                                                                         | Branch / PR                                              |
| --------- | ---------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1 — Build | P2-T01     | [plans/P2-T01-branding-tables.md](plans/P2-T01-branding-tables.md)                                         | **Merged** · [review](reviews/P2-T01-review-1.md)                                                                                              | [#46](https://github.com/KING-CYBERTON/careeros/pull/46) |
| 1 — Build | P2-T08     | [plans/P2-T08-remove-upstream-branding.md](plans/P2-T08-remove-upstream-branding.md)                       | **Merged** · [review](reviews/P2-T08-review-1.md) (mobile native hosts: release blocker noted)                                                 | [#47](https://github.com/KING-CYBERTON/careeros/pull/47) |
| 1 — Build | P2-T03     | [plans/P2-T03-host-org-resolution.md](plans/P2-T03-host-org-resolution.md)                                 | **Merged** · [review](reviews/P2-T03-review-1.md)                                                                                              | [#48](https://github.com/KING-CYBERTON/careeros/pull/48) |
| 1 — Build | P2-T02     | [plans/P2-T02-branding-injection.md](plans/P2-T02-branding-injection.md)                                   | **Merged** · [review](reviews/P2-T02-review-1.md)                                                                                              | [#50](https://github.com/KING-CYBERTON/careeros/pull/50) |
| 1 — Build | P2-T05     | [plans/P2-T05-auth-handoff.md](plans/P2-T05-auth-handoff.md)                                               | **Merged** · [review](reviews/P2-T05-review-1.md) (security review, one Low accepted)                                                          | [#51](https://github.com/KING-CYBERTON/careeros/pull/51) |
| 1 — Build | P2-T04     | [plans/P2-T04-branded-emails.md](plans/P2-T04-branded-emails.md)                                           | **Merged** · [review](reviews/P2-T04-review-1.md)                                                                                              | [#52](https://github.com/KING-CYBERTON/careeros/pull/52) |
| 1 — Build | P2-T06     | [plans/P2-T06-org-custom-domains.md](plans/P2-T06-org-custom-domains.md)                                   | **Merged** · [review](reviews/P2-T06-review-1.md) (two Mediums fixed before merge); live check waits on P2-C01 and the Cloudflare owner action | [#53](https://github.com/KING-CYBERTON/careeros/pull/53) |
| 1 — Build | P2-T07     | [plans/P2-T07-branding-settings-ui.md](plans/P2-T07-branding-settings-ui.md)                               | **Merged** · [review](reviews/P2-T07-review-1.md) (mobile join deferred, Q130)                                                                 | [#56](https://github.com/KING-CYBERTON/careeros/pull/56) |
| 2 — QA    | P2-Q01/Q02 | [plans/P2-Q01-Q02-host-isolation-and-branding-e2e.md](plans/P2-Q01-Q02-host-isolation-and-branding-e2e.md) | **Merged** · [review](reviews/P2-Q01-Q02-review-1.md) (fuzz org-host pass 334/334 refused; not-set-up page fix)                                | [#59](https://github.com/KING-CYBERTON/careeros/pull/59) |
| 3 — CI/CD | P2-C02     | [plans/cicd/P2-C02-branding-gate.md](plans/cicd/P2-C02-branding-gate.md)                                   | **Merged** · [review](reviews/P2-C02-review-1.md) (mobile node tests now in CI)                                                                | [#55](https://github.com/KING-CYBERTON/careeros/pull/55) |
| 3 — CI/CD | P2-C01     | [plans/cicd/P2-C01-staging-org-hosts.md](plans/cicd/P2-C01-staging-org-hosts.md)                           | **Merged** · [review](reviews/P2-C01-review-1.md). Live check waits on Stephen's Cloudflare actions                                            | [#58](https://github.com/KING-CYBERTON/careeros/pull/58) |

All Phase 2 tasks are merged. P2-C03 (from exit review M1, [spec](plans/cicd/P2-C03-run-skipped-db-suites.md)) merged in [#61](https://github.com/KING-CYBERTON/careeros/pull/61). The live staging checks passed on 2026-11-02 (Stephen). Only the tags remain. Before the first `v*` tag, P2-C04 ([spec](plans/cicd/P2-C04-release-path.md)) switches off the inherited upstream publish workflow and fixes the staging workflow trips found during the bring-up.

## Phase 2 exit criteria (PRODUCT.md §13)

- [x] Two orgs on two hosts show distinct branding on every surface: proven in CI by P2-Q02 ([#59](https://github.com/KING-CYBERTON/careeros/pull/59)) and checked live on staging org hosts by Stephen, 2026-11-02
- [x] A custom domain verifies, gets TLS and stops serving on removal: built and tested (T06, T07); Cloudflare for SaaS enabled and checked live on staging by Stephen, 2026-11-02
- [x] Host decides the org; a session from A's host cannot act in B (P2-Q01: e2e plus the fuzz org-host pass, zero leaks)
- [x] CI gate blocks upstream branding (P2-C02, [#55](https://github.com/KING-CYBERTON/careeros/pull/55))
- [x] Opus security review: [signed off](reviews/P2-EXIT-security-review-1.md), no Critical or High; M1 closed by P2-C03 ([#61](https://github.com/KING-CYBERTON/careeros/pull/61)). L1 recorded, L2 to the Phase 3 backlog
- [x] BASELINE refreshed from develop run 41404157247 ([BASELINE.md](BASELINE.md#phase-2-exit-refresh): 3863 unit tests, 89 e2e, 43 skipped, see M1)

## Phase 3 and go-to-market tasks

| Task   | Spec                                                                                   | State                                                                                        | PR                                                         |
| ------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| P3-T01 | [plans/P3-T01-plans-entitlements-tables.md](plans/P3-T01-plans-entitlements-tables.md) | **Merged** · [review](reviews/P3-T01-review-1.md)                                            | [#67](https://github.com/KING-CYBERTON/careeros/pull/67)   |
| P3-T02 | [plans/P3-T02-entitlement-enforcement.md](plans/P3-T02-entitlement-enforcement.md)     | **Merged** · [review](reviews/P3-T02-review-1.md)                                            | [#76](https://github.com/KING-CYBERTON/careeros/pull/76)   |
| P3-T03 | [plans/P3-T03-ai-metering.md](plans/P3-T03-ai-metering.md)                             | **Merged** · [review](reviews/P3-T03-review-1.md)                                            | [#74](https://github.com/KING-CYBERTON/careeros/pull/74)   |
| P3-T04 | [plans/P3-T04-billing-core.md](plans/P3-T04-billing-core.md)                           | **Merged** · [review](reviews/P3-T04-review-1.md)                                            | [#77](https://github.com/KING-CYBERTON/careeros/pull/77)   |
| P3-T05 | [plans/P3-T05-paystack-provider.md](plans/P3-T05-paystack-provider.md)                 | **Merged** · [review](reviews/P3-T05-review-1.md) · live once Stephen adds the Paystack keys | [#101](https://github.com/KING-CYBERTON/careeros/pull/101) |
| P3-T06 | [plans/P3-T06-billing-ui.md](plans/P3-T06-billing-ui.md)                               | **Merged** · [review](reviews/P3-T06-review-1.md)                                            | [#100](https://github.com/KING-CYBERTON/careeros/pull/100) |
| P3-T07 | [plans/P3-T07-super-admin-console.md](plans/P3-T07-super-admin-console.md)             | **Merged** · [review](reviews/P3-T07-review-1.md)                                            | [#93](https://github.com/KING-CYBERTON/careeros/pull/93)   |
| P3-T08 | [plans/P3-T08-org-admin-console.md](plans/P3-T08-org-admin-console.md)                 | **Merged** · [review](reviews/P3-T08-review-1.md)                                            | [#89](https://github.com/KING-CYBERTON/careeros/pull/89)   |
| P3-T09 | [plans/P3-T09-super-admin-hardening.md](plans/P3-T09-super-admin-hardening.md)         | **Merged** · [review](reviews/P3-T07-review-1.md)                                            | [#99](https://github.com/KING-CYBERTON/careeros/pull/99)   |
| P3-Q03 | [plans/P3-Q03-super-admin-security.md](plans/P3-Q03-super-admin-security.md)           | In CI                                                                                        | [#97](https://github.com/KING-CYBERTON/careeros/pull/97)   |
| P4-T01 | [plans/P4-T01-discovery-data-fetchers.md](plans/P4-T01-discovery-data-fetchers.md)     | **Merged** · [review](reviews/P4-T01-review-1.md)                                            | [#68](https://github.com/KING-CYBERTON/careeros/pull/68)   |
| P4-T02 | [plans/P4-T02-discovery-runs-ai-review.md](plans/P4-T02-discovery-runs-ai-review.md)   | **Merged** · [review](reviews/P4-T02-review-1.md)                                            | [#91](https://github.com/KING-CYBERTON/careeros/pull/91)   |
| P4-T03 | [plans/P4-T03-discovery-setup-form.md](plans/P4-T03-discovery-setup-form.md)           | **Merged** · [review](reviews/P4-T02-review-1.md)                                            | [#96](https://github.com/KING-CYBERTON/careeros/pull/96)   |
| P5-T01 | [plans/P5-T01-extension-scaffold.md](plans/P5-T01-extension-scaffold.md)               | **Merged** · [review](reviews/P5-T01-review-1.md)                                            | [#66](https://github.com/KING-CYBERTON/careeros/pull/66)   |
| P5-T02 | [plans/P5-T02-clipper-sign-in.md](plans/P5-T02-clipper-sign-in.md)                     | **Merged** · [review](reviews/P5-T02-review-1.md)                                            | [#78](https://github.com/KING-CYBERTON/careeros/pull/78)   |
| P5-T03 | [plans/P5-T03-clipping.md](plans/P5-T03-clipping.md)                                   | **Merged** · [review](reviews/P5-T03-review-1.md)                                            | [#95](https://github.com/KING-CYBERTON/careeros/pull/95)   |
| P5-C01 | [plans/P5-C01-extension-packaging.md](plans/P5-C01-extension-packaging.md)             | **Merged** · [review](reviews/P5-T03-review-1.md)                                            | [#94](https://github.com/KING-CYBERTON/careeros/pull/94)   |
| P6-T01 | [plans/P6-T01-legal-pages.md](plans/P6-T01-legal-pages.md)                             | **Merged** · [review](reviews/P6-T01-review-1.md)                                            | [#73](https://github.com/KING-CYBERTON/careeros/pull/73)   |

### Waiting on Stephen (Phase 3 and go-to-market)

- **Staging:** restart the self-hosted runner so `careeros-deploy-staging` picks up the queued deploys (`cd /home/deploy/actions-runner && sudo ./svc.sh stop && sudo ./svc.sh start`). Staging still serves the 2026-11-02 build.
- **Paystack (D1 decided 2026-11-08):** a Paystack account, test keys in the staging environment (`BILLING_PROVIDER=paystack`, `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`, `PAYSTACK_ALLOW_TEST_KEY=true`) and the webhook URL `https://careeros-staging.ayopa.co.ke/api/billing/webhook/paystack` in the Paystack dashboard (Q465).
- **D2:** real prices. **D10** applied: mobile shows billing read-only.
- **G8:** production hosting. A Chrome Web Store developer account and a Microsoft Partner Center account for the clipper.
- **G10:** approve the legal drafts in `docs/legal/` (the `[TO CONFIRM]` items need the operator's details or a lawyer) before launch; the store data-handling answers (Q404) depend on them.
- Push the tags `v0.0.1` (`6035783`), `v0.1.0` (`4a5bc88`) and `v0.2.0` (`1954263`).

## Blockers

- **Owner actions (Stephen)**, the session proxy blocks repo-settings writes: (1) default branch → `develop`; (2) branch protection on `develop` and `main` (require PR, checks `static`, `unit`, `e2e`, up to date, no force-push/deletion; `main` restricted to Opus release merges); (3) enable secret scanning, push protection and Dependabot alerts; (4) for Phase 2, enable Cloudflare for SaaS on `ayopa.co.ke` and add a scoped API token (SSL and Certificates: Edit) as the `CF_SAAS_API_TOKEN` repository and staging secret; P2-C01's runbook (`infra/staging/README.md`) lists the rest: a second token `CF_STAGING_INFRA_TOKEN` (Tunnel edit, DNS edit) as a `staging` environment secret only, and the `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `CF_TUNNEL_ID` variables.
- **D6** confirmed by Stephen (personal org at signup).
- Please leave merging to Opus: PRs merge only after a clean review and green CI.
- **Q3** answered (no inbound 80/443 → Cloudflare Tunnel). **Q4** answered (DNS on Cloudflare).
- **E1, E2** resolved (private repo; home-lab VPS `careeros-staging.ayopa.co.ke`).

## Watch list

- **Release blocker (mobile, Q80):** the native app identity still uses the upstream host and name (`apps/mobile/app.config.ts`, `oauth.ts`, `session.ts`, `apps/web/src/features/auth/native-callback.ts`). These lines carry `careeros-branding-allow` until §15.1 settles the product name and native identity. No store build ships before then.

- `tests/e2e/specs/library-pagination.spec.ts:201`: root cause fixed in P0-Q03 (oRPC batching bypassed the test mock). Watch for a strict-mode "two alerts" failure; if seen, Opus specs a per-item batch response.
- `assistant.spec.ts:118` (reaccept "CPACC") failed once and passed on re-run (T05 era); root-cause if it recurs.
- Follow-ups: drop the old `careeros_due_storage_cleanup` overload in the first Phase 1b follow-on migration (Q74); make `bindGlobalPoolForTesting` throw in production (Q75); plan Q20 (`Promise.all` on one org-scoped client); Q03 F1 (custom-domain routes in the fuzz); exit review L1, L2 (Phase 2 hygiene). Phase 3 backlog from Phase 2: mobile join on org hosts (Q130), org-aware OAuth state (Q105), holding released org slugs (P2 exit L2), self-hosted brand fonts (Q101). From the staging bring-up: no screen to rename an org's address (slug) or create another org; the Domains page says "your address above" when no address is shown; `careeros-staging-cloudflare` should ignore the slug input for commands that take none; the deploy job's 30-minute limit and the 25 MB smoke upload are tight for a small home-lab server.
- e2e specs doing raw SQL on tenant tables must use `withSeedPool` (P1-Q07); careeros_app sees nothing without an org context.

## Planning docs

- [plans/P2-PHASE-PLAN.md](plans/P2-PHASE-PLAN.md) (Phase 2 white-label approved; D2 and D3 decided by Stephen: `<slug>-careeros.ayopa.co.ke` staging hosts and Cloudflare for SaaS)
- [plans/P1-PHASE-PLAN.md](plans/P1-PHASE-PLAN.md) (Phase 1 approved except D6; first specs P1-T01, P1-T02, P1-C01)
- [plans/P0-VALIDATION.md](plans/P0-VALIDATION.md) · [plans/P0-UPSTREAM-INVENTORY.md](plans/P0-UPSTREAM-INVENTORY.md) (Q2 answered; Phase 1 split into 1a/1b)

## Merged

- P0-T01 Repo bootstrap — [#1](https://github.com/KING-CYBERTON/careeros/pull/1), `9440465`
- P0-T02 Agent instruction overlay — [#2](https://github.com/KING-CYBERTON/careeros/pull/2), `6126606`
- P0-C01 CareerOS CI workflow — [#3](https://github.com/KING-CYBERTON/careeros/pull/3), `337126b`
- P0-Q01 Test harness — [#4](https://github.com/KING-CYBERTON/careeros/pull/4), `ad48ec3`
- Docs sync 1 — [#5](https://github.com/KING-CYBERTON/careeros/pull/5), `492283e`
- P0-C02 Image publish — [#6](https://github.com/KING-CYBERTON/careeros/pull/6), `db54edb`
- P0-C04 Repo hygiene — [#7](https://github.com/KING-CYBERTON/careeros/pull/7), `d4950da`
- P0-C01b Test timeout — [#8](https://github.com/KING-CYBERTON/careeros/pull/8), `7cac561`
- P0-Q02 Isolation framework — [#9](https://github.com/KING-CYBERTON/careeros/pull/9), `7f7cd01`
- P0-Q03 e2e tag-filter fix — [#11](https://github.com/KING-CYBERTON/careeros/pull/11), `c3c61cb`
- P0-T03 CI baseline — [#12](https://github.com/KING-CYBERTON/careeros/pull/12), `b287e83`
- P0-C03 Staging — [#13](https://github.com/KING-CYBERTON/careeros/pull/13), `6035783`
- Phase 1 plan — [#14](https://github.com/KING-CYBERTON/careeros/pull/14), `a87a399`
- Docs sync 4 (P1 specs, C03 review) — [#15](https://github.com/KING-CYBERTON/careeros/pull/15), `60c05df`
- P1-C01 Database role split — [#16](https://github.com/KING-CYBERTON/careeros/pull/16), `17d7b35`
- P1-T01 Organization plugin — [#17](https://github.com/KING-CYBERTON/careeros/pull/17), `4305b64`
- Docs sync 5 — [#18](https://github.com/KING-CYBERTON/careeros/pull/18), `c07c83c`
- P1-T02 Tenancy core — [#19](https://github.com/KING-CYBERTON/careeros/pull/19), `a476784`

All 2026-10-31.

## Tags

_None yet._

- Docs sync 6 (Q01, C02, T03, T04 specs) — [#20](https://github.com/KING-CYBERTON/careeros/pull/20), `a571aee`
- P1-Q01 Tenancy tests — [#21](https://github.com/KING-CYBERTON/careeros/pull/21)
- P1-C02 JUnit summary — [#22](https://github.com/KING-CYBERTON/careeros/pull/22), `796bc3b`
- P1-T03 Signup org, invitations, org switching — [#23](https://github.com/KING-CYBERTON/careeros/pull/23), `f17dde6`
- P1-Q04 Integration-test cleanup deadlock — [#24](https://github.com/KING-CYBERTON/careeros/pull/24), `be14053`
- P1-C05 CI speed — [#25](https://github.com/KING-CYBERTON/careeros/pull/25), `4b86609`
- Docs sync 7 — [#26](https://github.com/KING-CYBERTON/careeros/pull/26), `1384eae`
- P1-Q05 pdf-text teardown — [#27](https://github.com/KING-CYBERTON/careeros/pull/27), `398a9ff`
- P1-Q06 2FA deadline margin — [#28](https://github.com/KING-CYBERTON/careeros/pull/28), `a800eda`
- P1-T04 Resumes RLS — [#29](https://github.com/KING-CYBERTON/careeros/pull/29), `10cae49`
- P1-T05 Cover letters RLS — [#30](https://github.com/KING-CYBERTON/careeros/pull/30), `dadf661`
- P1-Q07 e2e seed pool — [#31](https://github.com/KING-CYBERTON/careeros/pull/31), `d9fc858`
- P1-T06 Applications RLS — [#32](https://github.com/KING-CYBERTON/careeros/pull/32), `da8b228`
- P1-T07 Career and scheduler RLS — [#33](https://github.com/KING-CYBERTON/careeros/pull/33), `fdd1454`
- P1-T09 Custom domains, storage cleanup, web access RLS — [#34](https://github.com/KING-CYBERTON/careeros/pull/34), `616075f`
- Docs sync 8 — [#35](https://github.com/KING-CYBERTON/careeros/pull/35), `550e4b3`
- P1-T08 Agent and AI RLS — [#36](https://github.com/KING-CYBERTON/careeros/pull/36), `d5c3767`
- P1-Q03 Cross-org ID fuzz — [#37](https://github.com/KING-CYBERTON/careeros/pull/37), `a19e3cc`
- P1-Q08 Shared-database test races — [#38](https://github.com/KING-CYBERTON/careeros/pull/38), `bd460b1`
- P1-Q09 Cleanup database time and suite isolation — [#39](https://github.com/KING-CYBERTON/careeros/pull/39), `0794338`
- Docs sync 9 and Phase 1 exit security review — [#40](https://github.com/KING-CYBERTON/careeros/pull/40), `f12278a`
- Phase 1 CI baseline refresh — [#41](https://github.com/KING-CYBERTON/careeros/pull/41), `c58296a`
- P1-Q10 Auth organization endpoint fuzz — [#42](https://github.com/KING-CYBERTON/careeros/pull/42), `951f766`
- Phase 1 sign-off docs — [#43](https://github.com/KING-CYBERTON/careeros/pull/43), `4a5bc88`
- Phase 2 plan and P2-T01 spec — [#44](https://github.com/KING-CYBERTON/careeros/pull/44), `7e3fbf2`
- D2/D3 decisions — [#45](https://github.com/KING-CYBERTON/careeros/pull/45), `8088d15`
- P2-T01 Branding and settings tables — [#46](https://github.com/KING-CYBERTON/careeros/pull/46), `f22f60b`
- P2-T08 Remove upstream branding, licenses page — [#47](https://github.com/KING-CYBERTON/careeros/pull/47), `aa6bec9`
- Docs sync 10 (Phase 2 status, T02 and T04 specs) — [#49](https://github.com/KING-CYBERTON/careeros/pull/49), `7b95bd4`
- P2-T03 Host decides the organization — [#48](https://github.com/KING-CYBERTON/careeros/pull/48), `2f03941`
- P2-T02 Branding in the app shell — [#50](https://github.com/KING-CYBERTON/careeros/pull/50), `dd4122f`
- P2-T05 Auth handoff for social and OIDC sign-in — [#51](https://github.com/KING-CYBERTON/careeros/pull/51), `85b1bc7`
- P2-T04 Branded emails — [#52](https://github.com/KING-CYBERTON/careeros/pull/52), `629def9`
- P2-T06 Organization custom domains — [#53](https://github.com/KING-CYBERTON/careeros/pull/53), `0924094`
- Docs sync 11 — [#54](https://github.com/KING-CYBERTON/careeros/pull/54), `dc6b8f0`
- P2-C02 Branding gate and mobile node tests in CI — [#55](https://github.com/KING-CYBERTON/careeros/pull/55), `41085d3`
- Docs sync 12 (P2-Q01/Q02 and P2-C01 specs) — [#57](https://github.com/KING-CYBERTON/careeros/pull/57), `f4125a1`
- P2-C01 Staging org hosts and custom domains through the tunnel — [#58](https://github.com/KING-CYBERTON/careeros/pull/58), `d636cfb`
- P2-Q01/Q02 Host isolation and branding e2e — [#59](https://github.com/KING-CYBERTON/careeros/pull/59), `a4beb8a`
- P2-T07 Branding and domains settings, web and mobile — [#56](https://github.com/KING-CYBERTON/careeros/pull/56), `423c27f`
- Docs sync 13 (Phase 2 exit review, baseline, P2-C03 spec) — [#60](https://github.com/KING-CYBERTON/careeros/pull/60), `436e1b9`
- P2-C03 Database suites run in CI, skipped-suite guard — [#61](https://github.com/KING-CYBERTON/careeros/pull/61), `efe4ae2`
