# Developer onboarding

This guide gets a new engineer, or a new Sonnet coding session, from a clean machine to a first reviewed pull request on CareerOS. It was generated from the prompt in [PROMPTS.md](PROMPTS.md#1-developer-onboarding) and checked against `develop` on 2026-11-11. When this guide and the code disagree, the code wins; please note the mismatch in your PR.

Read these first, in this order: [PRODUCT.md](../../PRODUCT.md) Section 1, [docs/STATUS.md](../STATUS.md), and [docs/CODING-STANDARDS.md](../CODING-STANDARDS.md). Then come back here.

## 1. What CareerOS is

CareerOS (working name, final name still open in PRODUCT.md §15.1) is a white-label, multi-tenant career platform. Organizations such as universities, bootcamps, agencies and coaches license it and offer it to their own job seekers under their own brand and web address. It combines a resume builder, cover letters, a job application tracker, an AI career assistant, automated job discovery and a browser job clipper.

The codebase is a fork of Reactive Resume v6 (MIT licence), taken at upstream commit `a69e483` on 2026-10-31. Upstream code keeps its `@reactive-resume/*` package names so that a monthly upstream merge stays clean (PRODUCT.md §12). CareerOS adds its own packages under the `@careeros/*` scope and keeps edits to upstream files small and marked.

## 2. Repository map

### Apps

| Path             | Origin           | What it owns                                                                                                                  |
| ---------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`       | Upstream, edited | The React 19 single-page app: dashboard, builder, settings, the Org Admin pages and the Super Admin console at `/admin`       |
| `apps/server`    | Upstream, edited | The Hono server: API, auth, MCP, static files, startup checks, webhooks                                                       |
| `apps/mobile`    | Upstream, edited | The Expo app. Web and mobile must offer the same member features (consoles and billing purchase are web-only by decision D10) |
| `apps/extension` | CareerOS         | The Job Clipper browser extension (Manifest V3, Chrome and Edge)                                                              |

### CareerOS packages

| Package                       | What it owns                                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `@careeros/tenancy`           | `withOrgContext`, `currentOrgId`, `requireOrgId`, `captureOrgScope`, and resolving a request host to an organization                           |
| `@careeros/billing`           | Plans, subscriptions, entitlements (`getEntitlements`), feature flags, the audit log, the billing state machine and providers (fake, Paystack) |
| `@careeros/ai-metering`       | The platform Claude provider, `ai_usage` rows, credits and quotas                                                                              |
| `@careeros/job-discovery`     | Board fetchers for Greenhouse, Lever and Ashby, sanitizing, scoring, scheduled runs                                                            |
| `@careeros/discovery-form`    | The job search form schema shared by web and mobile                                                                                            |
| `@careeros/job-posting`       | Shared limits and text helpers for job postings from the clipper                                                                               |
| `@careeros/email-templates`   | Built-in and organization email templates per application stage                                                                                |
| `@careeros/platform-admin`    | Super Admin console logic: organizations, plans, metrics, audit, support sessions, announcements                                               |
| `@careeros/testing`           | Test database helpers and the route inventories the fuzz suites use                                                                            |
| `@careeros/isolation-testing` | The tenant isolation registry and checks                                                                                                       |

Upstream packages that CareerOS has edited (for example `packages/auth`, `packages/api`, `packages/db`) are listed in [docs/UPSTREAM_PATCHES.md](../UPSTREAM_PATCHES.md). CareerOS scripts live in `tooling/careeros/`, and staging infrastructure in `infra/`.

## 3. Local setup

You need Node.js 24 (see `.nvmrc`), pnpm 12 (pnpm switches itself to the version in `package.json`), and Docker with Compose.

```sh
pnpm install --frozen-lockfile
test -e .env.local || cp .env.example .env.local
docker compose -f compose.dev.yml up -d postgres redis seaweedfs seaweedfs_create_bucket
```

Then edit `.env.local` for running on your machine rather than in containers:

```dotenv
APP_URL=http://localhost:3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
S3_ENDPOINT=http://localhost:8333
REDIS_URL=redis://localhost:6379
AUTH_SECRET=<output of: openssl rand -hex 32>
```

Set `ENCRYPTION_SECRET` (32 or more characters) if you will use saved AI providers or the assistant. If you only need the database, set `STORAGE_BACKEND=local` and skip SeaweedFS.

Start the app with `pnpm dev`. Vite serves the web app on port 3000, Hono runs on 3001, and the email preview on 3002. The server applies migrations at startup.

To try organization hosts locally, set `ORG_HOST_PATTERN` to a pattern with one `{slug}` that does not match `APP_URL`'s host (see the comment in `.env.example`). Leave it unset and every host behaves as the platform host.

### The CareerOS test database role

CareerOS database suites run as a non-superuser role so that row-level security is real. Create it once against your local Postgres:

```sh
pnpm --filter @careeros/testing db:test-role
```

The suites read `CAREEROS_TEST_DATABASE_URL` (owner, for setup only) and `CAREEROS_TEST_APP_DATABASE_URL` (the `careeros_app` role). Both have local defaults in `.env.example`. Never point either at a real database.

## 4. Everyday commands

| Task                                | Command                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| Run everything                      | `pnpm dev`                                                                        |
| Typecheck one package               | `pnpm --filter @careeros/billing typecheck`                                       |
| Unit tests for one package          | `pnpm --filter @careeros/tenancy test`                                            |
| One test file                       | `pnpm --filter @careeros/tenancy test src/host.test.ts`                           |
| Lint and format your changes        | `pnpm exec vp lint --fix <paths>` then `pnpm exec vp fmt <paths>`                 |
| Non-mutating checks before a PR     | `pnpm lint:agent` and `pnpm format:check`                                         |
| Package boundaries                  | `pnpm exec turbo boundaries`                                                      |
| Branding gate                       | `node tooling/careeros/branding-gate.mjs`                                         |
| New migration after a schema change | `pnpm db:generate`                                                                |
| Browser tests                       | `pnpm build` then `pnpm test:e2e` (see `tests/e2e/README.md` for the environment) |

`pnpm check` changes files. Use it only when you mean to, and review the diff afterwards.

## 5. The five rules that most often fail review

1. **Tenant scoping.** Every tenant table has `organization_id text not null`, row-level security enabled and forced, the `tenant_isolation` policy, and a composite index starting with `organization_id`. Code that reads or writes tenant rows runs inside `withOrgContext(orgId, fn)`. Work that continues after the request returns (streams, timers) uses `captureOrgScope()`. A missing org context fails closed: `careeros_app` sees zero rows.
2. **Never trust an organization id from the client.** The server resolves the organization from the request host and the session. Resource ids from another organization must answer 404, never 403 and never 200 (PRODUCT.md §6.3).
3. **Mark upstream edits.** Any change inside an upstream file carries a `CAREEROS:` comment that says why, and the file is listed in `docs/UPSTREAM_PATCHES.md` in the same PR. Prefer new code in a `@careeros/*` package and a small hook into upstream.
4. **The branding gate.** User-visible code must not show the upstream product name, its domains or its donation and community links. CI fails otherwise. Rare exceptions need a `careeros-branding-allow: <reason>` comment (CODING-STANDARDS.md §6).
5. **Database suites must run in CI.** A package whose tests read a `*_TEST_DATABASE_URL` or `CAREEROS_TEST_*` variable must list it in its `turbo.json` test task `env` arrays, or the suite silently skips. A guard (`tooling/careeros/skipped-db-suites.mjs`) fails the shard if an integration test skips (CODING-STANDARDS.md §7).

Two more that reviewers check on every PR: no secrets or personal data in code, logs or fixtures, and job postings, uploaded documents and web pages are always untrusted text in AI prompts.

## 6. Adding a tenant table, end to end

1. Confirm the spec names the table and its columns. Sonnet does not add tables a spec does not name.
2. Add the table in `packages/db/src/schema/` with `organization_id text not null` and an index whose first column is `organization_id`.
3. Run `pnpm db:generate`, then add to the migration: `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and the `tenant_isolation` policy on `current_setting('app.current_org_id', true)`. Review the generated SQL; never edit a migration after it is merged.
4. Register the table in `isolationRegistry` in `packages/isolation-testing/src/registry.ts` with a `seed` function, and an `api` block if the table has list and get endpoints. The coverage check fails CI if any table with an `organization_id` column is missing.
5. Write the feature's queries inside `withOrgContext`, take the org id from the server context, and add unit and integration tests.
6. Run `pnpm --filter @careeros/isolation-testing test:ci` and the feature package's tests.

See [packages/isolation-testing/README.md](../../packages/isolation-testing/README.md) for the registry format.

## 7. Continuous integration

The workflow is `.github/workflows/careeros-ci.yml`. It runs on pull requests and on pushes to `develop` and `main`.

| Job              | What it checks                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `changes`        | Works out what changed, so docs-only and clipper-only changes skip unrelated work                                                                    |
| `static`         | Lint, formatting, package boundaries, typecheck (mobile excluded), the branding gate, and Node tests for staging scripts, tooling and mobile scripts |
| `unit (<shard>)` | Vitest per package group against a CI Postgres with the role split, plus the skipped-suite guard                                                     |
| `extension`      | Builds and packs the Job Clipper and runs its pack checks, only when the clipper changed                                                             |
| `unit`           | Summary gate over the shards and the extension job                                                                                                   |
| `e2e`            | Playwright browser tests against a production build                                                                                                  |

Branch protection requires `static`, `unit` and `e2e`. When a job fails, open the failing step's log first; the JUnit summary on the run page lists failing tests by file. Reference numbers for test counts and durations are in [docs/BASELINE.md](../BASELINE.md).

## 8. Branches, commits and pull requests

- Branch from `develop` as `feature/<TASK-ID>-<slug>`, for example `feature/P4-T04-recommended-companies`.
- Commits follow Conventional Commits (`feat(billing): ...`, `fix: ...`, `docs: ...`); a hook enforces this.
- Pull requests target `develop`, with the task id in the title: `[P4-T04] Recommended companies for cohorts`.
- The description links the spec, lists what was built, gives test evidence (command and result), lists deviations (should be "none") and names every upstream file touched.
- Never force-push `develop` or `main`. Merges are done by Opus after a clean review and green CI.

## 9. First-week checklist

- [ ] Read PRODUCT.md §1, STATUS.md, CODING-STANDARDS.md and [How we work](how-we-work.md).
- [ ] Run the app locally and sign up; note that signup creates a personal organization.
- [ ] Create the test role and run `pnpm --filter @careeros/tenancy test` and `pnpm --filter @careeros/isolation-testing test`.
- [ ] Read the [architecture tour](architecture-tour.md), then one merged spec and its review, for example [P3-T02](../plans/P3-T02-entitlement-enforcement.md) and [its review](../reviews/P3-T02-review-1.md).
- [ ] Skim the last twenty entries of [docs/questions.md](../questions.md) to see how open points are raised and answered.
- [ ] Pick up only a spec marked **Approved** in STATUS.md, and raise anything unclear in `docs/questions.md` before you code it.
