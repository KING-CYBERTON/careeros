# Production readiness checklist (v1.0.0)

**Owner:** Opus. **Generated from:** [PROMPTS.md](PROMPTS.md) prompt 2. **Last checked:** 2026-11-11 against `develop` at `859237f`.
Re-run prompt 2 after each milestone in [LAUNCH-PLAN.md](LAUNCH-PLAN.md). **B** marks a launch blocker; **S** should be done before the public launch; **F** can follow.

## Summary

| Status      | Count |
| ----------- | ----- |
| Done        | 15    |
| Partial     | 15    |
| Not started | 35    |

Every blocker that is not Done maps to a task in the launch plan. Production itself does not exist yet, so most infrastructure lines are Not started.

## 1. Release gate (PRODUCT.md §13a)

| #   | Check                                                            | Pri | Status      | Evidence                                                  | Owner         | Closes it              |
| --- | ---------------------------------------------------------------- | --- | ----------- | --------------------------------------------------------- | ------------- | ---------------------- |
| 1.1 | All P0 features in v1.0.0 scope are accepted against their specs | B   | Partial     | STATUS.md; P4-T04, P4-Q01, P5-Q01, #109 open              | Opus          | M1                     |
| 1.2 | The same build runs on staging and production, 72 hours green    | B   | Not started | No production                                             | Thread 3      | P6-C01, M4             |
| 1.3 | Full suite and isolation suite pass; no open Critical or High    | B   | Partial     | CI green on `develop`; P3-Q01 not written                 | Thread 2      | P3-Q01                 |
| 1.4 | Security review, load test and restore drill passed              | B   | Not started | —                                                         | Thread 2, 3   | P6-Q01, P6-Q02, P6-C02 |
| 1.5 | One-command deploy and one-command rollback proven on production | B   | Not started | Proven on staging only (`deploy.sh`, `rollback.sh`)       | Thread 3      | P6-C01                 |
| 1.6 | Pilot org onboarded with branding and a custom domain            | B   | Not started | Proven on staging by Stephen, 2026-11-02                  | Stephen, Opus | P6-T03                 |
| 1.7 | Terms, privacy and DPA live and approved; MIT NOTICE present     | B   | Partial     | Pages live (#73), 68 `[TO CONFIRM]` items; NOTICE present | Stephen       | G10                    |

## 2. Infrastructure and environments

| #   | Check                                                                    | Pri | Status      | Evidence                            | Owner    | Closes it |
| --- | ------------------------------------------------------------------------ | --- | ----------- | ----------------------------------- | -------- | --------- |
| 2.1 | Production hosting decided                                               | B   | Not started | GTM G8 open                         | Stephen  | G8        |
| 2.2 | Production domain decided, DNS on Cloudflare                             | B   | Not started | §15.1 open                          | Stephen  | M0        |
| 2.3 | Production has its own server or stack, database, storage and secrets    | B   | Not started | —                                   | Thread 3 | P6-C01    |
| 2.4 | Org host wildcard and Cloudflare for SaaS fallback origin on prod domain | B   | Not started | Staging equivalent done (P2-C01)    | Thread 3 | P6-C01    |
| 2.5 | Database roles split (owner migrates, app serves, no BYPASSRLS)          | B   | Done        | P1-C01; staging verified 2026-11-02 | —        | —         |
| 2.6 | `STRICT_SCHEMA_CHECK=true` in production                                 | S   | Not started | —                                   | Thread 3 | P6-C01    |
| 2.7 | Server sized for the pilot stage (§10) with swap and disk headroom       | S   | Not started | —                                   | Stephen  | G8        |

## 3. Deploy, release and rollback

| #   | Check                                                                 | Pri | Status      | Evidence                               | Owner    | Closes it |
| --- | --------------------------------------------------------------------- | --- | ----------- | -------------------------------------- | -------- | --------- |
| 3.1 | Only `careeros-image.yml` publishes on a `v*` tag                     | B   | Done        | P2-C04 (#64)                           | —        | —         |
| 3.2 | Branch protection on `develop` and `main`                             | B   | Partial     | Owner action listed in STATUS blockers | Stephen  | M0        |
| 3.3 | Promotion `develop` → `main` documented and done by Opus only         | B   | Not started | `main` is still the upstream commit    | Thread 3 | P6-C01    |
| 3.4 | Production deploy runs from a tag on `main` with a required reviewer  | B   | Not started | —                                      | Thread 3 | P6-C01    |
| 3.5 | Migrations run before traffic; failed health rolls back automatically | B   | Partial     | Staging does this                      | Thread 3 | P6-C01    |
| 3.6 | Release tags pushed (`v0.0.1` to `v0.2.0`)                            | S   | Not started | STATUS "Tags: none"                    | Stephen  | M0        |

## 4. Backups and restore

| #   | Check                                                   | Pri | Status      | Evidence | Owner    | Closes it |
| --- | ------------------------------------------------------- | --- | ----------- | -------- | -------- | --------- |
| 4.1 | Nightly encrypted database dump to an off-site bucket   | B   | Not started | GTM G9   | Thread 3 | P6-C02    |
| 4.2 | Storage synced off-site, 30 days kept                   | B   | Not started | GTM G9   | Thread 3 | P6-C02    |
| 4.3 | Restore drill scripted, timed and passed before release | B   | Not started | —        | Thread 3 | P6-C02    |
| 4.4 | Daily alert if a backup did not run                     | S   | Not started | GTM G11  | Thread 3 | P6-C02    |

## 5. Security

| #    | Check                                                                             | Pri | Status      | Evidence                                           | Owner    | Closes it |
| ---- | --------------------------------------------------------------------------------- | --- | ----------- | -------------------------------------------------- | -------- | --------- |
| 5.1  | RLS forced on every tenant table; cross-org fuzz passes                           | B   | Done        | P1-Q03, P1-Q10, P2-Q01                             | —        | —         |
| 5.2  | Phase 3 tables and procedures in the isolation registry and fuzz                  | B   | Partial     | Registry entries from P3-T01; P3-Q01 unwritten     | Thread 2 | P3-Q01    |
| 5.3  | Payment webhooks: signature first, idempotent, forgery and replay tested          | B   | Partial     | P3-T05 review; forgery tests in P3-Q01             | Thread 2 | P3-Q01    |
| 5.4  | Super admin paths audited, 2FA required, impersonation limited                    | B   | Done        | P3-T07, P3-T09, P3-Q03 (#97)                       | —        | —         |
| 5.5  | Discovery fetchers: host allow-list, no redirects, size cap, tested               | B   | Partial     | Built in P4-T01; attack tests in P4-Q01            | Thread 2 | P4-Q01    |
| 5.6  | Clipper: hostile page content and token misuse on another host tested             | B   | Partial     | Built in P5-T02/T03; tests in P5-Q01               | Thread 2 | P5-Q01    |
| 5.7  | Rate limits on auth, AI and webhook routes                                        | S   | Partial     | Upstream limiter plus P3 webhooks; not load-tested | Thread 2 | P6-Q02    |
| 5.8  | Secret scanning, push protection, Dependabot alerts on                            | S   | Partial     | Dependabot PRs open; settings are an owner action  | Stephen  | M0        |
| 5.9  | Launch security review of everything since the Phase 2 exit                       | B   | Not started | —                                                  | Opus     | P6-Q02    |
| 5.10 | Unsafe flags (`FLAG_ALLOW_UNSAFE_*`, `PAYSTACK_ALLOW_TEST_KEY`) off in production | B   | Not started | —                                                  | Thread 3 | P6-C01    |

## 6. Observability

| #   | Check                                                           | Pri | Status      | Evidence                     | Owner    | Closes it |
| --- | --------------------------------------------------------------- | --- | ----------- | ---------------------------- | -------- | --------- |
| 6.1 | `/api/health` reports status and revision                       | B   | Done        | Staging deploy check         | —        | —         |
| 6.2 | Uptime check on the platform host and one org host, with alerts | B   | Not started | GTM G11                      | Thread 3 | P6-C02    |
| 6.3 | Error reporting without personal data                           | S   | Not started | No error tracker wired       | Thread 3 | P6-C02    |
| 6.4 | Disk, memory and container restart alerts                       | S   | Not started | —                            | Thread 3 | P6-C02    |
| 6.5 | AI cost per org visible daily                                   | S   | Done        | Super admin console (P3-T07) | —        | —         |

## 7. Payments

| #   | Check                                                           | Pri | Status      | Evidence                  | Owner    | Closes it |
| --- | --------------------------------------------------------------- | --- | ----------- | ------------------------- | -------- | --------- |
| 7.1 | Paystack test mode works end to end on staging                  | B   | Not started | Waits on test keys (Q465) | Stephen  | P3-C01    |
| 7.2 | Phase 3 exit e2e passes (subscribe, seats, quota)               | B   | Not started | No spec yet               | Thread 2 | P3-Q02    |
| 7.3 | Paystack live business verification complete; live keys in prod | B   | Not started | —                         | Stephen  | M2        |
| 7.4 | Real prices set (D2)                                            | B   | Not started | Placeholders in `plan`    | Stephen  | D2        |
| 7.5 | Manual invoicing works for institutions                         | S   | Done        | P3-T04                    | —        | —         |
| 7.6 | Invoices with seller details and a PDF                          | S   | Partial     | #109 draft                | Opus     | M1        |

## 8. Email

| #   | Check                                                       | Pri | Status      | Evidence            | Owner   | Closes it |
| --- | ----------------------------------------------------------- | --- | ----------- | ------------------- | ------- | --------- |
| 8.1 | Delivery through Plunk with suppression and a test send     | B   | Done        | P6-T02 (#103, #106) | —       | —         |
| 8.2 | Production sending domain verified with SPF, DKIM and DMARC | B   | Not started | Needs the domain    | Stephen | M2        |
| 8.3 | Branded emails per org                                      | S   | Done        | P2-T04 (#52)        | —       | —         |

## 9. AI

| #   | Check                                                             | Pri | Status      | Evidence                          | Owner         | Closes it |
| --- | ----------------------------------------------------------------- | --- | ----------- | --------------------------------- | ------------- | --------- |
| 9.1 | Every platform-key call writes `ai_usage`; 80% warning, 100% stop | B   | Done        | P3-T03 (#74)                      | —             | —         |
| 9.2 | Job text and uploads are untrusted data in prompts                | B   | Done        | P4-T02 review, `ai/data-block.ts` | —             | —         |
| 9.3 | Platform AI route complies with §1.5.9 (Claude API only)          | B   | Partial     | #109 adds OpenRouter              | Stephen, Opus | Decision  |
| 9.4 | Production AI key has a spend limit set at the provider           | S   | Not started | —                                 | Stephen       | M2        |

## 10. Legal and compliance

| #    | Check                                                                            | Pri | Status      | Evidence                           | Owner         | Closes it        |
| ---- | -------------------------------------------------------------------------------- | --- | ----------- | ---------------------------------- | ------------- | ---------------- |
| 10.1 | Terms, privacy, DPA approved by Stephen or a lawyer                              | B   | Not started | 68 `[TO CONFIRM]` items            | Stephen       | G10              |
| 10.2 | ODPC registration as required                                                    | S   | Not started | PRODUCT.md §9                      | Stephen       | M3               |
| 10.3 | Subprocessors list published (hosting, Cloudflare, Plunk, Paystack, AI provider) | S   | Not started | —                                  | Opus, Stephen | P6-T01 follow-up |
| 10.4 | MIT NOTICE and open-source licenses page                                         | B   | Done        | NOTICE, P2-T08 (#47)               | —             | —                |
| 10.5 | User data export and account deletion work                                       | S   | Done        | Upstream, tenant-scoped in Phase 1 | —             | —                |

## 11. Support and operations

| #    | Check                                                  | Pri | Status      | Evidence                                         | Owner         | Closes it |
| ---- | ------------------------------------------------------ | --- | ----------- | ------------------------------------------------ | ------------- | --------- |
| 11.1 | Go-live runbook written and rehearsed once             | B   | Partial     | [GO-LIVE-RUNBOOK.md](GO-LIVE-RUNBOOK.md) written | Opus, Stephen | M3        |
| 11.2 | Support contact on the platform and legal pages        | S   | Not started | —                                                | Stephen       | M2        |
| 11.3 | Incident process: who is paged, who decides a rollback | S   | Partial     | Runbook section 6                                | Stephen       | M3        |
| 11.4 | Platform admin accounts with 2FA for each operator     | B   | Done        | P3-T07 runbook                                   | —             | —         |

## 12. Browser clipper

| #    | Check                                                | Pri | Status      | Evidence                               | Owner   | Closes it |
| ---- | ---------------------------------------------------- | --- | ----------- | -------------------------------------- | ------- | --------- |
| 12.1 | Packaged and versioned in CI                         | S   | Done        | P5-C01 (#94)                           | —       | —         |
| 12.2 | Store developer accounts open                        | S   | Not started | GTM waiting list                       | Stephen | M0        |
| 12.3 | Store data-handling answers match the privacy policy | S   | Not started | Q404, depends on G10                   | Stephen | G10       |
| 12.4 | Listing submitted and approved                       | F   | Not started | `docs/runbooks/job-clipper-release.md` | Stephen | M1 to M4  |
