# P2-T01: Organization branding and settings (data, RLS, API)

**Status:** Approved (Opus, 2026-11-01). **Thread:** 1 Build. **Phase plan:** [P2-PHASE-PLAN.md](P2-PHASE-PLAN.md), decisions D1, D6 and D11.
**Branch:** `feat/P2-T01-branding-tables`

## Goal

Give each organization one branding row and one settings row. Both are tenant-scoped under RLS and editable by org owners and admins. A host-free public lookup returns only public branding fields, by org id or slug. Host resolution comes in T03, and HTML injection in T02.

## Requirements

1. **Schema** in `packages/db/src/schema/organization.ts`, or a new `branding.ts` exported from the schema index:
   - `organization_branding`:
     - `organization_id` is both PK and FK to `organization.id`, ON DELETE CASCADE.
     - `app_name text` (nullable, which means use the platform default).
     - `logo_storage_key`, `favicon_storage_key` (nullable).
     - `primary_color` and `secondary_color`: nullable `#rrggbb`, enforced by a CHECK constraint.
     - `font`: nullable, CHECK that it is in a fixed list defined in code and mirrored in the migration (use the fonts `packages/fonts` already ships for the UI; pick 6 to 10 and name them in the PR).
     - `email_from_name`, `support_url`, `terms_url`, `privacy_url`: nullable. The URLs must be https, enforced by a CHECK on the `https://` prefix and again in Zod.
     - `updated_at`, `updated_by` (FK to user, ON DELETE SET NULL).
     - No `custom_css` column yet (D11).
   - `organization_settings`:
     - `organization_id` is both PK and FK, ON DELETE CASCADE.
     - `open_signup boolean not null default false`.
     - `updated_at`.
2. **Migration** via drizzle-kit `generate`, then hand-add the RLS block, following the T09 pattern exactly:
   - ENABLE and FORCE RLS, the `tenant_isolation` policy and `owner_access`.
   - Backfill one default row per existing organization, with all fields null and `open_signup` false.
   - Ship a `down.sql`.
   - Register both tables in the isolation registry (`@careeros/isolation-testing`). The unclassified-tables check must stay green.
   - New orgs get their rows created at org creation. Use the organization plugin's `afterCreateOrganization` hook, inside the same org context, or an AFTER INSERT trigger on `organization` written as a definer function. Pick one, say why in the PR, and test it.
3. **Public lookup.**
   - Add `careeros_public_branding(org_id text)` and `careeros_public_branding_by_slug(slug text)`.
   - Both are SECURITY DEFINER with `search_path = pg_catalog, public`. EXECUTE is revoked from PUBLIC and granted to `careeros_app`, using the conditional-grant pattern.
   - They return only `organization_id`, `slug`, `app_name`, the two storage keys, the colours, `font` and the three legal URLs.
   - They never return `email_from_name`, `updated_by` or settings.
   - An org that is suspended (if a status exists) or unknown returns no row.
4. **API**, a new feature `packages/api/src/features/branding/`:
   - `branding.get`: protected, current org, any member.
   - `branding.update`: protected, owner or admin of the current org. Membership role comes from `member`, not the client. Zod validates the colour, font and https URLs.
   - `branding.uploadLogo` and `branding.uploadFavicon`:
     - Reuse the existing storage upload helpers.
     - Store under `orgs/<org_id>/branding/`.
     - Logo: PNG, SVG or WebP, at most 512 KB. Favicon: PNG or ICO, at most 128 KB.
     - Sanitize SVG, or reject it if no sanitizer already exists in the repo. Say which in the PR.
     - Replacing an upload enqueues cleanup of the old key through the existing storage cleanup.
   - `branding.publicBySlug`: public, no session. It calls the slug lookup and returns signed or public URLs for the assets, using the same approach public resume images use.
   - `settings.get` and `settings.update`: owner or admin only.
   - Expose the routes through OpenAPI like the other features, and run `pnpm docs:gen` if the spec is checked in.
5. **Tests.**
   - Unit tests for the Zod schemas.
   - An integration test on an isolated database (`createIsolatedTestDatabase`):
     - RLS (Org B sees zero rows; insert with the wrong org fails);
     - the role check (a `member` cannot update; an `admin` can);
     - the backfill and create-time rows;
     - the public lookup returns only public fields;
     - an upload type or size outside the limits is rejected.
   - Add the new id-taking procedures to the cross-org fuzz inventory. They are picked up automatically, so confirm the inventory test stays green.
6. **No UI** in this task (that is T07). No HTML injection (T02). No host logic (T03).
7. Mark upstream edits with `CAREEROS:` comments and list them in `docs/UPSTREAM_PATCHES.md`. Log anything this spec does not settle in docs/questions.md, then stop that part.

## Acceptance

- careeros-ci is fully green: static, unit and e2e. The inventory and unclassified-tables checks pass.
- The migration applies on a fresh database, and `down.sql` reverts it.
