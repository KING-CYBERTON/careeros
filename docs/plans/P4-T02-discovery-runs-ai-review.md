# P4-T02: Discovery runs on the scheduler, AI match on the top N, review queue and accept into the tracker

**Status:** Approved (Opus, 2026-11-02). **Thread:** 1 Build. **Plan:** [GTM-PLAN.md](GTM-PLAN.md), decisions G2, G3 and G4. **Depends on:** P4-T01 and P3-T03 merged (P3-T02 for `requireFeature`, if merged; otherwise keep the P4-T01 gate).
**Branch:** `feat/P4-T02-discovery-runs`. **Questions:** start at Q300.

## Goal

Discovery runs on its own on each member's schedule. The best local matches get an AI match score and a short reason, using the metered platform model. The member reviews the queue and accepts a job into their application tracker in one step.

## Requirements

1. **Scheduling** (answers P4-T01 Q224 and Q225), following the P1-T07 pattern in `packages/api/src/features/career/jobs.ts`:
   - A definer function `careeros_due_discovery_sources(now timestamptz, max_rows integer)` returning only `(id, organization_id)` for sources with `schedule` not `paused` and `next_run_at <= now`, same `search_path` and grants style as `careeros_due_career_jobs`. No row data leaves it.
   - The scheduler tick claims due sources (a lease column or `SELECT … FOR UPDATE SKIP LOCKED` inside the org context, so two server instances never run the same source), runs each with `runDiscoveryInOrg`, and sets `next_run_at` from `schedule` (daily: +24 h, weekly: +7 days, from the run start, with up to 30 minutes of jitter so sources do not all fire together). A failure in one source is logged and does not stop the others.
   - `next_run_at` is set on create and when the schedule changes; `paused` clears it.
   - Scheduled runs set a separate `last_scheduled_run_at`, so they do not block `runNow`. `runNow` keeps its 10-minute limit on manual runs only.
   - `runNow` returns as soon as the run is recorded as `running` and continues in the background on the same server (the run row shows progress). Document that a server restart marks a `running` run older than 15 minutes as `failed` (stale-run sweep in the tick).
   - Respect the existing scheduling kill switch the career feature uses (`isCareerSchedulingEnabled` or its equivalent) or add `FLAG_DISABLE_DISCOVERY_SCHEDULER` if none fits, wired through `packages/env`, `.env.example` and `turbo.json`.
   - The job is skipped for an org that is `suspended` or lacks `job_discovery` at run time.
2. **AI match** (G3, G4):
   - After local scoring, take the new jobs of this run ordered by `local_score` and send the top `min(job_source.ai_top_n, plan cap)` to the model. The plan cap comes from `getEntitlements` (add a `discovery_ai_top_n` limit to the plan data if T01 has none; log a question if that needs a schema change).
   - Reuse the existing posting-to-profile match logic if `career/matching.ts` fits; otherwise add a `discovery.match` prompt next to it. The member's profile summary and the job are passed only inside the `ai/data-block.ts` delimited data block, with a system prompt that says the job text is untrusted data and never instructions.
   - The model call goes through the T03 metered platform path with feature `discovery.match` and the fast (classification) model. If the org has no platform AI or the quota is exhausted, skip the AI step, keep the local score, and record `ai_skipped_reason` on the run. Never fall back to a member's saved key for scheduled runs.
   - Output is validated with Zod: `score` 0–100 and a `summary` of at most 280 characters, plain text. Invalid output leaves `ai_score` null.
   - The run's `ai_matched` count equals the number of model calls made; a test proves it is never more than N.
3. **Review queue API** (protected, own rows, gated by `job_discovery`):
   - `discovery.jobs.list` gains sorting (AI score, then local score, then newest) and pagination.
   - `discovery.jobs.get(id)` returns the sanitized description.
   - `discovery.jobs.accept(id)`: creates an application in the tracker through the existing applications service (same org and user, status the tracker's first stage, company, title, location, URL, the sanitized description, `source: discovery` and the board name), marks the job `accepted` and stores the new application id. Idempotent: accepting twice returns the same application. A `dismissed` job can be accepted (the member changed their mind); an `accepted` job cannot be dismissed.
   - Suspended orgs: accept is a write and is refused like the others.
4. **Guests and export** (P4-T01 Q226): add the three discovery tables to the guest account move (`careeros_move_guest_*`) and to the account export, following how the other tenant tables are handled.
5. **Tests:**
   - Unit: next-run calculation with jitter bounds, the AI output validator, the top-N selection.
   - Integration on an isolated database: the definer function returns only ids and only due sources; two concurrent ticks never run the same source; a scheduled run does not block `runNow`; AI calls ≤ N and each writes `ai_usage`; quota exhausted means no model call and the run still succeeds; accept creates exactly one application and is idempotent; a suspended org and an org without the feature are refused; guest move and export include discovery rows.
   - No test calls the real Claude API or a real job board.
6. Mark upstream edits `CAREEROS:` and list them. Add a CHANGELOG line. Log open points as questions and stop that part.

## Acceptance

- careeros-ci is fully green, and the isolation, inventory and skipped-suite guards pass.
- A scheduled run for 50 boards finishes within 2 minutes with mocked fetchers and a mocked model.
- AI calls per run never exceed N, and every one is metered.
