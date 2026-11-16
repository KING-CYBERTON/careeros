# Production environment runbook (P6-C01)

Production runs a released CareerOS version on its own server, separate from staging: its own database, storage, Redis, secrets, tunnel and GitHub runner. Nothing is shared with staging. A release reaches production only from a `v*` tag on `main`, deployed by a person from GitHub Actions, with migrations before traffic and an automatic rollback when a check fails.

How it fits together:

```
develop -> PR to main -> merge -> tag vX.Y.Z on main -> careeros-image (GHCR: ghcr.io/<repo>:X.Y.Z)
                                                              |
                     Actions -> careeros-deploy-production -> Run workflow (action=deploy, tag=vX.Y.Z)
                                                              |  (job runs on the runner on the production server)
                                                              v
          visitors -> Cloudflare (HTTPS) -> tunnel -> cloudflared container -> app container (port 3000, internal only)
```

In this document `itscareeros.com` is the platform host and `{slug}.itscareeros.com` the organization hosts. The real values live in the GitHub `production` environment variables (`PRODUCTION_HOST`, `PRODUCTION_URL`) and the server `.env`; they are not written into any workflow or compose file.

Never paste secrets (tunnel token, `.env` contents, GitHub tokens, Paystack or Plunk keys) into chat, issues, pull requests or git.

This first version covers manual deploys and rollbacks. Still to come in a follow-up PR: the deploy that starts by itself on a new tag (after a required reviewer is set on the `production` environment), the full smoke test with a dedicated smoke account, and the production Cloudflare for SaaS setup for custom domains.

## One-time setup

Steps 1 to 5 are done on the current server (2026-11-16). They are kept here so the server can be rebuilt.

### 1. Server, `deploy` user and Docker

Ubuntu 24.04 LTS, updated, with a swap file. Docker Engine with the Compose plugin. A user `deploy` with no password and no sudo, in the `docker` group. The stack folder:

```sh
sudo install -d -o deploy -g deploy -m 0750 /opt/careeros/production
```

Firewall: `ufw` denies all incoming traffic except `22/tcp`. Do not open 80 or 443; traffic comes in through the tunnel.

### 2. Self-hosted runner

Registered from **Settings -> Actions -> Runners -> New self-hosted runner** as user `deploy`, with the name `careeros-production` and the extra label `production` (labels: `self-hosted`, `Linux`, `X64`, `production`), installed as a service with `sudo ./svc.sh install deploy`. The deploy workflow runs only on `[self-hosted, production]`; the staging runner has the `staging` label and never picks up a production job.

### 3. Cloudflare Tunnel

A tunnel for production only (not the staging tunnel), with its token in `.env` as `TUNNEL_TOKEN`. Public hostnames, all pointing at service **HTTP** `app:3000`:

- `itscareeros.com` (the platform and the marketing home page)
- `www.itscareeros.com` (redirected to the apex, see "Domains" below)
- `*.itscareeros.com` (organization hosts; a wildcard CNAME to the tunnel)

Turn on **SSL/TLS -> Edge Certificates -> Always Use HTTPS** for the zone. Universal SSL covers the apex and first-level subdomains, which is why organization hosts are `{slug}.itscareeros.com` and never two levels deep.

### 4. Server `.env`

`/opt/careeros/production/.env`, owned by `deploy`, `chmod 600`, made from [`.env.production.example`](.env.production.example) with fresh values (never a staging value). The workflow copies the template next to it on every deploy but **never writes `.env`**. Points to check:

- `APP_URL` is `https://itscareeros.com`, `ORG_HOST_PATTERN` is `{slug}.itscareeros.com`.
- `DATABASE_URL` uses `careeros_app`, `DATABASE_MIGRATION_URL` uses `careeros_owner` (see "Database" below).
- `STRICT_SCHEMA_CHECK="true"`.
- Paystack live keys only (`sk_live_`, `pk_live_`), or `BILLING_PROVIDER="none"` until the live account is ready.
- None of `PAYSTACK_ALLOW_TEST_KEY`, `FLAG_ALLOW_UNSAFE_*`, `FLAG_ALLOW_FAKE_BILLING` or `FLAG_DISABLE_API_RATE_LIMIT` is true.

`preflight.sh` checks the last three points before every deploy and refuses to start if one fails. Run it by hand after editing `.env`:

```sh
cd /opt/careeros/production && ./preflight.sh
```

It prints only setting names, never values. Before the first deploy the script is not on the server yet; copy it from the repository or let the first run copy it (the run checks `.env` before it changes anything).

### 5. GitHub `production` environment

**Settings -> Environments -> production**, with these variables:

| Variable                    | Value                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `PRODUCTION_HOST`           | `itscareeros.com`                                                                        |
| `PRODUCTION_URL`            | `https://itscareeros.com`                                                                |
| `PRODUCTION_ORG_SMOKE_HOST` | optional: an organization host to check after deploy, for example `demo.itscareeros.com` |

No secrets are needed: the workflow pulls the image from GHCR with its own short-lived `GITHUB_TOKEN` (the repository is private, so a login is required and the workflow does it). Add Stephen as a **required reviewer** before the automatic deploy on tag is switched on in the follow-up PR.

### 6. First deploy

1. Make the release (see "Releasing" below): merge `develop` into `main` through a PR, then tag the merge commit on `main`, for example `v0.9.0-rc.1`, and push the tag. Wait for the `careeros-image` run for that tag to finish green.
2. In GitHub open **Actions -> careeros-deploy-production -> Run workflow**. Choose `action` = `deploy` and enter `tag` = `v0.9.0-rc.1`.
3. The first start creates the volumes and pulls the image; it can take several minutes. When the run is green, `https://itscareeros.com/api/health` reports `"status":"healthy"` and the tag's commit in `revision`.

## Releasing

Every production release follows the same path:

1. Opus opens a PR from `develop` to `main` for the candidate commit. CI must pass.
2. After the merge, set an annotated tag on that `main` commit and push it:

   ```sh
   git fetch origin main
   git tag -a v1.0.0 -m "CareerOS 1.0.0" origin/main
   git push origin v1.0.0
   ```

   Pre-release tags (`v1.0.0-rc.1`) are tried on staging first.

3. The tag push runs `careeros-image`, which publishes `ghcr.io/king-cyberton/careeros:1.0.0` and `:sha-<commit>`.
4. Run **careeros-deploy-production** with `action` = `deploy` and `tag` = `v1.0.0`.

The workflow refuses a tag whose commit is not on `main`.

### What the deploy run does

1. Checks the inputs and that `/opt/careeros/production/.env` exists.
2. Checks out the tag and refuses it if its commit is not on `main`.
3. Copies `compose.production.yml`, `bootstrap-roles.sql`, the `.env` template and the scripts into `/opt/careeros/production` (never `.env`).
4. Runs `preflight.sh`. If it refuses, nothing has changed and nothing is rolled back.
5. Runs `deploy.sh X.Y.Z`: GHCR login, pull, `docker compose up -d`. `db_bootstrap` sets the database roles, then the app runs migrations at startup before it serves traffic; the script waits up to 5 minutes for the app to be healthy.
6. Checks that `/api/health` on `PRODUCTION_URL` reports the tag's commit, optionally the same on `PRODUCTION_ORG_SMOKE_HOST`, then that `/`, `/auth/login`, `/robots.txt` and `/sitemap.xml` load.
7. Runs `mark-good.sh X.Y.Z`, which records the version as verified.

If step 5 or 6 fails, the run redeploys the last verified version (`rollback.sh --last-good`) and is marked failed. On the very first deploy there is nothing to go back to, so a failure leaves the stack as it is.

## Everyday use

On the server, as `deploy`:

```sh
cd /opt/careeros/production
docker compose -p careeros_production -f compose.production.yml ps
docker compose -p careeros_production -f compose.production.yml logs --tail 100 app
docker compose -p careeros_production -f compose.production.yml logs --tail 100 cloudflared
cat .current_tag .previous_tag
```

`ps` must show no published host ports.

Slow first pull: pre-pull once as `deploy` with `docker login ghcr.io` (a personal token with `read:packages`) and `docker pull ghcr.io/king-cyberton/careeros:X.Y.Z`, log out, then run the workflow.

Runner trouble: `sudo ./svc.sh status` inside `/home/deploy/actions-runner`, and check that `careeros-production` is **Idle** in the repository's runner settings.

## Rollback

- Automatic: a failed deploy, health check or page check redeploys the last verified version.
- From GitHub: run **careeros-deploy-production** with `action` = `rollback` (the tag box is ignored). It redeploys the version in `.previous_tag` and records it as current.
- On the server (target: under 3 minutes): `cd /opt/careeros/production && ./rollback.sh`.

The scripts are the same as staging: `deploy.sh <version>` deploys and waits for health; `mark-good.sh <version>` records a verified version (`.current_tag`, the older one moves to `.previous_tag`); `rollback.sh` redeploys `.previous_tag`, or `.current_tag` with `--last-good`. Released images already on the server are reused, so a rollback needs no registry login. If you run `deploy.sh` by hand, run `./mark-good.sh <version>` once you have checked it.

### Migrations and rollback

A rollback puts back the old app image; it does not undo schema changes. So from now on every release follows one rule: **a migration must not break the previous release's code.** Add first (new columns nullable or with defaults, new tables), and remove or rename only in a later release, once no running version uses the old shape (expand, then contract). Then `rollback.sh` is always safe.

A release that cannot meet the rule says so in its PR. For that release the rollback is a database restore from backup (P6-C02), not `rollback.sh`.

## Database

The same role split as staging (P1-C01): migrations as `careeros_owner` (`DATABASE_MIGRATION_URL`), serving as `careeros_app` (`DATABASE_URL`, no superuser, no `BYPASSRLS`). The one-shot `db_bootstrap` service runs `bootstrap-roles.sql` on every deploy before the app starts, so the roles are always correct. The server refuses to start in production if `DATABASE_URL` points at a role that owns tables or can bypass row-level security. Check:

```sh
docker compose -p careeros_production -f compose.production.yml exec postgres psql -U postgres -c "select rolname, rolsuper, rolbypassrls from pg_roles where rolname like 'careeros_%'"
```

Backups, a restore drill and alerts are P6-C02.

## Storage

SeaweedFS runs in the stack, as on staging, on the server's 96 GB disk.

### Moving storage to an external bucket

When the disk gets tight, switch to an S3-compatible bucket at another provider without a code change:

1. Create the bucket and an access key limited to it.
2. Copy the existing objects across (for example with `aws s3 sync` from `http://seaweedfs:8333` to the new endpoint, run in a container on the stack's storage network).
3. In `.env` set `STORAGE_BACKEND="s3"`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_FORCE_PATH_STYLE` as the provider requires.
4. Redeploy the current version. SeaweedFS can be removed from the compose file in a later release.

## Domains

- `itscareeros.com` serves the platform and the marketing home page.
- `www.itscareeros.com` redirects to the apex: in Cloudflare, **Rules -> Redirect Rules**, a rule for hostname `www.itscareeros.com` with a 301 to `https://itscareeros.com${path}` keeping the query string.
- Organization hosts `{slug}.itscareeros.com` reach the app through the wildcard hostname on the tunnel.
- Custom domains (Cloudflare for SaaS) follow in the next PR; until `CF_SAAS_*` are set the feature stays off.

## Security notes

- No container publishes host ports; only `cloudflared` makes outbound connections. The firewall allows only SSH in.
- The tunnel token and `.env` exist only on the server (`chmod 600`, owner `deploy`). If the token leaks, delete the tunnel in Zero Trust and create a new one.
- The registry token is the workflow's short-lived `GITHUB_TOKEN`, passed to `docker login` through stdin.
- `preflight.sh` stops a deploy with test keys or unsafe flags; it never prints values.
- The runner is registered to this repository only and runs as `deploy`, which has no sudo.
