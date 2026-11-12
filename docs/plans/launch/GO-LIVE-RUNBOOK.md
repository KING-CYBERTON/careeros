# Go-live runbook: first production release

**Owner:** Opus (writes and updates), Stephen (runs the owner steps). **Generated from:** [PROMPTS.md](PROMPTS.md) prompt 3.
**Applies to:** `v1.0.0-rc.N` going to production for the pilot (launch plan M4), and again for `v1.0.0` (M5).
**Assumes:** production is built as in [P6-C01](../cicd/P6-C01-production-environment.md): its own server or stack, the staging `deploy.sh`, `mark-good.sh` and `rollback.sh` reused, and a GitHub `production` environment with a required reviewer.

No secrets or real values belong in this file. Steps name the GitHub secret or variable instead. 👤 marks a step only Stephen can do.

## 1. T-7: readiness review

1. Opus re-runs prompt 2 and updates [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md). Every **B** line must be Done, or have Stephen's written acceptance as a known gap.
2. Opus confirms the candidate tag has run on staging for at least 48 hours with green health checks and no new Critical or High findings.
3. The restore drill (P6-C02) has passed on production backups within the last 7 days. Record its duration.
4. 👤 Stephen confirms: legal pages approved, prices set (D2), Paystack live keys stored in the `production` environment as `PAYSTACK_SECRET_KEY` and `PAYSTACK_PUBLIC_KEY`, the production AI key stored with a spend limit set at the provider, the sending domain verified in Plunk.
5. Agree the cutover window: a weekday morning East Africa Time, with Stephen and one Opus session available for 3 hours.

## 2. T-1: freeze and final checks

1. Opus stops merging to `develop` except fixes for the candidate.
2. Opus promotes the candidate commit from `develop` to `main` by a merge PR, and tags it `v1.0.0-rc.N` on `main` (annotated). 👤 Stephen pushes the tag if the session cannot.
3. Check `careeros-image` published `ghcr.io/king-cyberton/careeros:<version>` for that tag.
4. Take a manual production backup and confirm it reached the off-site bucket (first release: confirm the empty database backup works).
5. Check the production `.env` against `.env.production.example` by name only: every required variable present, `PAYSTACK_ALLOW_TEST_KEY` absent or false, no `FLAG_ALLOW_UNSAFE_*`, `STRICT_SCHEMA_CHECK=true`.
6. Confirm the uptime checks and alert contacts (two people) are live and send a test alert.
7. Write the go or no-go note in the thread: candidate tag, readiness counts, known gaps.

## 3. T-0: cutover

| Step | Who            | Action                                                                                          | Expected result                                       |
| ---- | -------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1    | 👤 Stephen     | Approve the `careeros-deploy-production` run for the tag in the GitHub `production` environment | Job starts on the production runner                   |
| 2    | Workflow       | Pull the image, run migrations as the owner role, start the app as the app role                 | Migrations finish; no schema drift reported           |
| 3    | Workflow       | Wait for `/api/health`                                                                          | `status: healthy`, `revision` equals the tag's commit |
| 4    | Workflow       | Run the smoke test                                                                              | Passes; `mark-good.sh <tag>` records it               |
| 5    | Opus + Stephen | Run the manual smoke list in section 4                                                          | Every line passes                                     |
| 6    | 👤 Stephen     | Go or no-go call                                                                                | Go: continue to section 5. No-go: section 6           |

## 4. Manual smoke list

Use a dedicated smoke organization, never the pilot's data.

1. Platform host `/api/health` shows the right revision; the home page and `/organisations` load.
2. Sign up with a new email; the verification email arrives from the production sending domain.
3. Sign in with 2FA as a platform admin; the super admin console lists the smoke org.
4. The smoke org's host `<slug>.<production domain>` shows its branding; a session from it cannot act on another org.
5. A custom domain added to the smoke org verifies, gets TLS and serves the org.
6. Create a resume, export it to PDF and DOCX.
7. Add an application to the tracker; move it across stages.
8. Run a job discovery automation for two known Greenhouse boards; accept one job into the tracker.
9. Save a job with the clipper pointed at the production smoke org.
10. Platform AI: one assistant request succeeds and writes an `ai_usage` row visible in the console.
11. 👤 Pay the smallest real amount on the smoke org with Paystack (card or M-Pesa); the webhook marks the subscription active; refund it in the Paystack dashboard.
12. The terms, privacy and licenses pages load from the footer.

## 5. After go: first 72 hours

- Hour 0 to 4: Opus watches health, error logs and the alert channel every 30 minutes. Stephen onboards the pilot org (P6-T03).
- Day 1 to 3: check twice a day: uptime, error count, failed payments, `ai_usage` cost against quota, the nightly backup result, disk and memory.
- Record each check in the thread in one line. The 72-hour clock for release gate item 2 restarts if the build changes.
- At 72 hours green, Opus starts the release report (prompt 7).

## 6. Rollback

Roll back when any of these happens and a fix is not certain within 30 minutes: health check failing, a tenant isolation doubt, payments failing for everyone, sign-in failing, data loss suspected.

1. Opus or Stephen runs the `careeros-deploy-production` workflow with `rollback` (or on the server as the `deploy` user: `./rollback.sh`). It redeploys `.previous_tag`.
2. Migrations are forward-only. A rollback across a migration needs the release's migration to be backward-compatible (P6-C01 rule); if it is not, restore from the T-1 backup instead. 👤 Restoring production data is irreversible and needs Stephen's go-ahead (PRODUCT.md §1.5.4).
3. Check health and revision show the previous tag; run smoke items 1 to 3.
4. Post in the thread what happened and what the fix is. Opus writes a review file for the failure before the next attempt.
5. If a tenant isolation leak is suspected, treat it as Critical: put the platform into read-only for affected orgs (suspend), keep the logs, and Stephen decides on notifying affected orgs under the Kenya Data Protection Act 2019 breach process.

## 7. Communication

| When         | Who tells | Whom              | What                                  |
| ------------ | --------- | ----------------- | ------------------------------------- |
| T-7          | Opus      | Stephen (thread)  | Readiness counts and the gaps         |
| T-1          | Stephen   | Pilot org contact | Cutover window and what to expect     |
| T-0 go       | Stephen   | Pilot org contact | Their address is live, how to sign in |
| T-0 rollback | Stephen   | Pilot org contact | Short delay notice, new time          |
| 72 h         | Opus      | Stephen (thread)  | Release report started                |
| v1.0.0       | Stephen   | Marketing thread  | Go for public launch                  |
