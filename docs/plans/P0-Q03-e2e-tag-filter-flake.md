# P0-Q03 — Intermittent e2e failure in library tag-filter test

**Status:** Approved (Opus, 2026-10-31) · **Thread:** 2 QA · **Depends on:** P0-C01

## Problem

`tests/e2e/specs/library-pagination.spec.ts:201` ("bounds tag filters from chips and URLs and clears a first-load filter failure") failed at line 241 on PR #9 and PR #10 (docs-only), and passed on #5, #7, #8 and the #9 rerun. Failure: `expect(page.getByRole("alert")).toBeVisible({ timeout: 20_000 })` → element not found. The step registers `page.route("**/api/rpc/documents/**")`, fulfils 503 only when `route.request().postData()` contains `"unavailable-tag"`, then `page.goto('/dashboard?tags=["unavailable-tag"]')`. Two failures on unrelated PRs means it is not a one-off; "flake" is not a root cause.

## Task (investigation first, then the smallest fix)

1. Find the root cause. Download the failed run's Playwright trace artifact (run 41216935308, job e2e, `test-results/library-pagination-bounds--…-chromium/trace.zip`) if retained, and read the dashboard documents query code in `apps/web/src/features/` (query client retry/backoff, placeholder/previous data, how the tag filter is sent: POST body vs query string vs batched, and which element renders the error with `role="alert"`). Check at least these hypotheses and record the evidence for each:
   - (a) the documents request carrying the tag is a GET or encodes the tag so `postData()` does not contain the literal string, so the route sometimes continues to the real server;
   - (b) React Query retries the 503 with backoff and the alert appears only after all retries, sometimes beyond 20 s on 4-vCPU runners;
   - (c) a cached/previous result or a request issued before `page.route` registers is shown instead of the error;
   - (d) something else the trace shows.
2. If the cause is in the test (a, c, or timing in b), make the smallest test-side change that removes the race without weakening the assertion, e.g. match on URL + body, register the route before any navigation that can issue the request, or wait for the mocked response with `page.waitForResponse` before asserting. Do not raise timeouts blindly; a timeout change is allowed only if (b) is proven, sized from the retry schedule, with a `// CAREEROS:` comment.
3. If the cause is an app bug (the error state is genuinely not shown), do not change app code. Stop and add the evidence to `docs/questions.md` for Opus.
4. Do not skip, retry, quarantine or `test.fixme` the test. Do not change `playwright.config.ts` retries.
5. Any upstream file touched → row in `docs/UPSTREAM_PATCHES.md`.

## Evidence required in the PR

- Root-cause write-up (which hypothesis, with trace/log/code lines).
- Local or CI proof: the e2e job green on the PR, plus, if feasible, the single spec run 5 times in a row (`pnpm exec playwright test tests/e2e/specs/library-pagination.spec.ts --repeat-each=5 --workers=1`) locally or via a temporary CI step that is removed before merge.

## Acceptance

- Root cause stated with evidence; fix is test-side and minimal, or the question is logged and no code changed.
- `careeros-ci` green; spec not skipped.
