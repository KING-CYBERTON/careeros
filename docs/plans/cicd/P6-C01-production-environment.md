# P6-C01: Production environment, release promotion and deploy on tag

**Status:** Approved (2026-11-16). Stephen decided G8 and the domain on 2026-11-16: a cloud VPS separate from staging (Ubuntu 24.04.5, 4 vCPU, 8 GB, 96 GB disk, prepared by hand, see "Server state" below) and the domain `itscareeros.com`. **Thread:** 3 CI/CD. **Origin:** [GTM-PLAN.md](../GTM-PLAN.md) G8, [launch plan](../launch/LAUNCH-PLAN.md) M2. **Branch:** `ci/P6-C01-production`. **Questions:** start at Q600.
**Generated from:** [launch PROMPTS.md](../launch/PROMPTS.md) prompt 4.

## Goal

CareerOS runs in production on its own server or stack, with its own database, storage, secrets, tunnel and domain. A release reaches production only from a `v*` tag on `main`, after a person approves it, with migrations before traffic and an automatic rollback when the health check fails. The staging scripts are reused so production and staging deploy the same way.

## Requirements

1. **Separate stack.** Add `infra/production/` with `compose.production.yml`, `.env.production.example`, `deploy.sh`, `rollback.sh`, `mark-good.sh` and `README.md`. Reuse the staging scripts: either move the shared logic into `infra/shared/` and call it from both, or copy them with only the project name, paths and compose file changed. No volume, network, database, bucket, tunnel or secret is shared with staging. The compose project name is `careeros_production`; the stack lives in `/opt/careeros/production`.
2. **Database.** Postgres 16 with the P1-C01 role split: migrations as `careeros_owner`, serving as `careeros_app` without BYPASSRLS, set by `infra/db/bootstrap-roles.sh` on every deploy. `STRICT_SCHEMA_CHECK=true`.
3. **Storage.** SeaweedFS in the stack, as on staging. The disk is 96 GB, so the README documents how to switch to an external bucket (`STORAGE_BACKEND=s3`) later without a code change. Backups go to a different provider (P6-C02).
4. **Ingress.** A Cloudflare Tunnel, as on staging. The server's firewall allows only SSH inbound; the compose file publishes no ports.
5. **Domains.** The platform host is `itscareeros.com` (the apex, which also serves the marketing home page); `www.itscareeros.com` redirects to it. Org hosts use the pattern `{slug}.itscareeros.com` with a wildcard DNS record through the tunnel. Host names stay in GitHub `production` environment variables and the server `.env`, never in a workflow or compose file. Custom domains use Cloudflare for SaaS with a fallback origin on the production domain, set up by a production copy of `careeros-staging-cloudflare.yml` (or that workflow taking an environment input). The P2-C05 org DNS sync runs for production too.
6. **Release promotion.** Document in `infra/production/README.md` and `docs/RELEASING.md`: Opus opens a PR from `develop` to `main` for the candidate commit; after CI passes and Opus merges it, the annotated tag `vX.Y.Z` (or `vX.Y.Z-rc.N`) is set on that `main` commit. Pre-release tags go to staging first.
7. **Deploy workflow.** Add `careeros-deploy-production.yml`:
   - Trigger: `workflow_run` of `careeros-image` for a `v*` tag, plus `workflow_dispatch` with inputs `tag` and `action` (`deploy` or `rollback`).
   - It refuses a tag whose commit is not reachable from `main`.
   - It uses the GitHub `production` environment, which has a required reviewer (Stephen) and holds every production secret. Runs on a self-hosted runner labelled `production` on the production server, never the staging runner.
   - Steps: copy the infra files, `deploy.sh <version>`, check `/api/health` reports the tag's commit, run the smoke test (the staging smoke script pointed at production with a dedicated smoke account), then `mark-good.sh`. On any failure, `rollback.sh --last-good` and fail the run.
   - Timeout 60 minutes, concurrency group `production` with no cancel in progress.
8. **Safety switches.** The deploy fails before starting if `.env` sets `PAYSTACK_ALLOW_TEST_KEY=true`, any `FLAG_ALLOW_UNSAFE_*` to true, `FLAG_DISABLE_API_RATE_LIMIT=true`, or a Paystack key starting `sk_test_`. Add these checks to a `preflight.sh` with a `node:test` self-test under `tooling/careeros/`.
9. **Migrations and rollback.** Document the rule for every release from now on: a migration must not break the previous release's code (expand, then contract in a later release), so `rollback.sh` is always safe. A release that cannot meet it says so in its PR and the runbook uses a restore instead.
10. **Production `.env` template.** `.env.production.example` lists names only, in groups: core (`APP_URL`, `AUTH_SECRET`, `ENCRYPTION_SECRET`), database (`DATABASE_URL` for the app role, `DATABASE_MIGRATION_URL` for the owner role), storage, Redis, email (Plunk), billing (Paystack live), AI (platform provider key and model ids), org hosts and Cloudflare for SaaS, tunnel token, `IMAGE_REPOSITORY`. Every value is a placeholder.
11. **Docs.** `infra/production/README.md` covers one-time setup (server, `deploy` user, Docker, runner, tunnel, `.env`, DNS, Cloudflare for SaaS), everyday deploys, rollback and the security notes, in the style of `infra/staging/README.md`. A line in `CHANGELOG-CAREEROS.md`.

## Server state (done by Stephen, 2026-11-16)

Recorded step by step in the production setup log. The workflow and README must fit this state and must not redo it:

- Ubuntu 24.04.5 LTS, updated and rebooted; 4 GB swap file.
- Docker with Compose v5.7.1; user `deploy` (no password, no sudo) in the `docker` group.
- `/opt/careeros/production` exists, owned by `deploy`, mode 0750.
- `ufw` active: incoming denied except 22/tcp.

## Out of scope

- Backups, restore drill, uptime and error alerts: P6-C02.
- Load test and launch security review: P6-Q01 and P6-Q02.
- Native mobile builds.

## Acceptance

- A throwaway tag `v0.9.0-rc.1` on a `main` commit deploys to production after approval, and `/api/health` reports its commit.
- A deploy of a deliberately broken image rolls back to the last good tag automatically.
- `rollback` from `workflow_dispatch` redeploys the previous tag.
- A tag not on `main` is refused. A `.env` with a test Paystack key is refused by preflight.
- The production platform host, one org host and one custom domain serve over HTTPS.
- Nothing from staging (volumes, secrets, tunnel, runner) is used by production.
- CI green; lint and format clean; every upstream file edit marked `CAREEROS:` and listed in `docs/UPSTREAM_PATCHES.md`.
