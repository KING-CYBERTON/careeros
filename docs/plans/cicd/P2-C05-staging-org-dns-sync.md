# P2-C05: every staging organization gets a working address without a manual step

**Status:** Approved (Opus, 2026-11-10). Stephen chose "Auto-create a record per org" for QA test **CD-01** (high). **Thread:** 3 CI/CD. **Depends on:** P2-C01 (merged). **Follows up:** P2-C01's out-of-scope item
"creating org DNS records automatically when an org is created (Phase 3, if staging needs it)". Staging needs it now.

## Problem

On staging an organization is served at `<slug>-careeros.ayopa.co.ke`. DNS cannot hold `*-careeros`, so each host needs
its own proxied CNAME to the tunnel, which `infra/staging/cloudflare.mjs org-dns <slug>` creates only when someone runs it
by hand. Workspaces created since then, such as every personal workspace (`u-<id>`), have no record, so their address
times out (`ERR_CONNECTION_TIMED_OUT`). The QA team then sees CD-01 and every host-based test fail.

## Change

1. **Script command `org-dns-sync`** in `infra/staging/cloudflare.mjs`:
   - It reads slugs, one per line, from stdin. It validates each slug with the existing `org-dns` rule and skips invalid
     ones with a notice. It never stops the whole run for one bad slug.
   - It reads the zone's records once, then ensures the managed CNAME for each slug that lacks one, the same way as
     `org-dns` (the same comment tag, proxied, the same target). It is a dry run unless `--apply`, and idempotent.
   - It **never deletes** a record, because removal stays manual through `org-dns-remove`.
   - It caps creations at 50 per run (a guard against a runaway query) and prints how many slugs it saw, created and
     skipped. It prints no token.
   - Required settings are the same as `org-dns`.
2. **Self-tests** in `infra/staging/cloudflare.test.mjs`:
   - a dry run makes no writes;
   - an apply creates only the missing records, and a second apply creates none;
   - invalid slugs are skipped;
   - the cap holds;
   - no delete call is ever made;
   - tokens never appear in output.
3. **Workflow `.github/workflows/careeros-staging-org-dns-sync.yml`:**
   - Triggers are `schedule` every 10 minutes, `workflow_run` after `careeros-deploy-staging` completes successfully, and
     `workflow_dispatch`.
   - It runs on `[self-hosted, staging]` because only that runner can reach the database. Concurrency is one run at a
     time, with no cancel. Permissions are `contents: read`.
   - It reads slugs on the server, from `/opt/careeros/staging`, with
     `docker compose -p careeros_staging -f compose.staging.yml exec -T postgres psql -U postgres -d postgres -Atc "select slug from organization where slug is not null"`.
     The local superuser inside the container needs no password and bypasses RLS. This is read only. It pipes the slugs
     to `node infra/staging/cloudflare.mjs org-dns-sync --apply`, running the script from the workflow's checkout.
   - It uses a new GitHub environment, `staging-dns`, with **no required reviewers**, so that scheduled runs are not held
     for approval. The environment holds one secret, `CF_STAGING_DNS_TOKEN`, scoped to zone `ayopa.co.ke`, **DNS: Edit
     only** (no tunnel permission), plus the variables `CF_ZONE_ID`, `CF_TUNNEL_ID` and `ORG_HOST_PATTERN`. The script reads
     it as `CF_STAGING_INFRA_TOKEN` for this command. If any setting is missing, it ends with a notice and success, so the
     schedule doesn't go red before Stephen finishes setup.
4. **Runbook** (`infra/staging/README.md`, section "Org hosts and custom domains"): replace "run `org-dns` for each test
   organization" with the automatic sync. List the owner actions: create the DNS-only token and the `staging-dns`
   environment with its secret and variables. Say that a new org's address works within about 10 minutes, and that
   `org-dns` stays available for an immediate record.
5. `CHANGELOG-CAREEROS.md` gets one line. No app or upstream files change.

## Out of scope

Deleting records for removed organizations (manual, `org-dns-remove`). Production DNS (production uses a wildcard on its
own domain, PRODUCT.md §5). A wildcard on `ayopa.co.ke` (Stephen's alternative choice).

## Acceptance

- The `static` job runs the new self-tests, and lint and format are clean.
- Live, after Stephen's setup: create a new workspace on staging. Within 10 minutes, `https://<slug>-careeros.ayopa.co.ke`
  loads with that org's brand. A second sync run creates nothing.
- QA CD-01 passes: Settings > Domains on the org's address shows its subdomain as "always works", and that address loads.
