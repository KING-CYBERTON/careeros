# Phase 0 — CI/CD and Infrastructure Plan

**Status:** Approved (Opus, 2026-10-31) · **Thread:** 3 CI/CD

## Pipeline overview

```
feature/* ──PR──► develop ──(green CI)──► image :develop + :sha-<sha> ──► deploy staging ──► smoke
                     │
                     └──release PR (Opus)──► main ──tag v0.x.y / v1.0.0-rc.N──► image :<version> ──► (Phase 6) production
```

| Workflow file (new)                             | Trigger                                                                                       | Jobs                                                                                                                   | Task |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---- |
| `.github/workflows/careeros-ci.yml`             | PR to `develop`/`main`, push to `develop`/`main`                                              | static (lint, format, boundaries, typecheck), unit (Postgres service, migrations, `test:ci`), e2e (build + Playwright) | C01  |
| `.github/workflows/careeros-image.yml`          | `workflow_run` of careeros-ci success on push to `develop`; push of tag `v*`                  | build amd64 image from upstream `Dockerfile`, push to GHCR                                                             | C02  |
| `.github/workflows/careeros-deploy-staging.yml` | `workflow_run` of careeros-image success on `develop`; manual dispatch with `image_tag` input | deploy on the self-hosted staging runner (home-lab VPS), health check, smoke, auto-rollback                            | C03  |
| `.github/dependabot.yml`                        | weekly                                                                                        | npm + github-actions + docker updates to `develop`                                                                     | C04  |

Upstream workflows (`ci.yml`, `docker-publish.yml`, `autofix.yml`, `issue-maintenance.yml`, `mobile-*.yml`) stay as files and are **disabled** in Actions settings (D4). Recorded in `docs/UPSTREAM_PATCHES.md` as a settings change.

## Environments and secrets (names only — values set by Stephen or Opus in GitHub settings, never in code)

| GitHub environment          | Secret / variable                                                                                       | Purpose                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `staging`                   | self-hosted runner labelled `staging` on Stephen's home-lab VPS (no SSH secrets)                        | Deploy                                                        |
| `staging`                   | var `STAGING_URL`                                                                                       | Health check and smoke                                        |
| (server-side `.env` on VPS) | `AUTH_SECRET`, `ENCRYPTION_SECRET`, `DATABASE_URL`, `POSTGRES_PASSWORD`, `S3_*`, `REDIS_URL`, `APP_URL` | App runtime; template in `infra/staging/.env.staging.example` |
| repo                        | `GITHUB_TOKEN` (built-in, `packages: write`)                                                            | GHCR push                                                     |

## Rollback principle

Every deploy records the previously running image tag on the server (`/opt/careeros/staging/.previous_tag`). If health or smoke fails, the workflow redeploys the previous tag and fails the run. Manual rollback = dispatch the deploy workflow with an older `sha-<sha>` tag. Database migrations are forward-only in Phase 0 (upstream migrations only); rollback of schema is out of scope until Phase 1 defines reversible migrations.
