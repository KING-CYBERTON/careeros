# P1-T01 — Better Auth organization plugin

**Status:** Approved (Opus, 2026-10-31) · **Thread:** 1 Build · **Phase plan:** [../P1-PHASE-PLAN.md](../P1-PHASE-PLAN.md) (D1, D2) · **Depends on:** — (can run in parallel with P1-C01)

## Goal

Organizations, members, invitations and an active organization on the session exist, using Better Auth's `organization` plugin, with no behaviour change yet for existing features (tenant scoping comes in P1-T02/T04+).

## Changes

1. `packages/auth/src/config.ts`: add `organization()` from `better-auth/plugins` to `plugins` (after `admin()`). Options:
   - roles: plugin defaults `owner`, `admin`, `member`; creator role `owner`.
   - `allowUserToCreateOrganization: true` (D6 interim; P1-T03 decides when it is used).
   - invitations: expire after 7 days; `sendInvitationEmail` uses the existing email package the same way upstream sends other auth emails (if no email transport is configured it logs, as upstream does).
   - extra member fields per D1: `cohortId` (text, nullable, no FK yet) and `invitedBy` (text, nullable, FK `user.id` on delete set null) via the plugin's `schema.member.additionalFields`.
   - Mark the edit with `// CAREEROS:` and add an UPSTREAM_PATCHES row.
2. Schema: add the plugin tables to `packages/db/src/schema/` in a **new file** `organization.ts` (`organization`, `member`, `invitation`) plus `active_organization_id` on `session` (edit `auth.ts` minimally with a `// CAREEROS:` comment). Text ids, same conventions as `auth.ts`. Indexes: `member (organization_id, user_id)` unique, `member (user_id)`, `invitation (organization_id, email)`. Export from the schema index.
3. `pnpm db:generate` → one new migration. Do not hand-edit after generation except to add nothing; if generation needs a fix, change the schema and regenerate.
4. Client: export the plugin's client (`organizationClient`) from wherever upstream builds its Better Auth client in `apps/web` so later tasks can call it. No UI in this task.
5. Types: update `packages/auth/src/types.ts` if the session/user types need the new fields.
6. Allow-list: add `organization`, `member`, `invitation` to the isolation **global allow-list** with the reason "Better Auth organization plugin; access controlled by Better Auth membership checks" (these tables define tenancy, they are not tenant-scoped data).

## Tests

- Unit (packages/auth): plugin registered; roles exactly `owner/admin/member`; invitation expiry 7 days.
- Integration (real DB, existing `COVER_LETTER_TEST_DATABASE_URL` pattern): create org → creator is `owner`; invite → accept → member row with `invitedBy`; set active org → session row has `active_organization_id`; a non-member cannot set that org active (expect error).
- Migration test: the upstream `migrations.integration.test.ts` still passes.

## Out of scope

Tenancy middleware, RLS, signup behaviour, UI, cohorts table.

## Acceptance

- CI green; new migration present and generated; UPSTREAM_PATCHES rows for `packages/auth/src/config.ts`, `packages/db/src/schema/auth.ts` and any other upstream file.
- `pnpm exec turbo boundaries` clean (CI static job).
