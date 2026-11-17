# P2-C01: Staging serves org subdomains and custom domains through the tunnel

**Status:** Approved (Opus, 2026-11-02). **Thread:** 3 CI/CD. **Phase plan:** [P2-PHASE-PLAN.md](../P2-PHASE-PLAN.md), decisions D2 and D3. **Depends on:** P0-C03 (staging), T03 and T06 (merged).
**Branch:** `ci/P2-C01-staging-org-hosts`. **Questions:** start at Q160.

## Goal

On staging, an org with slug `acme` is served at `https://acme-careeros.ayopa.co.ke` with valid TLS, and a verified custom domain added through T06 is served through Cloudflare for SaaS. Both reach the same app container through the existing Cloudflare Tunnel. No inbound ports are opened, and no Cloudflare token is ever in the repo, a log or chat.

## Background and decisions (Opus)

- **DNS cannot hold `*-careeros`.** A DNS wildcard must be a whole label, so `*-careeros.ayopa.co.ke` is not a valid record. Each org host therefore gets its own proxied CNAME, `<slug>-careeros` → `<tunnel id>.cfargotunnel.com`, created by a script (below). Universal SSL covers every first-level name, so TLS needs no spend. (The alternative, a `*.ayopa.co.ke` wildcard, would send every unused name in Stephen's zone to staging. It is offered to Stephen as a choice; if he picks it, requirement 2's `org-dns` becomes a no-op and the runbook documents the wildcard instead.)
- **Tunnel catch-all.** Traffic for org hosts and custom hostnames arrives at the tunnel with its own `Host`. A remotely managed tunnel answers 404 for hostnames without a public-hostname rule. So the tunnel's ingress is set through the Cloudflare API with the platform host rule first and a final catch-all rule to `http://app:3000`. The app already fails closed for unknown hosts (T03: not-set-up page, 404, `noindex`).
- **Fallback origin name.** The Cloudflare for SaaS fallback origin is `careeros-saas-origin.ayopa.co.ke`, a proxied CNAME to the tunnel. It must **not** match `ORG_HOST_PATTERN` (`{slug}-careeros.ayopa.co.ke`), or it would be read as an org host. `CF_SAAS_CNAME_TARGET` is set to this name, so customers CNAME their domain to it.
- **Two tokens, two places.**
  - `CF_SAAS_API_TOKEN` (zone: SSL and Certificates edit) is used by the running app (T06). It lives in the server `.env`, like every other app secret (P0-C03).
  - `CF_STAGING_INFRA_TOKEN` (account: Cloudflare Tunnel edit; zone: DNS edit) is used only by the new dispatch workflow. It lives only as a secret on the GitHub `staging` environment, never on the server or in the app.

## Requirements

1. **Script `infra/staging/cloudflare.mjs`.**
   - Node 24, no dependencies, global `fetch`. Reads its settings from the environment only: `CF_STAGING_INFRA_TOKEN`, `CF_SAAS_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `CF_TUNNEL_ID`, `STAGING_HOST`, `ORG_HOST_PATTERN`.
   - Dry run by default: print each planned API call (method, path, body with tokens never included) and exit 0. `--apply` performs them.
   - Never prints a token. Errors print the Cloudflare error codes and messages only.
   - Every command is idempotent: it reads the current state first and changes only what differs.
2. **Commands:**
   - `tunnel-ingress`: sets the tunnel configuration to exactly two rules: `STAGING_HOST` → `http://app:3000`, then the catch-all → `http://app:3000`. Prints a diff of the old and new ingress.
   - `fallback-origin`: ensures the proxied CNAME `careeros-saas-origin` → `<CF_TUNNEL_ID>.cfargotunnel.com`, then sets it as the zone's custom-hostname fallback origin (uses `CF_SAAS_API_TOKEN`). Refuses if the name matches `ORG_HOST_PATTERN`.
   - `org-dns <slug>`: ensures the proxied CNAME for the host built from `ORG_HOST_PATTERN` → the tunnel. Validates the slug with the same rule the app uses for org slugs, and that the resulting label is at most 63 characters. Tags the record with the comment `careeros-staging-managed`.
   - `org-dns-remove <slug>`: deletes that record only if it carries the `careeros-staging-managed` comment and its name matches `ORG_HOST_PATTERN`. Anything else is refused. It never deletes in bulk.
   - `status`: prints the ingress rules, the fallback origin and its status, and the managed org records. Read only.
3. **Self-test `infra/staging/cloudflare.test.mjs`** (node:test, `fetch` stubbed):
   - the dry run makes no write calls;
   - tokens never appear in stdout or stderr, including on an API error;
   - `fallback-origin` refuses a name that matches the pattern;
   - `org-dns` rejects an invalid slug and a label over 63 characters;
   - `org-dns-remove` refuses an unmanaged record and a name outside the pattern;
   - a second `--apply` of each command makes no write calls.
     Add the file to the `static` job's `node --test` step from P2-C02 (extend the glob to `infra/staging/*.test.mjs`).
4. **Workflow `.github/workflows/careeros-staging-cloudflare.yml`.**
   - `workflow_dispatch` only, with inputs `command` (a choice of the five commands), `slug` (optional) and `apply` (boolean, default false).
   - `environment: staging`, so the environment's required reviewers apply. `runs-on: ubuntu-latest`; it does not need the VPS runner.
   - Passes the secrets `CF_STAGING_INFRA_TOKEN` and `CF_SAAS_API_TOKEN`, and the variables `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `CF_TUNNEL_ID`, `STAGING_HOST` and `ORG_HOST_PATTERN`, as step environment only. `permissions: contents: read`. Concurrency: one run at a time, no cancel.
   - Fails with a clear message naming the missing setting when a required secret or variable is unset.
5. **Deploy check.** In `careeros-deploy-staging.yml`, after the existing health check, if the variable `STAGING_ORG_SMOKE_HOST` is set, `curl` `https://$STAGING_ORG_SMOKE_HOST/api/health` and expect 200 with the same SHA. Skip with a notice when it is unset.
6. **Runbook.** Add an "Org hosts and custom domains" section to `infra/staging/README.md`:
   - the owner actions, in order: enable Cloudflare for SaaS on the zone; create the two scoped tokens with exactly the permissions above; add `CF_SAAS_API_TOKEN`, `CF_ZONE_ID` and `CF_SAAS_CNAME_TARGET=careeros-saas-origin.ayopa.co.ke` to the server `.env`; add the GitHub `staging` secrets and variables; run `tunnel-ingress`, then `fallback-origin`, then `org-dns <slug>` for each test org, each first as a dry run;
   - that tunnel public hostnames must no longer be edited in the dashboard, because `tunnel-ingress` owns them;
   - how to check: `status`, then open the org host and look for the org's name and favicon;
   - how to add a custom domain for testing, and how to remove one (T06 removal, then the customer's CNAME).
   - Keep `infra/staging/.env.staging.example` in step: comment `CF_SAAS_CNAME_TARGET` with the fallback origin name.
7. **Docs.** Add a line to `CHANGELOG-CAREEROS.md`. No upstream files change.

## Acceptance

- In CI: the self-test passes in `static`, lint and format are clean, and a dispatch dry run with no secrets fails with the "missing setting" message and makes no API call.
- Live (owner verification, after Stephen's actions): `status` shows the two ingress rules and an active fallback origin; `https://<slug>-careeros.ayopa.co.ke` serves the org's brand with valid TLS; an unknown `nope-careeros.ayopa.co.ke` without a record does not resolve, and one with a record but no org returns the not-set-up page with 404; a test custom domain moves to `active` through the T06 polling job and serves the org's brand.

## Out of scope

Production DNS (waits on PRODUCT.md §15.1); creating org DNS records automatically when an org is created (Phase 3, if staging needs it); per-org sending domains.
