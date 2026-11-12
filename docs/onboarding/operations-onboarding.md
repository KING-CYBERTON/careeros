# Operations onboarding

This guide is for whoever runs CareerOS environments: deploying, rolling back, tagging releases, granting platform admins and looking after secrets. It was generated from the prompt in [PROMPTS.md](PROMPTS.md#4-operations-onboarding) and checked against `develop` on 2026-11-11. It points to the runbooks for full commands; the runbooks are the source of truth.

Main runbooks: [infra/staging/README.md](../../infra/staging/README.md) and [docs/runbooks/job-clipper-release.md](../runbooks/job-clipper-release.md).

## 1. Environments

| Environment | Where                                                                                                           | Database roles                                                                      | Notes                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local       | A developer's machine, `pnpm dev`                                                                               | Superuser is fine for plain development; the CareerOS test role for database suites | See [developer onboarding](developer-onboarding.md)                                                                                                                                   |
| CI          | GitHub Actions, `careeros-ci`                                                                                   | Role split, as in staging                                                           | Disposable Postgres per run                                                                                                                                                           |
| Staging     | `https://careeros-staging.ayopa.co.ke`, Stephen's home-lab server, Docker Compose under `/opt/careeros/staging` | `careeros_owner` migrates, `careeros_app` serves                                    | Reached through a Cloudflare Tunnel; no published host ports                                                                                                                          |
| Production  | **Not set up yet**                                                                                              | Will mirror staging                                                                 | Waiting on Stephen's hosting decision (G8). It gets its own database, storage and secrets, deploys only from a `v*` tag on `main`, and reuses the staging deploy and rollback scripts |

Organization hosts on staging follow `{slug}-careeros.ayopa.co.ke`, and custom domains go through Cloudflare for SaaS on the `ayopa.co.ke` zone.

## 2. How code reaches staging

1. A PR merges to `develop`.
2. `careeros-ci` runs on the push. When it is green, `careeros-image` builds the Docker image and pushes `ghcr.io/king-cyberton/careeros:sha-<sha>`.
3. A successful image run starts `careeros-deploy-staging` on the self-hosted runner on the staging server. It runs `deploy.sh <tag>`, waits for health, checks that `/api/health` reports the expected revision, runs a smoke test, then `mark-good.sh <tag>`.
4. Migrations run at app startup as `careeros_owner`, before traffic is served.

To see which build is live, open `https://careeros-staging.ayopa.co.ke/api/health` and read `revision`. To deploy a specific build by hand, run **careeros-deploy-staging** from the Actions tab with `image_tag` set to `sha-<full sha>`.

If deploys stop arriving, the usual cause is the self-hosted runner. On the server, as `deploy`, run `sudo ./svc.sh status` in `/home/deploy/actions-runner`, and restart it with `stop` and `start` if needed.

## 3. Rollback

- **Automatic.** If the deploy, health check or smoke test fails, the workflow redeploys the last good tag and marks the run failed.
- **Manual on the server** (target under 3 minutes): `cd /opt/careeros/staging && ./rollback.sh`. This redeploys the tag in `.previous_tag`.
- **Manual from GitHub.** Run **careeros-deploy-staging** with an older `sha-<sha>` tag.

Migrations are forward-only. A rollback restores the old image but does not undo schema changes, which is why every migration must be safe for the previous app version too.

## 4. Release tags

Pick a `develop` commit with all `careeros-ci` jobs green, create an annotated tag `vMAJOR.MINOR.PATCH`, and push it. The tag starts `careeros-image`, which publishes `ghcr.io/king-cyberton/careeros:<version>`. The upstream publisher is switched off in this repository, and a CI self-test fails if any other workflow could run on a tag. Opus decides when to tag; the tags `v0.0.1`, `v0.1.0` and `v0.2.0` are waiting for Stephen to push them because sessions cannot push tags. Full steps: staging runbook, "Cutting a release".

## 5. Workflows

| Workflow                        | Trigger                                                 | What it does                                                                                             |
| ------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `careeros-ci`                   | PRs and pushes to `develop` and `main`, manual          | Lint, format, boundaries, typecheck, branding gate, unit shards, extension pack, e2e                     |
| `careeros-image`                | After CI on `develop`, `v*` tags, manual                | Builds and pushes the Docker image to GHCR                                                               |
| `careeros-deploy-staging`       | After a successful image run on `develop`, manual       | Deploys to staging with health check, smoke test and automatic rollback                                  |
| `careeros-staging-cloudflare`   | Manual                                                  | Manages staging org hosts and custom domains through the tunnel and DNS (`infra/staging/cloudflare.mjs`) |
| `careeros-staging-org-dns-sync` | Every 10 minutes, after deploys, manual                 | Creates a DNS record for every new organization so its address works without a manual step               |
| `careeros-landing`              | PRs and `develop` pushes that touch the marketing pages | Checks the static pages and copies them into the running staging container                               |
| `careeros-licenses`             | `develop` pushes, Mondays 06:00 UTC, manual             | Production dependency licence report with a deny-list                                                    |
| `careeros-extension-release`    | `clipper-v*` tags, manual                               | Builds `job-clipper-<version>.zip` and its SHA-256 checksum for the stores                               |

The upstream workflows (`ci.yml`, `docker-publish.yml`, mobile release workflows) remain in the tree for upstream merges; `docker-publish.yml` is guarded so it never runs here.

## 6. Secrets and variables

Only names appear here. Values live in the server's `.env` (mode 600) or in GitHub settings, never in git, logs or chat. The template is [infra/staging/.env.staging.example](../../infra/staging/.env.staging.example).

| Name                                                                                                               | Lives in                                                        | What breaks without it                                                               |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `TUNNEL_TOKEN`                                                                                                     | Server `.env`                                                   | Staging is unreachable                                                               |
| `POSTGRES_PASSWORD`, `CAREEROS_OWNER_PASSWORD`, `CAREEROS_APP_PASSWORD`, `DATABASE_URL`, `DATABASE_MIGRATION_URL`  | Server `.env`                                                   | The app cannot start; with a wrong role it refuses to start in production            |
| `AUTH_SECRET`, `ENCRYPTION_SECRET`                                                                                 | Server `.env`                                                   | Sign-in, and saved AI providers                                                      |
| `ORG_HOST_PATTERN`, `TRUST_FORWARDED_HOST`                                                                         | Server `.env`                                                   | Organization hosts and support sessions are off                                      |
| `CF_SAAS_API_TOKEN`, `CF_ZONE_ID`, `CF_SAAS_CNAME_TARGET`                                                          | Server `.env`, and the token as a repository and staging secret | Organizations cannot add custom domains                                              |
| `CF_STAGING_INFRA_TOKEN`, `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `CF_TUNNEL_ID`                                            | GitHub `staging` environment                                    | The Cloudflare and DNS sync workflows fail                                           |
| `STAGING_HOST`, `STAGING_URL`                                                                                      | GitHub `staging` environment variables                          | The deploy workflow cannot check health                                              |
| `ANTHROPIC_API_KEY`, `CAREEROS_AI_MODEL_GENERATION`, `CAREEROS_AI_MODEL_FAST`                                      | Server `.env`                                                   | Platform AI is off; members need their own keys                                      |
| `BILLING_PROVIDER`, `BILLING_FAKE_SECRET`, `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`, `PAYSTACK_ALLOW_TEST_KEY` | Server `.env`                                                   | Billing stays off (`none`)                                                           |
| `EMAIL_PROVIDER`, `PLUNK_SECRET_KEY`, `EMAIL_FROM_ADDRESS`, `PLUNK_WEBHOOK_SECRET`                                 | Server `.env`                                                   | Emails are only logged; with `plunk` and a missing value the server refuses to start |
| `REDIS_URL`                                                                                                        | Server `.env`                                                   | Rate limits and resumable replies are per process only                               |

If a secret leaks, tell Stephen first: rotating production secrets needs his approval. For the tunnel token, delete the tunnel in Cloudflare Zero Trust and create a new one.

## 7. Routine tasks

- **Grant or remove a platform admin.** Run `node tooling/careeros/platform-admin.mjs grant <email> --operator "<your name>"` (or `revoke`, `list`) with `DATABASE_MIGRATION_URL` set to the owner connection. Each change writes a platform audit row. The new admin must turn on two-factor authentication before `/admin` works. See the staging runbook, "Platform admins".
- **Org hosts and custom domains.** New organization addresses get DNS records automatically every 10 minutes. Custom domain setup, checks and removal are in the staging runbook, "Org hosts and custom domains".
- **Email through Plunk.** Verify the sending domain in Plunk, set the four variables, create the bounce and complaint webhook, redeploy, then send a test email from `/admin`, Email. See the staging runbook, "Email through Plunk".
- **Paystack.** Put test keys in the staging `.env` with `BILLING_PROVIDER=paystack` and `PAYSTACK_ALLOW_TEST_KEY=true`, and set the webhook URL `https://careeros-staging.ayopa.co.ke/api/billing/webhook/paystack` in the Paystack dashboard.
- **Job Clipper release.** Bump the version, tag `clipper-v<version>`, download the zip from the workflow, and submit it to the Chrome Web Store and Edge Add-ons. See [the clipper runbook](../runbooks/job-clipper-release.md).

## 8. Actions that need Stephen's written approval

Per PRODUCT.md §1.5.4, never do these without Stephen's explicit go-ahead, logged in [docs/ESCALATIONS.md](../ESCALATIONS.md): deleting production data, dropping production tables, force-pushing or rewriting `main`, rotating production secrets, and deleting cloud resources. Spending money (a new paid service or plan) also goes to him.

## 9. Open operational items

Taken from [docs/STATUS.md](../STATUS.md) on 2026-11-11; check there for the current list.

| Item                                                                                | Owner                  |
| ----------------------------------------------------------------------------------- | ---------------------- |
| Restart the staging runner so queued deploys run                                    | Stephen                |
| Push tags `v0.0.1`, `v0.1.0`, `v0.2.0`                                              | Stephen                |
| Production hosting choice (G8), then the production environment (P6-C01)            | Stephen, then Thread 3 |
| Backups with a restore drill (G9) and monitoring (G11) (P6-C02)                     | Thread 3, after P6-C01 |
| Paystack account, test keys and webhook on staging                                  | Stephen                |
| Chrome Web Store and Microsoft Partner Center accounts for the clipper              | Stephen                |
| Repository settings: default branch, branch protection, secret scanning, Dependabot | Stephen                |
