# P0-C03 — Staging environment and auto-deploy

**Status:** Approved (Opus, 2026-10-31) · **Thread:** 3 CI/CD · **Depends on:** P0-C02, E2 (resolved: Stephen's home-lab VPS), Q3 (inbound 80/443 vs Cloudflare Tunnel) · **Test plan:** [../../test-plans/P0-C03.md](../../test-plans/P0-C03.md)

## Goal
`https://careeros-staging.ayopa.co.ke` (STAGING_HOST, set as the `staging` environment variable; never hard-coded in files) runs the latest green `develop` image, deployed automatically, with automatic rollback.

## Deploy mechanism (Opus decision, 2026-10-31)
Staging is Stephen's home-lab VPS, which may sit behind NAT. So deploys do **not** SSH in from GitHub. Instead a **self-hosted GitHub Actions runner** runs on the VPS (as the unprivileged `deploy` user, in the `docker` group, labels `self-hosted, staging`, registered to this private repo only). It needs outbound HTTPS only. Every SSH-related item below is replaced by this: no `STAGING_SSH_*` secrets; the deploy job runs `runs-on: [self-hosted, staging]` and calls `deploy.sh` locally. Public traffic: Caddy on 80/443 if Q3 says those ports reach the VPS; otherwise a Cloudflare Tunnel (`cloudflared` service in the compose file, token from the server `.env`) and no Caddy.

## Files
- `infra/staging/compose.staging.yml`: services `postgres` (16, named volume, healthcheck, not published), `redis` (append-only, not published), `seaweedfs` + bucket-create job (as in upstream `compose.yml`, not published), `app` (image `ghcr.io/<owner>/<repo>:${IMAGE_TAG}`, `env_file: .env`, healthcheck on `/api/health` like upstream), `caddy` (ports 80/443, automatic HTTPS for `${STAGING_HOST}`, reverse proxy to `app:3000`, volumes for data/config). Use separate internal networks like upstream.
- `infra/staging/Caddyfile`: one site block for `{$STAGING_HOST}`, `reverse_proxy app:3000`, HSTS header, gzip/zstd.
- `infra/staging/.env.staging.example`: every variable the app needs, placeholders only, comments copied from root `.env.example` where relevant. `APP_URL=https://staging.example.com`. `FLAG_DISABLE_SIGNUPS=false` for now.
- `infra/staging/deploy.sh`: runs **on the server**. Args: image tag. Steps: `docker login ghcr.io` with a token passed via stdin; record current tag to `.previous_tag`; `IMAGE_TAG=<new> docker compose pull app && up -d`; wait up to 180 s for app health; exit non-zero if unhealthy. `set -euo pipefail`.
- `infra/staging/rollback.sh`: redeploys `.previous_tag` using the same procedure.
- `infra/staging/README.md`: one-time server setup runbook (Stephen's home-lab VPS, Ubuntu 24.04 LTS recommended: create `deploy` user, install Docker Engine + compose plugin and add `deploy` to the `docker` group, install and register the self-hosted runner as a service under `deploy`, open 80/443 only if Q3 says so, `/opt/careeros/staging`, copy `.env` with generated secrets, DNS A record for staging host, first deploy, how to read logs, how to roll back).
- `.github/workflows/careeros-deploy-staging.yml`: triggers `workflow_run` of `careeros-image` success on `develop`, and `workflow_dispatch` with input `image_tag`. GitHub environment `staging`. `runs-on: [self-hosted, staging]`. Steps: check out the repo, sync `infra/staging/*` (except `.env*`) into `/opt/careeros/staging`, run `deploy.sh sha-<sha>` passing a short-lived GHCR read token, then from the runner `curl` `${STAGING_URL}/api/health` (expect 200 and matching SHA), then run the smoke test (below). On any failure: run `rollback.sh`, then fail the job. Concurrency: one staging deploy at a time, no cancel.
- Smoke: run upstream `tooling/deployment/smoke.mjs` with `SMOKE_URL=${STAGING_URL}` if it runs without AI settings (check its env needs; if it requires AI vars, log a question instead of guessing).

## Security
- No secrets in repo. Server `.env` is created by hand from the example (runbook). GHCR pull token is the workflow `GITHUB_TOKEN`, passed via stdin, never echoed.
- Postgres, Redis, SeaweedFS not exposed on host ports.
- Staging sends no real email in Phase 0 (leave email provider unset; confirm upstream tolerates that, else question).

## Acceptance criteria
- Merging a docs-only PR to `develop` results, without manual steps, in staging serving the new SHA on `/api/health` over valid HTTPS.
- Dispatching the deploy with a deliberately broken tag (e.g. a tag that doesn't exist) fails the run and leaves the previous version serving.
- Manual `rollback.sh` returns staging to the previous tag within 3 minutes.
- Smoke passes against staging.
