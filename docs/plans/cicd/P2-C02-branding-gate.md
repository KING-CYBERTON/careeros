# P2-C02: CI blocks upstream branding from coming back

**Status:** Approved (Opus, 2026-11-02). **Thread:** 3 CI/CD. **Phase plan:** [P2-PHASE-PLAN.md](../P2-PHASE-PLAN.md), decision D9. **Depends on:** T08 (merged).
**Branch:** `ci/P2-C02-branding-gate`.

## Goal

A CI check fails when a user-visible upstream product name or brand asset reappears. Internal package names and the MIT notice stay allowed. While here, add the mobile node tests to CI, because a P2-T03 regression in them went unnoticed (fixed in P2-T04).

## Requirements

1. **Script `tooling/careeros/branding-gate.mjs`.** A Node script with no dependencies. It exits non-zero and prints `file:line: match` for each finding.
   - **Patterns, case-insensitive:**
     - `Reactive Resume`, `ReactiveResume`;
     - `rxresu.me` and `rxresume`;
     - the upstream author's donation, sponsor and social links that T08 removed. Take the exact list from T08's review and diff (`docs/reviews/P2-T08-review-1.md`, PR #47).
   - **Scanned paths:**
     - `apps/web/src`, `apps/web/index.html`, `apps/web/public` (text files only), `apps/web/locales/*.po` (`msgstr` lines for every locale, and `msgid` lines);
     - `apps/mobile/app`, `apps/mobile/src`, `apps/mobile/locales` (if present), and `apps/mobile/app.config.ts` user-visible fields;
     - `apps/server/src/static`;
     - `packages/email/src`, `packages/pdf/src` (metadata strings), `packages/ui/src`.
   - **Never matched:**
     - import specifiers and package names: `@reactive-resume/` and `reactive-resume/` path segments;
     - `NOTICE`, `LICENSE*`, `CHANGELOG*.md`, `docs/**`, `.agents/**`, test files (`*.test.*`, `*.spec.*`, `tests/**`) and `node_modules`;
     - the licenses page source (T08), which must keep the MIT attribution. Allow it by path, and assert that it still contains the attribution text, so the allowance cannot hide a removal.
   - **Inline escape hatch:** a line comment `careeros-branding-allow: <reason>` on the same line or the line before. The reason must be at least 10 characters. The script prints a count of allowances used.
2. **Self-test:** `tooling/careeros/branding-gate.test.mjs` (node:test), with fixtures in a temp dir:
   - a forbidden string in a `.tsx` file is caught;
   - an `@reactive-resume/ui` import passes;
   - a `.po` `msgstr` is caught;
   - the allow comment without a reason fails;
   - the licenses page without the attribution fails.
3. **CI wiring** (`.github/workflows/careeros-ci.yml`, the `static` job):
   - add a step that runs `node tooling/careeros/branding-gate.mjs`;
   - add a step that runs `node --test tooling/careeros/*.test.mjs apps/mobile/scripts/*.test.mjs`;
   - keep the job's existing caching and timeouts. The current develop must pass. If the gate finds real leftovers, list them in the PR and either fix them (if they are trivial string swaps to the brand helper already used by T08) or log them as a question.
4. **Docs:** add a short "Branding gate" section to `docs/CODING-STANDARDS.md` covering what is blocked, how to allow, and why.

## Acceptance

`static` runs both new steps and is green on the PR. The self-test covers the cases above. Lint and format are clean.

## Out of scope

Image or asset fingerprinting of upstream logos (Phase 3, if needed).
