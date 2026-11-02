# P4-T01: Job discovery data, board fetchers, dedupe and local scoring

**Status:** Approved (Opus, 2026-11-02). **Thread:** 1 Build. **Plan:** [GTM-PLAN.md](GTM-PLAN.md), decisions G1, G2, G3 (the local part) and G4.
**Branch:** `feat/P4-T01-discovery-core`. **Questions:** start at Q220.

## Goal

Build the core of automated job discovery: saved automations, safe fetchers for three public job board APIs, de-duplication, and a local relevance score. Scheduling, AI match, the review queue and accepting into the tracker are P4-T02. The UI is P4-T03.

## Requirements

1. **Package `packages/job-discovery` (`@careeros/job-discovery`)** (PRODUCT.md §5.2). Turbo tags: `runtime:server`, `role:domain`. Ported logic must be re-implemented, not copied; JobSync is a feature reference only, and its MIT notice stays in `NOTICE`.
2. **Schema** in `packages/db/src/schema/job-discovery.ts`. All three tables are tenant tables with ENABLE and FORCE RLS, `tenant_isolation` and `owner_access`, and composite tenant foreign keys as in P1-T06:
   - `job_source` (a user's automation):
     - `id`, `organization_id`, `user_id`, `name`.
     - `titles text[]`, `skills text[]`, `keywords text[]`, `locations text[]`, `remote` (`any`, `remote`, `onsite`, `hybrid`).
     - `boards jsonb`: a list of `{ source: 'greenhouse' | 'lever' | 'lever_eu' | 'ashby', token }`, each token validated by `^[a-z0-9][a-z0-9_-]{0,99}$` (case-insensitive) in Zod and a CHECK on the array length (at most 100).
     - `schedule` (`daily`, `weekly`, `paused`).
     - `next_run_at`, `last_run_at`.
     - `ai_top_n`: integer, default 10, CHECK 0 to 50.
     - `created_at`, `updated_at`.
   - `discovery_run`:
     - `id`, `organization_id`, `job_source_id` (composite FK, CASCADE), `status` (`running`, `succeeded`, `failed`, `partial`).
     - `started_at`, `finished_at`.
     - Counts: `fetched`, `new`, `duplicate`, `scored`, `ai_matched`.
     - `errors jsonb`: per board, with no response bodies.
   - `discovered_job`:
     - `id`, `organization_id`, `user_id`, `job_source_id` (composite FK, SET NULL).
     - `source`, `external_id`, `board_token`.
     - `title`, `company`, `location`, `remote`, `url` (https only), `posted_at`.
     - `description_html`: sanitized.
     - `local_score`: numeric, 0 to 100. `ai_score`: nullable. `ai_summary`: nullable.
     - `status` (`new`, `accepted`, `dismissed`), default `new`.
     - `first_seen_run_id`, `created_at`, `updated_at`.
     - **Unique on (`organization_id`, `user_id`, `source`, `external_id`).** A dismissed or accepted job is never inserted again (G2).
   - Register all three in the isolation registry. Ship a `down.sql`.
3. **Fetchers** (one module per source, behind a common interface returning normalized jobs):
   - Greenhouse: `https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`.
   - Lever: `https://api.lever.co/v0/postings/{token}?mode=json`, and the `api.eu.lever.co` equivalent for `lever_eu`.
   - Ashby: the public job board API, `https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true`.
   - Check each endpoint and response shape against the provider's current public docs, and note the doc URLs in code comments. If a documented endpoint differs from the ones above, follow the docs and say so in the PR.
   - **Safety (G1):**
     - The fetch URL is built only from a fixed base per source plus the validated token, with `encodeURIComponent`. There is no user-supplied URL anywhere.
     - Redirects are followed only if the target host is on the same allow-list, and at most 2.
     - Timeout 15 s, response cap 5 MB, `content-type` must be JSON.
     - Use the existing outbound HTTP transport if the repo has one with SSRF protection (look at how the AI base-URL policy fetches); otherwise use `fetch` with `redirect: 'manual'`. Check the resolved address is not private or loopback the same way `ai/url-policy.ts` does.
   - Board-level failures are recorded in the run's `errors` (status code and short reason only) and do not fail the whole run (status `partial`).
   - Concurrency is at most 5 boards at a time per run.
4. **Normalize and sanitize (G4).** Descriptions are sanitized with `sanitize-html`, which is already a dependency, with a strict allow-list (headings, p, ul, ol, li, strong, em, a with https href and `rel="noopener nofollow"`, br). Titles and company names are plain text, trimmed and capped (300 characters). The URL must be https.
5. **Dedupe:** in-run, by (`source`, `external_id`). Against the database, insert with `ON CONFLICT DO NOTHING` on the unique key and count duplicates.
6. **Local scoring:** a pure function in the package that scores 0 to 100 from:
   - title match against `titles` (token and phrase match, case-insensitive);
   - skills and keywords found in the description;
   - location and remote fit.
     Weights are named constants with a short rationale. Include tests with fixed fixtures that pin the ordering.
7. **`runDiscovery(jobSourceId)`:** runs inside the owner's org context. It fetches every board, normalizes, dedupes, scores, inserts new rows, and records the run with its counts. It stops there; T02 adds the AI step and scheduling.
   - Performance target: 50 boards within 2 minutes with mocked fetchers that add realistic latency. Add a test that shows the timing.
8. **API** (protected, current org, own rows only):
   - `discovery.sources.list`, `discovery.sources.create`, `discovery.sources.update`, `discovery.sources.delete`.
   - `discovery.runNow(jobSourceId)`, rate limited to 1 per source per 10 minutes.
   - `discovery.jobs.list` (filter by status), `discovery.jobs.dismiss(id)`.
   - Every procedure requires the plan feature `job_discovery` through T02's `requireFeature`. If P3-T02 has not merged yet, add a temporary check against `getEntitlements(...).features.job_discovery`, marked with a TODO pointing at P3-T02.
   - Accepting into the tracker is P4-T02.
9. **Tests:**
   - Unit tests: each fetcher's normalizer against recorded fixture responses (commit small, anonymized fixtures), token validation, the sanitizer, and scoring.
   - SSRF: a token with `../`, `%2F` or `@` is rejected. A redirect to a non-allow-listed host is refused. A private address is refused.
   - Integration on an isolated database: RLS on all three tables, the unique key holds after dismissal, a re-run creates no duplicates, and run counts are correct.
   - No test hits the real job board APIs.
10. Lingui for any user-facing strings. Mark upstream edits `CAREEROS:` and list them. Add a CHANGELOG line. Log open points as questions and stop that part.

## Acceptance

- careeros-ci is fully green, and the isolation, inventory and skipped-suite guards pass.
- A dismissed job never reappears after a re-run, and no fetch can reach a host outside the allow-list. Show both in tests.
