# P2-T06: Organizations can serve the product on their own domain

**Status:** Approved (Opus, 2026-11-01). **Thread:** 1 Build. **Phase plan:** [P2-PHASE-PLAN.md](P2-PHASE-PLAN.md), decisions D3, D4 and D7, and exit criterion 2. **Risks section:** domain takeover, cross-org hostname claims, SSRF through DNS checks, and secret handling.
**Branch:** `feat/P2-T06-org-custom-domains`. **Depends on:** T03 (merged). T05 (handoff) should merge first if possible, because handoff targets must include verified custom domains. If T06 lands first, T05 picks them up through `HostContext`.

## Goal

An org owner or admin adds `careers.acme.com`. CareerOS shows the DNS records to create. Once the TXT record proves ownership, CareerOS registers the hostname with Cloudflare for SaaS, which issues TLS. The host starts resolving to that organization through T03's `customDomainOrg` hook. Removing the domain stops it serving, both in CareerOS and in Cloudflare.

## Requirements

1. **Table `organization_domain`** (new migration and Drizzle schema):
   - Columns:
     - `id`;
     - `organization_id`, a foreign key to `organization` with on delete cascade;
     - `hostname`, normalized with the existing `normalizeHostname` from `packages/api/src/features/custom-domain/service.ts`;
     - `status`: `pending`, `verified`, `active`, `failed` or `removing`;
     - `verification_token`: random, 128 bits or more;
     - `cf_custom_hostname_id`, nullable;
     - `cf_ssl_status`, nullable text;
     - `last_checked_at`, `verified_at`, `failure_reason` (short code, not provider text), `created_at`, `created_by`.
   - Tenant-scoped with RLS: ENABLE plus FORCE, `tenant_isolation`. Add it to the isolation registry with full checks.
   - At most 5 domains per organization (constant), enforced in the service and by a definer-function check.
2. **One hostname, one owner, across both domain kinds (D7).**
   - A definer function `careeros_claim_org_domain(org_id, hostname)` inserts the row only if the hostname is not in `organization_domain` for any org, not in the upstream `custom_domain` table for any user, and not one of `ownHosts()` or under them. That last rule covers the platform host, its aliases and any host matching `ORG_HOST_PATTERN`.
   - The upstream `custom_domain` add path gains the reverse check through a second definer function. Mark it `CAREEROS:`.
   - Both functions follow the pattern: `SECURITY DEFINER`, `SET search_path = pg_catalog, public`, EXECUTE revoked from PUBLIC and granted to `careeros_app` conditionally. They take a lock on the hostname (`pg_advisory_xact_lock(hashtext(hostname))`) so two concurrent claims cannot both succeed.
3. **Host lookup.** Add `careeros_org_for_custom_host(hostname)` as a definer function. It returns `organization_id` and `slug` only for status `active`. Wire it into T03's `customDomainOrg` hook, with the same 60-second cache and bust on status change. Only `active` hosts resolve. `pending`, `verified`, `failed` and `removing` behave like unknown hosts and fail closed, as T03 does.
4. **Verification.**
   - DNS records to show:
     - a TXT record at `_careeros-verify.<hostname>` with value `careeros-verify=<token>`;
     - a CNAME from `<hostname>` to `CF_SAAS_CNAME_TARGET` (new env var, the Cloudflare for SaaS fallback target).
   - Reuse the DNS helpers in the custom-domain service where they fit. DNS lookups use `node:dns/promises` only, never HTTP fetches to the hostname, so there is no SSRF surface. Use a 5-second timeout per lookup.
   - `pending` becomes `verified` once the TXT matches.
   - Then call Cloudflare to create the custom hostname, with `ssl: { method: "http", type: "dv" }`. Store `cf_custom_hostname_id`. The status becomes `active` when Cloudflare reports both the hostname and SSL `active`.
5. **Cloudflare client** (`packages/api/src/features/org-domain/cloudflare.ts`):
   - A minimal typed fetch client for create, get and delete custom hostnames on `CF_ZONE_ID`, with `CF_SAAS_API_TOKEN` as the bearer token. Both are new env vars (server only, optional) added to `packages/env`, `.env.example` placeholders, `.env.staging.example` and turbo.json.
   - When either is unset, the feature reports "not configured": the add endpoint returns a clear error, and nothing calls Cloudflare.
   - Never log the token or full response bodies; log the HTTP status and Cloudflare error codes only.
   - Use a 10-second timeout, and retry idempotent GETs only.
6. **Polling job.** Extend the existing scheduled jobs. Do not add a new scheduler.
   - Every 5 minutes, re-check `pending` rows (TXT) and `verified` rows (Cloudflare status), in batches of 20, using database time.
   - Rows stuck in `pending` for 7 days become `failed` (`verification_timeout`).
   - Every 24 hours, re-check `active` rows. If the TXT has disappeared for 3 checks in a row, or Cloudflare reports the hostname moved or deleted, the row becomes `failed` and stops resolving. This is the takeover guard: a domain whose owner moved it away must not keep pointing at the org.
   - Reach the rows across orgs through a definer function that returns ids only (the D9 pattern used by `careeros_stale_custom_domains`). Each row is then processed inside `withOrgContext` for its org.
7. **Removal.**
   - `DELETE` sets `removing`, which stops resolution at once, then deletes the Cloudflare hostname, then deletes the row.
   - If the Cloudflare delete fails, the row stays `removing` and the polling job retries.
   - Deleting an organization (cascade) must also clean Cloudflare: add the hostnames to the existing storage-cleanup style queue, or say in the PR which mechanism you used.
8. **API** (`organizationDomain` router, `protectedProcedure`, owner or admin of the current org only):
   - `list` returns hostname, status, DNS records, `cf_ssl_status` and `failure_reason`;
   - `add { hostname }`;
   - `recheck { id }`, rate limited to 1 per minute per domain;
   - `remove { id }`.
   - A member who is not an admin gets FORBIDDEN. Ids from another org get NOT_FOUND (RLS).
9. **Auth.** Active custom domains are verified org hosts, so T03's dynamic `trustedOrigins` and the T05 handoff accept them through `HostContext`. Add a test proving that a `pending` or `failed` domain is not trusted.
10. **`hasOpenSignup` follow-up (Q94).** Replace the `withOrgContext` read in `hasOpenSignup` with a definer function `careeros_org_open_signup(org_id) returns boolean`, following the same pattern, and keep T03's tests passing.
11. **No UI here.** T07 adds the settings screens. Add the oRPC contract only, plus OpenAPI regeneration if this surface is public (`pnpm docs:gen`).

## Tests

- **Integration** (real DB):
  - claim uniqueness across orgs, and against upstream `custom_domain` in both directions;
  - a concurrent double claim (two transactions) lets exactly one succeed;
  - `ownHosts` and org-pattern hosts are rejected;
  - the 5-domain cap;
  - RLS: org B cannot list, recheck or remove org A's domain;
  - the isolation registry passes;
  - `careeros_org_for_custom_host` returns only `active` rows.
- **Unit**, with the Cloudflare client mocked through injected fetch, no network:
  - the status machine through every transition, including the takeover guard (TXT missing 3 times leads to `failed` and no resolution) and the 7-day timeout;
  - removal retry when the Cloudflare delete fails;
  - "not configured" when env vars are missing;
  - the token never appears in logs: capture console output in the test.
- **Host resolution:** an active custom domain resolves to its org through T03's resolver; a `removing` one returns `unknown_org_host`.
- **`careeros_org_open_signup`:** correct value for open and invite-only orgs; PUBLIC cannot execute it.
- **Fuzz:** add the new procedures to the P1-Q03 and P1-Q10 inventories, with no cross-org leaks.

## Acceptance

All the tests above pass with the database configured and nothing skipped. Lint, format and boundaries are clean, and CI is fully green, e2e included. The live Cloudflare check happens on staging after P2-C01 and Stephen's owner action, not in CI.

## Out of scope

The settings UI (T07); per-org email domains; apex-domain flattening guidance beyond showing the records; wildcard custom domains.
