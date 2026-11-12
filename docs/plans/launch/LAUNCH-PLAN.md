# CareerOS launch plan: staging to production and market

**Status:** Approved by Opus (2026-11-11) for everything that does not wait on a decision. The dates depend on the decisions in "Waiting on Stephen" being made by the date shown against each.
**Generated from:** [PROMPTS.md](PROMPTS.md) prompt 1. **Related:** [GTM-PLAN.md](../GTM-PLAN.md), [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md), [GO-LIVE-RUNBOOK.md](GO-LIVE-RUNBOOK.md), [P6-C01](../cicd/P6-C01-production-environment.md).

## 1. Where we are (2026-11-11)

| Workstream                       | State                                                                                                                                                                                                                        | Evidence                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Phases 0, 1, 2                   | Exit criteria met; staging verified live by Stephen on 2026-11-02. Tags `v0.0.1`, `v0.1.0`, `v0.2.0` are not pushed yet.                                                                                                     | STATUS.md, P1 and P2 exit reviews                          |
| Phase 3 (admin and billing)      | P3-T01 to T09 and P3-Q03 merged. Invoices and the OpenRouter provider (P3-T10, T11, T12) are in draft PR #109, which has merge conflicts. P3-Q01 (isolation and webhook forgery), P3-Q02 (exit e2e) and P3-C01 have no spec. | STATUS.md, #97, #109                                       |
| Job discovery (pulled forward)   | P4-T01 to T03 merged. P4-T04 (recommended companies to cohorts) and P4-Q01 (SSRF, dedupe, 2-minute target) are not started.                                                                                                  | #68, #91, #96                                              |
| Browser clipper (pulled forward) | P5-T01 to T03 and P5-C01 merged. P5-Q01 (clipper tests) not started. Store accounts not opened.                                                                                                                              | #66, #78, #95, #94, `docs/runbooks/job-clipper-release.md` |
| Email                            | Plunk delivery, branded emails and per-stage templates merged.                                                                                                                                                               | #52, #103, #104, #106                                      |
| Legal                            | Terms, privacy and DPA drafted and served; 68 `[TO CONFIRM]` items wait on the operator's details or a lawyer.                                                                                                               | #73, `docs/legal/`                                         |
| Marketing site                   | Home page and organisations page live at `/` on the staging platform host.                                                                                                                                                   | #110, #111                                                 |
| Production                       | Nothing exists. `main` still points at the upstream base commit. No production spec, no backups, no monitoring.                                                                                                              | `git log origin/main`, GTM-PLAN G8                         |

## 2. Launch scope

**In v1.0.0 (web, responsive):** everything already on staging: multi-tenancy, white-label branding, org hosts and custom domains, the resume and cover-letter editor, the tracker, the AI assistant on the platform key with metering and quotas, billing through Paystack (cards and M-Pesa) plus manual invoices, super admin and org admin consoles, job discovery on Greenhouse, Lever and Ashby, the browser clipper for Chrome and Edge, branded email, and the legal pages.

**Not in v1.0.0:** native mobile store builds (PRODUCT.md §2.2 makes native apps a v1 non-goal, and the native identity is still the upstream one, Q80); the rest of Phase 4 (question bank, timeline, companies, tasks); the rest of Phase 5 (coaching layer, broader job feed); SSO for orgs, audit log UI beyond Phase 3, the dedicated tier and the coach role. These follow as `1.x` releases.

## 3. Milestones

| #   | Milestone                        | Entry                                  | Work                                                                                                                                                                                                                                                                                         | Exit                                                                                                                                            | Estimate   |
| --- | -------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| M0  | Unblock                          | Now                                    | Stephen's items in section 5: hosting (G8), production domain, prices (D2), tags, the staging runner restart, Paystack test keys, store accounts.                                                                                                                                            | G8 and the domain decided; staging runs the latest `develop`.                                                                                   | 2026-11-18 |
| M1  | Feature freeze (`0.3.0`)         | M0 tags pushed                         | Rebase and merge #109 (P3-T10 to T12). New specs and code: **P3-Q01**, **P3-Q02** (subscribe, add seats, hit the quota in Paystack test mode), **P3-C01** (platform AI and Paystack secrets on staging, period jobs). **P4-T04**, **P4-Q01**, **P5-Q01**. Stephen approves the legal drafts. | Phase 3 exit criteria met; Opus tags `v0.3.0`; no new features enter v1.0.0 after this.                                                         | 2026-11-27 |
| M2  | Production environment           | G8 and domain decided (runs beside M1) | **P6-C01** production stack, deploy on `v*` tag from `main`, rollback. **P6-C02** backups, restore drill, uptime and error alerts, backup check. Plunk sending domain verified for the production domain. Paystack live keys (Stephen).                                                      | Production serves a health check on its own domain from its own database; a deploy and a rollback have each been run once with a throwaway tag. | 2026-11-30 |
| M3  | Release candidate (`1.0.0-rc.1`) | M1 and M2 done                         | Promote `develop` to `main`, tag `v1.0.0-rc.1`, deploy to staging then production. **P6-Q01** load test and **P6-Q02** launch security review on the candidate. Restore drill on production backups. Fixes go out as `rc.2`, `rc.3`.                                                         | Zero open Critical or High findings; load test meets its targets; restore drill passed and timed.                                               | 2026-12-07 |
| M4  | Soft launch (pilot)              | M3 done                                | **P6-T03** pilot org onboarding: its branding, custom domain, first members, a real payment. The go-live runbook is run for the first time. Production is open to invited orgs only; public sign-up stays on.                                                                                | Pilot org live on its own domain; 72 hours of green health checks on the same build on staging and production.                                  | 2026-12-11 |
| M5  | v1.0.0 and public launch         | M4 done                                | Opus fills `docs/RELEASE-1.0.0.md` (prompt 7). Stephen signs off. Opus tags `v1.0.0`. The marketing thread starts its public campaign; the docs and onboarding thread publishes the guides.                                                                                                  | Stephen's sign-off recorded; `v1.0.0` running on both environments.                                                                             | 2026-12-15 |

### New tasks this plan adds

| Task   | Thread | Title                                                                                                                                                  | Milestone |
| ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| P3-Q01 | 2      | Phase 3 isolation: new tables in the registry, cross-org fuzz for billing and admin procedures, seat and suspension bypass, webhook forgery and replay | M1        |
| P3-Q02 | 2      | Phase 3 exit e2e in Paystack test mode (subscribe, add seats, 80% warning, 100% stop)                                                                  | M1        |
| P3-C01 | 3      | Staging secrets for platform AI and Paystack test mode, webhook route through the tunnel, billing period jobs scheduled                                | M1        |
| P6-C01 | 3      | Production environment, release promotion to `main`, deploy on tag, rollback ([spec](../cicd/P6-C01-production-environment.md), draft)                 | M2        |
| P6-C02 | 3      | Backups, restore drill, monitoring and alerts (prompt 5)                                                                                               | M2        |
| P6-Q01 | 2      | Load test against the pilot-stage targets (prompt 6)                                                                                                   | M3        |
| P6-Q02 | 2      | Launch security review of everything merged since the Phase 2 exit (prompt 6)                                                                          | M3        |
| P6-T03 | 1      | Pilot org onboarding checklist and any fixes it finds                                                                                                  | M4        |

## 4. Critical path

The critical path is **G8 and the production domain → P6-C01 → P6-C02 → rc.1 → load test and security review → pilot → 72 hours green → sign-off**. Production work cannot start until Stephen picks where it runs and what it is called, so those two decisions move the launch day for day.

Running in parallel with it: the M1 feature freeze work (Thread 1 and 2), the legal approval (Stephen), Paystack live onboarding (Stephen, can take several business days for business verification), and the clipper store review (Stephen opens the accounts; review can take days to weeks, so submit at M1, not at M4).

## 5. Waiting on Stephen

| Item                          | Recommendation                                                                                                                                                                                                    | Decide by          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **G8 production hosting**     | A cloud VPS separate from the home lab (4 vCPU, 8 GB, about USD 15 to 25 a month), Docker Compose as on staging, Cloudflare in front. The home lab stays staging.                                                 | 2026-11-18         |
| **Production domain** (§15.1) | Pick the product name and primary domain now; org hosts become `<slug>.<domain>` and custom domains CNAME to a fallback origin on it. Changing it after launch breaks every org's address and the clipper setup.  | 2026-11-18         |
| **D2 prices**                 | Set Starter, Pro, Enterprise and Individual prices in USD and KES and the AI credits per seat. Placeholders are in the `plan` table today.                                                                        | 2026-11-25         |
| **Legal approval (G10)**      | Fill the operator details and have a lawyer read the three drafts. Register with the ODPC as required by the Kenya Data Protection Act 2019.                                                                      | 2026-11-27         |
| **Paystack**                  | Test keys on staging now (Q465); start live business verification now so live keys are ready for M2.                                                                                                              | 2026-11-18         |
| **Store accounts**            | Chrome Web Store developer account (USD 5 once) and Microsoft Partner Center (free).                                                                                                                              | 2026-11-25         |
| **Tags and runner**           | Push `v0.0.1`, `v0.1.0`, `v0.2.0`; restart the staging runner if it is still stuck.                                                                                                                               | 2026-11-14         |
| **Pilot organization**        | Name one friendly organization for M4, with a custom domain they control.                                                                                                                                         | 2026-12-01         |
| **Platform AI route**         | PRODUCT.md §1.5.9 says "Claude API only". #109 adds OpenRouter as the platform provider. Either confirm the route reaches Claude models only and amend the rule, or keep the direct Anthropic key for production. | Before #109 merges |

## 6. Risks

| Risk                                                                 | Mitigation                                                                                             | Owner         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------- |
| Production on a home-lab server fails with power or connectivity     | Recommend a cloud VPS (section 5); backups off-site either way                                         | Stephen       |
| The production domain changes after orgs are onboarded               | Decide it in M0; P6-C01 keeps the domain in configuration only                                         | Stephen, Opus |
| Paystack live verification or store review takes longer than planned | Start both now; the launch can go ahead with manual invoices and without the clipper if either is late | Stephen       |
| One person runs operations                                           | Alerts go to two contacts; the runbook is written so a second person can roll back                     | Opus, Stephen |
| AI cost runs ahead of revenue                                        | Quotas and the hard stop are built; P6-C02 adds a weekly cost report per org                           | Opus          |
| Legal drafts go live without review                                  | Release gate item 7 blocks v1.0.0 until Stephen approves them                                          | Stephen       |
| #109 is large (31,500 lines added) and has conflicts                 | Rebase onto `develop`, review in parts, keep it inside M1 or move invoices to `1.0.1`                  | Opus          |

## 7. Success measures (first 30 days after v1.0.0)

- Uptime of 99.5% or better on the platform host, measured by the uptime check.
- No tenant isolation incident and no Critical security finding.
- The pilot org active: at least half of its invited members sign in and create a resume.
- At least three paying organizations, with every payment reconciled in the super admin console.
- AI cost per active member below the price of the credits it uses.
- Restore drill repeated once after launch, inside the time recorded at M3.

## Hand-offs to other threads

- **Marketing:** the public launch date (M5), the final prices (D2), the product name and domain, and the clipper store links once published.
- **Documentation and onboarding:** the org owner setup path used for the pilot (P6-T03), and the support contact for the legal pages.
- **Product management:** the "not in v1.0.0" list in section 2 is the starting backlog for `1.x`.
