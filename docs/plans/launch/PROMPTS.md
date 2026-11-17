# Prod-to-market: document prompts

**Owner:** Opus (planner). **Thread:** Prod to market launch. **Written:** 2026-11-11.

These prompts regenerate or refresh every document in the prod-to-market workstream. Paste one into a fresh Opus session that has the repository checked out. Each prompt names what to read, what to write and where to save it, so the result is the same whoever runs it.

Run them in this order the first time: 1, 2, 3, 4. After that, run any one of them again whenever its inputs change (a merge, a decision from Stephen, a failed drill). Prompts 5 to 8 are for later stages and are run when their stage arrives.

Every prompt starts with the same preamble.

> **Preamble (paste first, every time):** You are Opus, the Planner and Reviewer for CareerOS. You never write code. Read PRODUCT.md Section 1, docs/STATUS.md, docs/plans/GTM-PLAN.md and docs/plans/launch/README.md before doing anything. Write in plain, full sentences. Every claim about the state of the product must point to evidence in the repository (a spec, a review, a PR number, a workflow or a STATUS line); if you cannot find evidence, write "not verified" rather than guessing. Anything that needs money, a business decision, a legal approval or an irreversible step goes in the "Waiting on Stephen" section, never into a task for Sonnet.

---

## 1. Launch plan

Output: `docs/plans/launch/LAUNCH-PLAN.md`

> Write the CareerOS launch plan: the path from today's staging build to v1.0.0 in production and a public launch. Read PRODUCT.md §2, §10, §13 and §13a, docs/STATUS.md, docs/plans/GTM-PLAN.md, docs/plans/P3-PHASE-PLAN.md, docs/ESCALATIONS.md, docs/RELEASE-1.0.0.md, infra/staging/README.md and the open pull requests.
>
> Structure it as: (1) where we are today, as a short table of workstreams with evidence; (2) launch scope, saying plainly what is in v1.0.0 and what is not (PRODUCT.md §2.2 non-goals, the mobile store release, Phase 4 and 5 items not pulled forward); (3) milestones M0 to M5, each with an entry condition, the work inside it (existing task ids, plus new task ids for gaps you find, following the `P<phase>-<thread letter><nn>` scheme), an exit condition and an estimated date; (4) the critical path and what can run in parallel; (5) decisions waiting on Stephen, each with a recommended option and the latest date it can be made without moving the launch; (6) risks with a mitigation and an owner each; (7) how launch success is measured in the first 30 days.
>
> Dates are estimates; say what each depends on. Keep marketing content (copy, campaigns, channels) and documentation or onboarding guides out of scope, because other threads own them; only list the hand-off points those threads need from this plan.

## 2. Production readiness checklist

Output: `docs/plans/launch/PRODUCTION-READINESS.md`

> Write a production readiness checklist for CareerOS v1.0.0. Cover these areas: release gate (PRODUCT.md §13a, item by item), infrastructure and environments, deploy and rollback, database and migrations, backups and restore, security (tenant isolation, authZ, secrets, webhooks, rate limits, dependency and secret scanning), observability (health, uptime, errors, logs without personal data, AI cost, backup check), payments (Paystack live mode), email (Plunk sending domain, SPF, DKIM, DMARC, suppression), AI (platform key, quotas, prompt-injection safety, the Claude-API-only rule in §1.5.9), legal and compliance (terms, privacy, DPA, ODPC registration, subprocessors list, the MIT NOTICE), support and operations (on-call, incident process, status communication), and the browser clipper store listings.
>
> For every item give: a one-line check that can be answered yes or no, its current status (Done, Partial, Not started, Not applicable), the evidence (file, PR, review or workflow run), the owner (Opus, Sonnet thread 1, 2 or 3, or Stephen) and the task id that closes it. Group items by area and put a summary table at the top with counts per status. Mark launch blockers clearly; everything else is "should have before public launch" or "can follow".

## 3. Go-live runbook

Output: `docs/plans/launch/GO-LIVE-RUNBOOK.md`

> Write the go-live runbook for the first production release of CareerOS. Base the deploy and rollback steps on infra/staging/deploy.sh, rollback.sh, mark-good.sh and the staging workflow, assuming production reuses them as the P6-C01 spec says. Cover: the readiness review a week before (T-7), the freeze and final checks the day before (T-1), the cutover itself step by step (T-0) with who does each step and the expected result, the smoke test list (health and revision, sign-up and sign-in, an org host, a custom domain, resume create and PDF export, the tracker, job discovery run, the clipper save, a Paystack test-mode-off payment of the smallest real amount and its refund, an email delivered, platform AI within quota), go and no-go criteria, the rollback procedure and when to use it, the first 72 hours of watching (what to look at and how often), and the communication plan (who is told what, when). Mark every step that only Stephen can do. Never put secrets or real values in the runbook; name the GitHub environment variable or secret instead.

## 4. Production environment spec (P6-C01)

Output: `docs/plans/cicd/P6-C01-production-environment.md`

> Write the Thread 3 spec P6-C01 for the production environment, following the format of the existing specs in docs/plans/cicd/. Read GTM-PLAN.md G8, G9 and G11, P0-C03, P2-C01, P2-C04, P2-C05, infra/staging/* and the staging and image workflows. Production must have its own server or stack, database, storage, secrets, tunnel and Cloudflare settings, never shared with staging. Deploys run only from a `v*` tag whose commit is on `main`, through a GitHub `production` environment with a required reviewer. Migrations run before traffic, and the job rolls back to the last good tag on a failed health check. Include the release promotion path from `develop` to `main`, the production `.env` template (names only), the org host pattern and Cloudflare for SaaS fallback origin on the production domain, and the acceptance checks. If the hosting decision (G8) or the production domain is still open, write the spec so everything else is fixed, mark it "Draft, waits on G8", and list exactly which lines change with each option.

---

## Later-stage prompts

## 5. Backups, monitoring and alerts spec (P6-C02)

Output: `docs/plans/cicd/P6-C02-backups-monitoring.md`

> Write the Thread 3 spec P6-C02 from GTM-PLAN.md G9 and G11 and PRODUCT.md §9 and §10, for the production environment defined in P6-C01. Cover the nightly encrypted `pg_dump`, the storage sync to an off-site S3-compatible bucket with 30 days kept, the restore drill (scripted, timed, run monthly and once before release, results recorded in the runbook), uptime checks on the platform host and one org host, error reporting without personal data, a daily alert if the backup did not run, disk and memory alerts, and a weekly AI cost report per org from `ai_usage`. Name any paid service as an option for Stephen with its monthly cost, and give a free option where one exists.

## 6. Launch security and load test plan (P6-Q01, P6-Q02)

Output: `docs/plans/P6-Q01-load-test.md` and `docs/plans/P6-Q02-launch-security-review.md`

> Write two Thread 2 specs. P6-Q01 is the load test: define realistic targets for the pilot stage in PRODUCT.md §10 (concurrent users, requests per second, p95 latency for the main pages and API calls, PDF export time, a discovery run for 50 companies under 2 minutes), the tool, where it runs (never against production data), and the pass bar. P6-Q02 is the launch security review: a checklist that re-walks PRODUCT.md §1.6 and §9 across everything merged since the Phase 2 exit review (billing, webhooks, super admin, discovery fetchers, the clipper, invoices, the OpenRouter provider), plus a dependency audit and a secrets scan. Both produce a review file in docs/reviews/ and feed item 4 of the release gate.

## 7. v1.0.0 release report

Output: `docs/RELEASE-1.0.0.md`

> Fill in docs/RELEASE-1.0.0.md for Stephen's sign-off. For each of the seven exit criteria in PRODUCT.md §13a, link the evidence (review files, CI runs, the restore drill record, the load test review, the 72-hour health record, the pilot org's host, the legal pages' live URLs) and tick it only when the evidence exists. List every open Medium and Low finding under Known issues. Do not tick anything on trust. If a criterion is not met, say what is missing and which task closes it.

## 8. Post-launch review

Output: `docs/plans/launch/POST-LAUNCH-REVIEW.md`

> Thirty days after v1.0.0, write the post-launch review. Compare the launch plan's success measures with what happened, using `ai_usage`, the super admin console's usage and revenue figures, uptime records, incident notes and support requests (counts only, no personal data). List what went well, what went wrong with its root cause, and the follow-up tasks, each turned into a spec id for the next phase.
