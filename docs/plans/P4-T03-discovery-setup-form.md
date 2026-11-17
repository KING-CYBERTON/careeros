# P4-T03: Discovery setup form (web and mobile)

**Status:** Approved (Opus, 2026-11-08). **Thread:** 1 Build. **Plan:** GTM-PLAN.md; P4-T02 Q300. **Depends on:** P4-T02 merged (#91).
**Branch:** `feat/P4-T03-discovery-setup-form`. **Questions:** start at Q380.

## Goal

A member creates, edits, pauses, runs and deletes a job search (an "automation", `job_source`) from the app, on web and mobile, without using the API. This finishes feature 18.

## Requirements

1. **Where:** web at Career, Jobs (`/dashboard/career/jobs`), and mobile at Career, Jobs. Add a "Searches" section above the review queue: a list of the member's searches with name, schedule, next run, last run status and a count of new jobs. The empty state explains what a search does and has a "New search" button.
2. **Form** (create and edit share one form). It uses the existing `discovery.sources.create` and `discovery.sources.update` procedures only. No new server procedure unless a field below cannot be saved; if so, log a question.
   - Name (required, at most 120 characters).
   - Job titles, skills, keywords and locations as chip inputs, each at most 50 entries of at most 100 characters, with case-insensitive duplicates removed, matching `sourceFields` in packages/api/src/features/discovery/schemas.ts.
   - Remote preference: any, remote, onsite or hybrid.
   - Boards: a list of rows, each a source (Greenhouse, Lever, Lever EU or Ashby) plus a company board token, with a short help text on where the token is found in a board's URL. A pasted board URL from one of the four hosts fills the source and token in on the client. Any other URL shows "This board isn't supported yet".
   - Schedule: daily, weekly or paused.
   - AI matching: the number of top jobs to score, from 0 to the plan cap. Show it only when the org has the `platform_ai` feature. Explain that each scored job uses AI credits.
   - Client validation mirrors the server Zod schema. Server errors map to readable field messages. A failed save keeps the form.
3. **Actions on each search:** Run now (calls `runNow` and shows "Running" until `runs.list` shows the run finished; poll at most every 5 seconds for at most 3 minutes), Pause or Resume, Edit, and Delete with a confirmation.
4. **Plan gate:** if the org lacks the `job_discovery` feature, show the section read-only with a short note that the plan does not include job discovery, and hide create and run. The server already refuses; this is only the UI.
5. **Limits:** if the server refuses a create because the member has reached the search limit, show the limit message.
6. **Parity:** web and mobile ship the same features in this task. Share validation through a workspace package export (for example `@careeros/job-discovery` or the API schema export), not by copying it.
7. Use Lingui strings and run `lingui:extract` for web and mobile. Update the user guide mapped in `docs/contributing/career-platform.mdx` with fictional screenshots. Mark upstream edits `CAREEROS:` and list them in docs/UPSTREAM_PATCHES.md. Add a CHANGELOG line.

## Tests

- **Unit:** the board URL parser (each host, URLs with paths and queries, unsupported hosts, junk input), and the form validation against the server schema limits.
- **Web component tests:** create, edit, pause, delete confirmation, the plan-gated read-only state, and the AI field hidden without `platform_ai`.
- **Mobile:** component tests for the same states, using the existing mobile test setup.
- **E2E:** create a search with one board in the web app, against a local fixture board server or the existing mocked fetcher setup (no real job board), run it, and see jobs in the review queue.
- No test calls the real Claude API or a real job board.

## Acceptance

- careeros-ci is fully green, including the isolation, inventory and skipped-suite guards.
- A member sets up and runs a search entirely from the UI on web and on mobile.
