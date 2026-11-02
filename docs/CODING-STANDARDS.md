# CareerOS Coding Standards

Status: **Approved** (Opus, 2026-10-31). Applies to all code Sonnet writes. PRODUCT.md §1 always wins over this file.

## 1. Where code goes

- New CareerOS logic lives in new workspace packages under `packages/<name>` with the npm scope **`@careeros/`** (e.g. `@careeros/tenancy`). New apps go under `apps/<name>`.
- Upstream packages keep their `@reactive-resume/*` names. Do not rename upstream packages, folders or the root `package.json` name (keeps monthly upstream merges clean).
- Edits to upstream files are minimal, wrapped or marked with a `CAREEROS:` comment that explains why (`// CAREEROS: <reason>`; `<!-- CAREEROS: ... -->` in Markdown/HTML; `# CAREEROS:` in YAML/shell), and every touched upstream file is listed in `docs/UPSTREAM_PATCHES.md` in the same PR.
- Prefer extension points (middleware, plugin registration, route mounting) over editing upstream function bodies.

## 2. Language and tooling (follow upstream; do not introduce alternatives)

- TypeScript strict, ESM. Node 24, pnpm 12 (versions from root `package.json` / `.nvmrc`).
- Lint/format: Vite+ (`pnpm lint`, `pnpm format:check`). Typecheck: `pnpm typecheck`. Package boundaries: `pnpm exec turbo boundaries`.
- Tests: Vitest through `vite-plus/test` (same import style as upstream); e2e: Playwright in `tests/e2e/specs`. CareerOS-only e2e specs are prefixed `careeros-`.
- Validation: zod on every API input. API: oRPC/OpenAPI the way upstream does it. DB: Drizzle; migrations generated with `pnpm db:generate`, never hand-edited after merge.
- New dependencies only when a spec names them. Use `catalog:` when the version is already in `pnpm-workspace.yaml`.

## 3. Tenancy and security (from Phase 1 on)

- Every tenant table: `organization_id text not null` (text ids, matching upstream and Better Auth; see plans/P0-UPSTREAM-INVENTORY.md F1), RLS enabled with the `tenant_isolation` policy, composite index starting with `organization_id`, registered in the isolation registry (P0-Q02).
- Never trust an organization id from the client; resolve it server-side.
- No secrets, tokens or PII in code, logs, test fixtures or chat. New env vars go into `.env.example` with a placeholder and a comment, and into the CI/CD plan.
- Job postings, uploaded documents and web content are untrusted input in AI prompts.

## 4. Git and PRs

- Branches: `feature/<TASK-ID>-<slug>` from `develop`. PRs target `develop`. `main` only receives release merges from `develop` (Opus).
- Commits: Conventional Commits (upstream enforces with commitlint), e.g. `feat(tenancy): ...`, `ci: ...`, `docs: ...`. Reference the task ID in the PR title: `[P0-C01] Add CareerOS CI workflow`.
- PR description: spec link, what was implemented, test evidence (command + result), deviations (should be "none"), upstream files touched.
- Never force-push `develop` or `main`. Never rewrite upstream history.

## 5. Docs

- Opus owns `docs/STATUS.md`, `docs/plans/**`, `docs/test-plans/**`, `docs/reviews/**`, `docs/ESCALATIONS.md`, `docs/RELEASE-1.0.0.md`.
- Sonnet may append questions to `docs/questions.md` and update `docs/UPSTREAM_PATCHES.md`, `README`/runbooks named in a spec, and `CHANGELOG-CAREEROS.md`.

## 6. Branding gate

CI (`static` job) runs `node tooling/careeros/branding-gate.mjs`. It fails when an upstream product name or brand link appears in user-visible code.

- **Blocked** (case-insensitive): `Reactive Resume`, `ReactiveResume`, `rxresu.me`, `rxresume`, `rx.cv`, OlaCV, the upstream author's name and email, and the upstream GitHub, GitHub Sponsors, Discord, Open Collective, Crowdin, Context7, LinkedIn and subreddit links.
- **Scanned:** web `src`, `index.html`, `public` and `locales/*.po`; mobile `app`, `src`, `locales` and `app.config.ts`; `apps/server/src/static`; `packages/email/src`, `packages/pdf/src`, `packages/ui/src`.
- **Never matched:** `@reactive-resume/` import specifiers, test files, `docs/**`, `NOTICE`, `LICENSE*`, `CHANGELOG*.md`, and lines that are only a code comment. The licenses pages are allowed by path; the gate checks that `packages/utils/src/notice.ts` still holds the MIT attribution and that both pages still render it.
- **Allow:** add a comment `careeros-branding-allow: <reason>` on the same line or the line before, with a reason of at least 10 characters (identifiers, importer names, and native names that wait for the mobile release blocker). The gate prints how many allowances it used.
- **Why:** the MIT licence requires the notice, not the upstream brand. A white-label product must not show the upstream name, donation prompts or links to customers.

## 7. Database suites must run in CI

- Turborepo strict env mode hides every variable a task does not list. A package whose tests read a `*_TEST_DATABASE_URL` (or any `CAREEROS_TEST_*` variable) must list it in the `env` arrays of its `turbo.json` for `test`, `test:ci` and `test:coverage`, or the suite skips without failing.
- `tooling/careeros/skipped-db-suites.mjs` runs in every unit shard after the tests. It reads the JUnit reports under each package's `reports/` and fails if any test in a `*.integration.test.ts` file, or in a file on the script's `EXTRA_GUARDED` list (database-backed tests with another name), is skipped, or if a package with such files wrote no JUnit report in that shard. A new database-backed test that is not named `*.integration.test.ts` must be added to `EXTRA_GUARDED`.
- A suite may skip in CI only if its file is in the script's `ALLOWLIST` with a reason of at least 10 characters, and a question in `docs/questions.md` explains why. The list starts empty.
