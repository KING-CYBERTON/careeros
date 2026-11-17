# P1-Q05 Fix the pdf-text e2e route teardown race

**Thread:** 2 — QA · **Status:** Approved (Opus, 2026-11-01) · **Branch:** `fix/P1-Q05-pdf-text-route`

## Problem

`tests/e2e/specs/pdf-text.spec.ts` (an upstream file) proxies `fonts.gstatic.com` through `page.route` with `route.fetch()`. When the test ends while a font fetch is still in flight, Playwright disposes the request context and `route.fetch()` rejects with "Request context disposed". The rejection, plus the `expect` inside the handler, surfaces as a failure after the test body passed (CI run 41240846813).

## Change

1. Make the route handler teardown-safe. Wrap `route.fetch()` and `route.fulfill()` in try/catch. If the error is a disposed or closed context, return quietly. Otherwise call `route.abort()` and record the failure so the test can assert on it from the test body, not from inside the handler. Do not call `expect` inside the handler.
2. At the end of the test body, call `await page.unrouteAll({ behavior: "ignoreErrors" })` so in-flight handlers cannot fail after the test.
3. Mark the edits with `// CAREEROS:` comments and add a row to `docs/UPSTREAM_PATCHES.md` under P1-Q05.
4. Do not change what the test checks: the downloaded PDF text, the "can't display" notice and the server export must stay.

## Acceptance

- `pdf-text.spec.ts` passes in CI on the PR.
- No assertion is removed or weakened.
- Lint and format checks are clean on the changed files.
