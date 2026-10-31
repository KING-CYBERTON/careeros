# P0-C03 — Staging environment and auto-deploy

**Status:** Approved, revision 2 (Opus, 2026-10-31: Q3 answered, Cloudflare Tunnel) · **Thread:** 3 CI/CD · **Depends on:** P0-C02, E2 (resolved: Stephen's home-lab VPS), Q3 (answered: ports 80/443 are not open → Cloudflare Tunnel), Q4 (is `ayopa.co.ke` DNS on Cloudflare?) · **Test plan:** [../../test-plans/P0-C03.md](../../test-plans/P0-C03.md)

## Goal

`https://careeros-staging.ayopa.co.ke` (STAGING_HOST, set as the `staging` environment variable; never hard-coded in files) runs the latest green `develop` image, deployed automatically, with automatic rollback.

## Deploy mechanism (Opus decision, 2026-10-31)

Staging is Stephen's home-lab VPS, which may sit behind NAT. So deploys do **not** SSH in from GitHub. Instead a **self-hosted GitHub Actions runner** runs on the VPS (as the unprivileged `deploy` user, in the `docker` group, labels `self-hosted, staging`, registered to this private repo only). It needs outbound HTTPS only. Every SSH-related item below is replaced by this: no `STAGING_SSH_*` secrets; the deploy job runs `runs-on: [self-hosted, staging]` and calls `deploy.sh` locally. Public traffic (Q3 answered by Stephen: 80/443 are not open): a **Cloudflare Tunnel**. A `cloudflared` service in the compose file runs `tunnel run` with `TUNNEL_TOKEN` from the server `.env` (a remotely-managed tunnel created in the Cloudflare dashboard by Stephen; public hostname `${STAGING_HOST}` → `http://app:3000`). Cloudflare terminates TLS. **No Caddy, no Caddyfile, no published host ports at all.**

## Files

- `infra/staging/compose.staging.yml`: services `postgres` (16, named volume, healthcheck, not published), `redis` (append-only, not published), `seaweedfs` + bucket-create job (as in upstream `compose.yml`, not published), `app` (image `ghcr.io/<owner>/<repo>:${IMAGE_TAG}`, `env_file: .env`, healthcheck on `/api/health` like upstream), `cloudflared` (`cloudflare/cloudflared` pinned by version tag, `command: tunnel --no-autoupdate run`, `TUNNEL_TOKEN` from `.env`, restart unless-stopped, on the app's network only). No service publishes host ports. Use separate internal networks like upstream.
- `infra/staging/.env.staging.example`: every variable the app needs, placeholders only, comments copied from root `.env.example` where relevant. `APP_URL=https://staging.example.com`, `TUNNEL_TOKEN=` (placeholder; comment: from Cloudflare Zero Trust → Tunnels). `FLAG_DISABLE_SIGNUPS=false` for now.
- `infra/staging/deploy.sh`: runs **on the server**. Args: image tag. Steps: `docker login ghcr.io` with a token passed via stdin; record current tag to `.previous_tag`; `IMAGE_TAG=<new> docker compose pull app && up -d`; wait up to 180 s for app health; exit non-zero if unhealthy. `set -euo pipefail`.
- `infra/staging/rollback.sh`: redeploys `.previous_tag` using the same procedure.
- `infra/staging/README.md`: one-time server setup runbook (Stephen's home-lab VPS, Ubuntu 24.04 LTS recommended: create `deploy` user, install Docker Engine + compose plugin and add `deploy` to the `docker` group, install and register the self-hosted runner as a service under `deploy`, no inbound ports opened, `/opt/careeros/staging`, copy `.env` with generated secrets, create the Cloudflare Tunnel and its public hostname (DNS CNAME is created by Cloudflare), first deploy, how to read logs, how to roll back).
- `.github/workflows/careeros-deploy-staging.yml`: triggers `workflow_run` of `careeros-image` success on `develop`, and `workflow_dispatch` with input `image_tag`. GitHub environment `staging`. `runs-on: [self-hosted, staging]`. Steps: check out the repo, sync `infra/staging/*` (except `.env*`) into `/opt/careeros/staging`, run `deploy.sh sha-<sha>` passing a short-lived GHCR read token, then from the runner `curl` `${STAGING_URL}/api/health` (expect 200 and matching SHA), then run the smoke test (below). On any failure: run `rollback.sh`, then fail the job. Concurrency: one staging deploy at a time, no cancel.
- Smoke: run upstream `tooling/deployment/smoke.mjs` with `SMOKE_URL=${STAGING_URL}` if it runs without AI settings (check its env needs; if it requires AI vars, log a question instead of guessing).

## Security

- No secrets in repo. Server `.env` is created by hand from the example (runbook). GHCR pull token is the workflow `GITHUB_TOKEN`, passed via stdin, never echoed.
- No container publishes host ports; only `cloudflared` makes outbound connections to Cloudflare.
- `TUNNEL_TOKEN` lives only in the server `.env`; treat it as a secret.
- Staging sends no real email in Phase 0 (leave email provider unset; confirm upstream tolerates that, else question).

## Acceptance criteria

- Merging a docs-only PR to `develop` results, without manual steps, in staging serving the new SHA on `/api/health` over valid HTTPS.
- Dispatching the deploy with a deliberately broken tag (e.g. a tag that doesn't exist) fails the run and leaves the previous version serving.
- Manual `rollback.sh` returns staging to the previous tag within 3 minutes.
- Smoke passes against staging.
