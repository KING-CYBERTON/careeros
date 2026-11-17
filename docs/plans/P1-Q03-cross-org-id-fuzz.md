# P1-Q03: Cross-org ID fuzz (e2e and API)

**Status:** Approved (Opus, 2026-11-01). **Thread:** 2 QA. **Phase plan:** P1-PHASE-PLAN.md.
**Depends on:** T04 to T09 merged. Dispatch after T08 lands.
**Branch:** `test/P1-Q03-cross-org-id-fuzz`

## Goal

Prove, against the real built app as `careeros_app`, that an id from Org A, presented in an Org B session, never returns Org A's data or changes it, on every route group.

## Requirements

1. **Fixture** `tests/e2e/fixtures/two-orgs.ts`:
   - Creates user A in Org A and user B in Org B through the real signup and organization flows. Reuse the T03 helpers in `careeros-org.ts`.
   - Seeds one of each resource in Org A through the public API, not raw SQL: resume, resume share and statistics, cover letter and version, application, lane, pipeline and profile entries, career profile, fact, story, schedule, opportunity, answer and workspace, agent thread and message, AI provider, custom domain, and web access credential.
   - Returns their ids. Clean up in teardown.
2. **Route inventory.**
   - Generate the list of procedures from the oRPC router and the OpenAPI spec (`pnpm docs:gen` output or the router object). Do not hand-maintain a list that can drift.
   - Every procedure that takes an id (any input field named `id`, `*Id` or `*Ids`) must be exercised.
   - If a procedure is left out, the test fails with its name, unless it is in an explicit, commented skip list. The only valid reason for a skip is "takes no tenant id".
3. **Spec** `tests/e2e/specs/cross-org-id-fuzz.spec.ts`. For each procedure, call it as user B with Org A's ids (read, update, delete, link-to, and bulk variants), through the HTTP API with B's session cookie. Also call it with B's API key, through the OpenAPI routes where they exist. Then assert:
   - The status is 404 or NOT_FOUND, or an empty list or zero count for list and bulk calls. A 400 is acceptable only where the T06 review allowed it (lane reorder and create).
   - Never a 200 carrying any of Org A's field values. Scan the response body for A's seeded names and ids.
   - Never a 403 carrying data.
   - After the whole run, as user A, every Org A resource is unchanged: compare a snapshot taken before the run with one taken after.
4. **Public routes.** Org A's public resume and custom-domain pages still work without a session. An Org B session cannot list them through any authenticated route.
5. **MCP.** Run the MCP tools that take ids with B's token and A's ids, with the same assertions.
6. **Runtime.** Keep the spec under 3 minutes in CI with 1 worker. Batch the calls where possible. If it would run longer, split it into two spec files.
7. Any failure found is a release blocker. Log it in docs/questions.md and stop; do not weaken the assertion.

## Acceptance

- careeros-ci e2e is green with the new spec.
- The inventory check proves full coverage of every id-taking procedure.
