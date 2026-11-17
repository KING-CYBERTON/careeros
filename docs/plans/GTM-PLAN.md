# Go-to-market release: plan

**Status:** Approved by Opus (2026-11-02) for the tasks that do not depend on an open decision. **Decided by Stephen (2026-11-02):** one go-to-market release, built alongside Phase 3 ([P3-PHASE-PLAN.md](P3-PHASE-PLAN.md) D11).
**Release:** the first `1.0.0-rc.1` candidate on staging, once Phase 3 has exited (`0.3.0`) and everything here is merged. **Estimate:** 3 to 4 weeks, in parallel with Phase 3.

## Scope

This plan pulls forward three pieces of later phases:

- **Job discovery**, from Phase 4 (PRODUCT.md §8.1). The rest of Phase 4 (question bank, timeline, companies, tasks) stays in Phase 4.
- **The browser job clipper**, from Phase 5 (§8.2). The rest of Phase 5 (coaching, email templates, broader feed) stays in Phase 5.
- **The launch basics**, from Phase 6: a production environment, backups with a restore drill, terms and privacy pages, and basic monitoring. The full Phase 6 gate (load test, pilot org, §13a) still applies before `1.0.0`.

Task ids keep their home phase, so the later phase plans can pick up where this one leaves off.

## Key decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | **Discovery sources v1** are the public job board APIs of Greenhouse (`boards-api.greenhouse.io`), Lever (`api.lever.co`, `api.eu.lever.co`) and Ashby (public job board API). They need no keys. Adzuna is v1.1. Outbound requests go only to an allow-list of these hosts, over https, with a timeout, a response size cap and no redirects to other hosts. A board is named by its token (for example a Greenhouse board slug), never by a free URL, so nobody can point the fetcher at an internal address.                                            |
| G2  | **Discovery data** uses the §6.2 tables: `job_source` (a user's automation: titles, skills, locations, remote preference, companies, schedule), `discovery_run` and `discovered_job`. All are tenant tables under RLS. `discovered_job` is unique on (org, user, source, external job id), so a dismissed job never comes back: dismissal is a status, never a delete.                                                                                                                                                                                     |
| G3  | **Pipeline:** fetch, dedupe, local relevance score (title, skill and keyword match, in code), then AI match on the top N only (default 10, capped by the plan) through the T03 metered platform model (`discovery.match`, fast model), then the review queue. Accepting creates an application in the tracker with the full description, sanitized. Runs use the existing scheduler (P1-T07) on the user's daily or weekly schedule. A run for 50 companies must finish within 2 minutes (§8.1 acceptance). Discovery is a plan feature (`job_discovery`). |
| G4  | **Untrusted text.** Job descriptions from boards and from the clipper are data. They are stored as sanitized text or HTML using the existing sanitizer, never executed, and passed to the model only inside a delimited data block with an injection-safe system prompt. The existing `ai/data-block.ts` pattern is reused.                                                                                                                                                                                                                                |
| G5  | **Clipper app** lives in `apps/extension`: Manifest V3, for Chrome and Edge. It holds no product branding in the package. On first run the user enters their organization's address (org host, custom domain or the platform host), and the popup shows that org's name and logo from the public branding endpoint. One store listing serves every org; per-org branded builds are a later option (PRODUCT.md §7).                                                                                                                                         |
| G6  | **Clipper sign-in** uses the OAuth 2.0 device authorization flow (Better Auth's device authorization plugin, if the installed version has it; otherwise a host-bound one-time code following the P2-T05 handoff pattern). The token is bound to the org host it was issued on, stored in `chrome.storage.local`, and revocable from the member's settings. The extension asks only for `activeTab`, `storage` and `scripting`, plus host permission for the chosen org address. It never asks for all-sites access.                                        |
| G7  | **Clipping:** on click the extension reads JSON-LD `JobPosting` from the active tab when present, otherwise it uses generic heuristics. The user confirms or edits in the popup, then it posts to the existing applications create procedure with a `source: clipper` marker. Server-side AI cleanup is optional and metered, and off when the org has no platform AI.                                                                                                                                                                                     |
| G8  | **Production environment.** Open with Stephen: where it runs (§15.3). Whatever the host, production gets its own database, storage and secrets, never shared with staging. Deploys run only from a `v*` tag promoted to `main`, with migrations before traffic and rollback to the last good tag, reusing the staging deploy and rollback scripts.                                                                                                                                                                                                         |
| G9  | **Backups:** a nightly encrypted `pg_dump` and a storage sync to an off-site S3-compatible bucket, with 30 days kept. A restore drill into a scratch database runs monthly, and once before release, with its timing recorded in the runbook.                                                                                                                                                                                                                                                                                                              |
| G10 | **Legal pages:** CareerOS drafts plain-language terms of service and a privacy policy that cover Kenya's Data Protection Act 2019 and GDPR basics, and a data processing addendum for org customers. Stephen (or his lawyer) must approve the text before launch; these are drafts, not legal advice. Each org's own legal links (P2-T01) still override them on org hosts.                                                                                                                                                                                |
| G11 | **Monitoring:** health checks and uptime alerts on production, error logging without personal data, and a daily check that the backup ran.                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Tasks

| Task   | Thread | Title                                                                                                                         | Depends on     |
| ------ | ------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------- |
| P4-T01 | 1      | Discovery tables, RLS, board fetchers (G1), dedupe, local scoring                                                             | —              |
| P4-T02 | 1      | Discovery runs on the scheduler, AI match on top N (G3), review queue, accept into the tracker, plan feature gate             | P4-T01, P3-T03 |
| P4-T03 | 1      | Discovery UI on web and mobile: automations, the review queue, run history                                                    | P4-T02         |
| P4-T04 | 1      | Org admins push recommended companies to cohorts (§8.1)                                                                       | P4-T01, P3-T08 |
| P4-Q01 | 2      | Discovery tests: SSRF and host allow-list, dedupe and "never reappears", the 2-minute target, AI calls ≤ N, isolation         | P4-T02         |
| P5-T01 | 1      | `apps/extension` MV3 scaffold, org address setup, branded popup (G5)                                                          | —              |
| P5-T02 | 1      | Clipper sign-in: device flow, host-bound tokens, revocation (G6)                                                              | P5-T01         |
| P5-T03 | 1      | Clipping: JSON-LD and heuristics, confirm and edit, save to tracker (G7), optional metered AI cleanup                         | P5-T02         |
| P5-Q01 | 2      | Clipper tests: JSON-LD fixtures, the manual fallback, a custom-domain org, token misuse on another host, hostile page content | P5-T03         |
| P5-C01 | 3      | Extension build, zip and version in CI; store submission steps in the runbook                                                 | P5-T01         |
| P6-C01 | 3      | Production environment per G8, deploy-on-tag to `main`, rollback                                                              | G8 decision    |
| P6-C02 | 3      | Backups and restore drill (G9), monitoring and alerts (G11)                                                                   | P6-C01         |
| P6-T01 | 1      | Terms, privacy and DPA drafts and their pages (G10)                                                                           | —              |

P4-T01, P5-T01 and P6-T01 can start now.

## Waiting on Stephen

- **Production hosting (G8):** the same VPS as staging, or a cloud server.
- **Chrome Web Store developer account** (a one-time USD 5 fee) and a Microsoft Partner Center account for Edge (free), so the clipper can be published.
- **Approval of the legal drafts (G10)** before launch.

## Risks

- **Fetching from the internet** is a new server-side risk. G1's allow-list and token-only board ids are the guard, and Q01 attacks them.
- **Extension store review** can take days to weeks. Submit early, with a minimal permission set.
- **AI cost** from discovery runs on a schedule. N is capped by the plan, and every call is metered through T03.
