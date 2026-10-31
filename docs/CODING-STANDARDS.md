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

- Every tenant table: `organization_id uuid not null`, RLS enabled with the `tenant_isolation` policy, composite index starting with `organization_id`, registered in the isolation registry (P0-Q02).
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
