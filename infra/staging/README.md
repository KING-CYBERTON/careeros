# Staging environment runbook (P0-C03)

Staging runs the latest green `develop` image of CareerOS on a single server (the home-lab VPS). Everything is deployed automatically by a GitHub Actions runner that lives on that server. The server opens **no inbound ports**: visitors reach it through a Cloudflare Tunnel, and Cloudflare provides HTTPS.

How it fits together:

```
push to develop -> careeros-ci -> careeros-image (GHCR) -> careeros-deploy-staging
                                                               |  (job runs on the self-hosted runner on the VPS)
                                                               v
              visitors -> Cloudflare (HTTPS) -> tunnel -> cloudflared container -> app container (port 3000, internal only)
```

In this document `careeros-staging.ayopa.co.ke` is the example host name. The real values are the GitHub `staging` environment variables `STAGING_HOST` and `STAGING_URL`; they are not written into any workflow or compose file.

Never paste secrets (tunnel token, `.env` contents, GitHub tokens) into chat, issues, pull requests or git.

## One-time setup

Do these steps once, in order. You need: an Ubuntu 24.04 LTS server with sudo access, admin access to the GitHub repo, and the Cloudflare account that owns `ayopa.co.ke`.

### 1. Create the `deploy` user and install Docker

On the server, as a user with sudo:

```sh
sudo adduser --disabled-password --gecos "" deploy

# Docker Engine + compose plugin (official convenience script; review it first if you prefer)
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
rm get-docker.sh

# Let the deploy user run docker without sudo
sudo usermod -aG docker deploy

# Directory for the staging stack
sudo install -d -o deploy -g deploy -m 0750 /opt/careeros/staging
```

Check: `sudo -u deploy docker compose version` prints a version. Do not open or forward any inbound ports (80, 443 or others) for staging.

### 2. Register the self-hosted GitHub runner

1. In GitHub open the repository, then **Settings -> Actions -> Runners -> New self-hosted runner**. Choose **Linux** and the matching architecture (usually x64).
2. On the server, switch to the deploy user: `sudo -iu deploy`. Run the **Download** commands that GitHub shows (they create a `actions-runner` folder).
3. Run the **Configure** command that GitHub shows (it contains a one-time token). When asked for labels, enter `staging` (the `self-hosted` label is added automatically, so the labels are `self-hosted,staging`). Accept the defaults for the rest.
4. Install and start it as a service, still as sudo-capable user (not `deploy`, which has no sudo): leave the `deploy` shell with `exit`, then:

   ```sh
   cd /home/deploy/actions-runner
   sudo ./svc.sh install deploy
   sudo ./svc.sh start
   sudo ./svc.sh status
   ```

5. Back in GitHub the runner should appear as **Idle** with labels `self-hosted`, `staging`. The runner only needs outbound HTTPS. Keep it registered to this private repository only.

### 3. Create the Cloudflare Tunnel

1. Sign in to Cloudflare and open **Zero Trust** (the one-time team-name prompt is fine on the free plan).
2. Go to **Networks -> Tunnels -> Create a tunnel**. Choose **Cloudflared** and name it, for example `careeros-staging`.
3. On the install screen, pick **Docker**. Copy only the token (the long string after `--token`). Do not run the command it shows; the compose file runs `cloudflared` for you. Keep the token private.
4. Open the **Public hostname** tab and add a hostname:
   - Subdomain/domain: `careeros-staging` on `ayopa.co.ke` (that is `careeros-staging.ayopa.co.ke`)
   - Service type **HTTP**, URL `app:3000`

   Cloudflare creates the DNS CNAME record by itself.

5. In the Cloudflare dashboard for `ayopa.co.ke`, under **SSL/TLS -> Edge Certificates**, turn on **Always Use HTTPS**.

### 4. Create the server `.env`

Still on the server, as `deploy` (`sudo -iu deploy`). Wait until the first workflow run has copied the files, or fetch the template yourself:

```sh
cd /opt/careeros/staging
# Template: either wait for step 6's first run to put .env.staging.example here, or copy it from the repo
cp .env.staging.example .env
chmod 600 .env
openssl rand -hex 32   # run once for each CHANGE_ME secret below
nano .env
```

In `.env` set, using fresh generated values:

- `TUNNEL_TOKEN`: the token from step 3
- `APP_URL`: `https://careeros-staging.ayopa.co.ke` (your real staging host)
- `POSTGRES_PASSWORD` (superuser; used only by the one-shot `db_bootstrap` service)
- `CAREEROS_OWNER_PASSWORD` and `CAREEROS_APP_PASSWORD`, and the same values inside `DATABASE_MIGRATION_URL` (owner) and `DATABASE_URL` (app); see "Database roles" below
- `AUTH_SECRET`, `ENCRYPTION_SECRET` (different values)
- `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
- `IMAGE_REPOSITORY`: `ghcr.io/<owner>/<repo>` in lowercase (default is already correct for this repo)

Email is intentionally left unset in Phase 0: the app skips sending mail and sign-up still works.

### 5. Set the GitHub `staging` environment variables

In GitHub: **Settings -> Environments -> New environment** named `staging` (if it does not exist). Under **Environment variables** add:

| Variable       | Value                                  |
| -------------- | -------------------------------------- |
| `STAGING_HOST` | `careeros-staging.ayopa.co.ke`         |
| `STAGING_URL`  | `https://careeros-staging.ayopa.co.ke` |

No secrets are needed: the workflow uses the built-in `GITHUB_TOKEN` to pull the image from GHCR.

### 6. First deploy

1. In GitHub open **Actions -> careeros-deploy-staging -> Run workflow**.
2. Enter `image_tag` = `sha-<full commit sha>` of a commit on `develop` whose `careeros-image` run succeeded (see the repo's **Packages** page for tags).
3. Wait for the run to finish (first start also builds volumes and can take a few minutes). Then open `https://careeros-staging.ayopa.co.ke/api/health`: it should report `"status":"healthy"` and the commit in `revision`.

From now on every successful `careeros-image` run on `develop` deploys automatically.

## Everyday use

Logs (on the server, as `deploy`):

```sh
cd /opt/careeros/staging
docker compose -p careeros_staging -f compose.staging.yml ps
docker compose -p careeros_staging -f compose.staging.yml logs --tail 100 app
docker compose -p careeros_staging -f compose.staging.yml logs --tail 100 cloudflared
```

`ps` must show no published host ports. The GitHub run log shows each deploy step.

Runner trouble: `sudo ./svc.sh status` inside `/home/deploy/actions-runner`, and check the runner is **Idle** in GitHub settings.

## Database roles

The app does not connect as the PostgreSQL superuser. Two roles exist (P1-C01):

| Role             | Used for                                                                            | Env var                  |
| ---------------- | ----------------------------------------------------------------------------------- | ------------------------ |
| `careeros_owner` | Runs migrations at app startup; owns schemas `public` and `drizzle` and all tables  | `DATABASE_MIGRATION_URL` |
| `careeros_app`   | Runtime queries; no superuser, no `BYPASSRLS`, owns no table, cannot create objects | `DATABASE_URL`           |

Row-level security (added from Phase 1b) only protects data when the app is not the table owner and cannot bypass RLS, which is why the split is required.

Startup check (P1-T04): after migrations, the server inspects the `DATABASE_URL` role. If it owns `public.resume`, is a superuser or has `BYPASSRLS`, startup logs an error naming the role and exits non-zero when `NODE_ENV=production` (the Docker image default); in other environments it logs a warning and continues, because the unit-test job runs as `postgres`. If staging refuses to start with this message, point `DATABASE_URL` at `careeros_app` and `DATABASE_MIGRATION_URL` at `careeros_owner`. Self-hosters running a single database role must do the same split (see `infra/db/bootstrap-roles.sql`).

How it works: the one-shot compose service `db_bootstrap` runs `bootstrap-roles.sql` as the superuser (`POSTGRES_PASSWORD`) on every `docker compose up`, before `app` starts (`app` waits for it with `service_completed_successfully`). The script is idempotent: it creates or normalises both roles with the passwords from `CAREEROS_OWNER_PASSWORD` / `CAREEROS_APP_PASSWORD`, moves ownership of every existing table and sequence in `public` and `drizzle` to `careeros_owner` (no `DROP`), and grants `careeros_app` data access only. So the first deploy after this change converts the existing staging database in place; no data is lost.

To change a role password, edit it in `.env` (both the variable and the URL) and redeploy. To check the result on the server:

```sh
cd /opt/careeros/staging
docker compose -p careeros_staging -f compose.staging.yml logs db_bootstrap
docker compose -p careeros_staging -f compose.staging.yml exec postgres psql -U postgres -c "select rolname, rolsuper, rolbypassrls from pg_roles where rolname like 'careeros_%'"
```

The roles must be `rolsuper = f` and `rolbypassrls = f`. The same SQL is used in CI (`infra/db/bootstrap-roles.sh`).

## Rollback

- Automatic: if the deploy, health check or smoke test fails, the workflow redeploys the last healthy tag and the run is marked failed.
- Manual, on the server (target: under 3 minutes):

  ```sh
  cd /opt/careeros/staging
  ./rollback.sh
  ```

  This redeploys the tag in `.previous_tag` and records it as the current tag.

- Three files drive this: `deploy.sh <tag>` only deploys and waits for health; `mark-good.sh <tag>` records a tag as verified (`.current_tag`, and the older one moves to `.previous_tag`); `rollback.sh` redeploys `.previous_tag` (or `.current_tag` with `--last-good`, which the workflow uses after a failed deploy). The workflow runs `mark-good.sh` only after the health revision check and smoke test pass. If you run `deploy.sh` by hand, run `./mark-good.sh <tag>` once you have verified it, otherwise rollback will not know about it.

- Manual, from GitHub: run **careeros-deploy-staging** with an older `sha-<sha>` tag.

Database migrations are forward-only in Phase 0: a rollback restores the old app image but does not undo schema changes.

## Org hosts and custom domains (P2-C01)

Organizations are served at `https://<slug>-careeros.ayopa.co.ke` (organization hosts) and, once verified, on their own domain (Cloudflare for SaaS custom hostnames). Both arrive at the same `cloudflared` container and the same app container; the app decides the organization from the `Host` header. A host the app does not know gets the "not set up yet" page with status 404.

A DNS wildcard must be a whole label, so `*-careeros.ayopa.co.ke` cannot exist. Each organization host therefore gets its own proxied CNAME to the tunnel, created by `infra/staging/cloudflare.mjs`. Universal SSL covers these first-level names at no cost.

### Owner actions, in order

Never paste a token into chat, an issue, a pull request or git.

1. In Cloudflare, enable **Cloudflare for SaaS** (SSL/TLS -> Custom Hostnames) on the `ayopa.co.ke` zone.
2. Create two scoped API tokens, with exactly these permissions and nothing more:
   - `CF_SAAS_API_TOKEN`: zone `ayopa.co.ke`, **SSL and Certificates: Edit**. The running app uses it (T06).
   - `CF_STAGING_INFRA_TOKEN`: account permission **Cloudflare Tunnel: Edit**, zone permission **DNS: Edit** on `ayopa.co.ke`. Only the GitHub workflow uses it.
3. On the server, add to `/opt/careeros/staging/.env`: `CF_SAAS_API_TOKEN`, `CF_ZONE_ID` and `CF_SAAS_CNAME_TARGET=careeros-saas-origin.ayopa.co.ke`. Redeploy so the app reads them.
4. In GitHub **Settings -> Environments -> staging** add the secrets `CF_STAGING_INFRA_TOKEN` and `CF_SAAS_API_TOKEN`, and the variables `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `CF_TUNNEL_ID`, `STAGING_HOST` (already set) and `ORG_HOST_PATTERN` (`{slug}-careeros.ayopa.co.ke`). `CF_STAGING_INFRA_TOKEN` stays on GitHub only, never on the server or in the app. Optionally set `STAGING_ORG_SMOKE_HOST` (an organization host that exists) so each deploy also checks that host's `/api/health`.
5. Run **Actions -> careeros-staging-cloudflare -> Run workflow** for each command below. Run each one first as a dry run (leave `apply` off), read the plan, then run it again with `apply` ticked:
   1. `tunnel-ingress`
   2. `fallback-origin`
   3. `org-dns` with `slug` set to each test organization

   The environment's required reviewers must approve each run.

The same script runs locally with the settings in the environment: `node infra/staging/cloudflare.mjs <command> [slug] [--apply]`. It is a dry run unless `--apply` is given, never prints a token, and each command only changes what differs.

### The tunnel ingress is owned by the script

`tunnel-ingress` sets the tunnel configuration to exactly two rules: `STAGING_HOST` -> `http://app:3000`, then a catch-all -> `http://app:3000`. The catch-all lets organization hosts and custom hostnames through (a remotely managed tunnel answers 404 for a host without a rule). **Do not edit the tunnel's public hostnames in the Cloudflare dashboard any more**; the next `tunnel-ingress` run would overwrite them.

### Check it

1. Run `status`. It shows the two ingress rules, the fallback origin and its status (it should become `active`) and the managed organization records.
2. Open `https://<slug>-careeros.ayopa.co.ke`. You should see the organization's name and favicon. A name with no record does not resolve; a name with a record but no organization shows the "not set up yet" page (404).

### Test a custom domain

Add the domain to a test organization through the API (`POST /organization/domains` on the OpenAPI endpoint, or the settings page once P2-T07 ships). The response lists the DNS records the customer must add: a TXT record that proves ownership, then a CNAME to `careeros-saas-origin.ayopa.co.ke`. When the TXT record is found and Cloudflare issues the certificate, the T06 polling job moves the domain to `active` (within a few minutes); `status` does not list custom domains, so look at the domain's status in the organization settings or API. Then open the domain: it serves the organization's brand.

### Remove an organization host or a custom domain

- Organization host: run `org-dns-remove` with the slug. It deletes only a record that carries the comment `careeros-staging-managed` and whose name matches `ORG_HOST_PATTERN`; it never deletes in bulk.
- Custom domain: remove it in the organization's domain settings (`DELETE /organization/domains/{id}`, which also removes the Cloudflare custom hostname), then ask the customer to delete their CNAME and TXT records. A removed domain stops being served within about a minute.

## Security notes

- No container publishes host ports; only `cloudflared` makes outbound connections.
- The tunnel token and `.env` exist only on the server (`chmod 600`). If a token leaks, delete the tunnel in Zero Trust and create a new one.
- The registry token is the workflow's short-lived `GITHUB_TOKEN`, passed to `docker login` through stdin.
