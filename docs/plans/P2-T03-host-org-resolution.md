# P2-T03: The request host decides the organization

**Status:** Approved (Opus, 2026-11-01). **Thread:** 1 Build. **Phase plan:** [P2-PHASE-PLAN.md](P2-PHASE-PLAN.md), decisions D2, D4, D5 (trusted-origin part) and D6.
**Branch:** `feat/P2-T03-host-org-resolution`. **Depends on:** P2-T01 (merged).

## Goal

A request to an organization's host acts in that organization and nowhere else. The platform root host keeps the Phase 1 behaviour. Custom domains (T06) plug into the same resolver later. Social and OIDC sign-in on org hosts is T05; this task only makes email and password, passkey and magic-link style sign-in work on org hosts.

## Definitions

- **Platform host:** the host of `APP_URL`, plus `APP_ALIAS_URL` if set. In development, also localhost and 127.0.0.1.
- **Org subdomain host:** matches `ORG_HOST_PATTERN`, a new env var.
  - Staging uses `{slug}-careeros.ayopa.co.ke`, production `{slug}.<base>`.
  - Exactly one `{slug}` placeholder, matching the org slug grammar `[a-z0-9-]{1,63}`, with no dots allowed in the slug.
  - Unset means the feature is off: every host behaves as in Phase 1.
- **Org custom domain host:** resolved by T06. In this task the resolver has a `customDomainOrg(hostname)` hook that returns `null`.
- **Host normalization:**
  - lower-case;
  - strip the port and any trailing dot;
  - IDN to punycode via `URL`;
  - reject anything that isn't a valid hostname.
  - Use the `Host` header. Use `X-Forwarded-Host` only when the new env var `TRUST_FORWARDED_HOST=true`. Document that the staging tunnel sets `Host` correctly, so the default is false.

## Requirements

1. **Env.** Add `ORG_HOST_PATTERN` and `TRUST_FORWARDED_HOST` to `packages/env/src/server.ts` with validation (exactly one `{slug}`, and the pattern must not equal the platform host). Also add them to `.env.example` and `.env.staging.example`, and to `turbo.json` pass-through, as CLAUDE.md requires for new env vars.
2. **Resolver** in `@careeros/tenancy`: `resolveHost(request): Promise<HostContext>`.
   - `HostContext` is one of:
     - `{ kind: "platform" }`
     - `{ kind: "org", organizationId, slug, via: "subdomain" | "custom" }`
     - `{ kind: "unknown" }`
   - A subdomain resolves through `careeros_public_branding_by_slug` (from T01). An unknown slug gives `unknown`.
   - Cache positive and negative results in-process for 60 seconds, capped at 10,000 entries. Bust the entry for an org when its slug changes, if a hook exists; otherwise the 60-second TTL is accepted.
   - Must not treat the upstream per-user resume custom domains (`custom_domain`, the Traefik provider) as org hosts. Those keep their existing public-resume-only behaviour. A hostname in `custom_domain` is never `kind: "org"`.
3. **Request plumbing.**
   - The Hono app resolves the host once per request and puts `HostContext` on the request context.
   - oRPC context (`packages/api/src/context.ts`) carries it into `protectedProcedure`.
   - Requests to an `unknown` host that matches `ORG_HOST_PATTERN` get a 404 HTML page from the SPA shell. API calls get 404 JSON. Other unknown hosts keep today's behaviour.
4. **Org resolution** (D4). Change `resolveOrgForAuthentication(authentication, host)`:
   - **Org host:**
     - The org is the host's org.
     - **Session:** the user must be a member (a `member` row) of the host org, otherwise throw `TenancyError("not_member_of_host_org")`. `protectedProcedure` maps that to `FORBIDDEN` with code `ORG_HOST_NOT_MEMBER`. The session's `activeOrganizationId` is ignored on org hosts.
     - **API key:** the key's `organization_id` must equal the host org, otherwise `FORBIDDEN`. A key without an org falls back to the oldest membership only on the platform host. On an org host it must be a member of the host org, and the request acts in the host org.
     - **OAuth bearer:** same as an org-less API key.
   - **Platform host:** the Phase 1 behaviour, unchanged.
   - Headers, query and body are never inputs; only the resolved host is.
   - MCP (`apps/server/src/mcp`) uses the same rules.
5. **Better Auth on org hosts.**
   - `trustedOrigins` becomes a function: the platform origins, plus the origin of the request host when that host resolves to `kind: "org"`. Use Better Auth's dynamic `trustedOrigins` support if the installed version has it. Otherwise use the closest equivalent hook, and log it as a question if neither exists.
   - Cookies stay host-only. Assert in a test that no `Domain=` attribute is set and that `crossSubDomainCookies` is off.
   - Better Auth `baseURL` stays `APP_URL`. Links in emails are T04's concern.
6. **Signup on org hosts** (D6).
   - **Open signup** (`organization_settings.open_signup` true): the new user becomes a `member` of the host org, and **no** personal org is created. The session's active org is the host org.
   - **Open signup off:** email signup on the org host is refused (`FORBIDDEN`, code `ORG_SIGNUP_CLOSED`), unless it carries a valid pending invitation to the host org for that email. That case follows the existing invitation flow.
   - **Platform host:** the existing D6 personal-org rule, unchanged.
   - Read the host from the Better Auth hook context's request. If a hook has no request, for example a server-side call, fall back to the platform behaviour.
7. **Web "join or switch" page.**
   - When an API call returns `ORG_HOST_NOT_MEMBER`, the SPA shows a page with the org's app name (via the public branding endpoint). It offers "Sign out" and, if the org has open signup, "Join this organization", which adds membership through a new protected endpoint. That endpoint is allowed only when the org has open signup and the user is not already a member.
   - Lingui macros for the strings. Mobile parity: the mobile app shows the same message and sign-out action when it gets that error.
8. **Tests.**
   - **Unit:** host normalization, pattern parsing, and the resolver against a fake lookup (platform, org, unknown, and a custom-resume host never treated as org).
   - **Integration, isolated database:**
     - a member of Org A on Org A's host acts in Org A;
     - the same session cookie on Org B's host is refused;
     - an API key bound to Org A is refused on Org B's host;
     - a key on the platform host behaves as before;
     - signup on an open org host joins that org with no personal org;
     - signup on a closed org host is refused, and allowed with an invitation;
     - signup on the platform host is unchanged.
   - **E2E:** do not add the host-isolation e2e. That is P2-Q01, which needs host routing in Playwright. Do make sure the existing e2e suite still passes with `ORG_HOST_PATTERN` unset, and with it set to a pattern no test host matches.
9. Mark upstream edits with `CAREEROS:` and list them in `docs/UPSTREAM_PATCHES.md`. Log open points in `docs/questions.md`, then stop that part.

## Acceptance

- careeros-ci is fully green, including the cross-org fuzz.
- With `ORG_HOST_PATTERN` unset, behaviour is byte-for-byte Phase 1. The existing tests prove this.
