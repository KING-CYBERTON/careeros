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
- `POSTGRES_PASSWORD`, and the same password inside `DATABASE_URL`
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

## Rollback

- Automatic: if the deploy, health check or smoke test fails, the workflow redeploys the last healthy tag and the run is marked failed.
- Manual, on the server (target: under 3 minutes):

  ```sh
  cd /opt/careeros/staging
  ./rollback.sh
  ```

  This redeploys the tag in `.previous_tag`. Tags are kept in `.current_tag` and `.previous_tag`.

- Manual, from GitHub: run **careeros-deploy-staging** with an older `sha-<sha>` tag.

Database migrations are forward-only in Phase 0: a rollback restores the old app image but does not undo schema changes.

## Security notes

- No container publishes host ports; only `cloudflared` makes outbound connections.
- The tunnel token and `.env` exist only on the server (`chmod 600`). If a token leaks, delete the tunnel in Zero Trust and create a new one.
- The registry token is the workflow's short-lived `GITHUB_TOKEN`, passed to `docker login` through stdin.
