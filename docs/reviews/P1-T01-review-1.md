# P1-T01 review 1

**PR:** #17 · **Spec:** docs/plans/P1-T01-org-plugin.md · **Reviewer:** Opus · **Date:** 2026-10-31

## Verdict: Approved, merge after green careeros-ci.

## History

- First push: spec item 6 referenced a "global allow-list" that did not exist in `@careeros/isolation-testing` (Opus spec error). Sonnet stopped and asked (Q7). Opus decided the design: `tenancyAllowList` with a mandatory reason, coverage check skips allow-listed tables, fails on registered+allow-listed or empty reason, and now also requires `FORCE ROW LEVEL SECURITY` on registered tables (P1 plan D4).
- CI `static` failed on `turbo boundaries` (`pg` not a dependency of `packages/auth`); fixed with `catalog:` devDependencies.

## Checks

| Item                                                                                                | Result                        |
| --------------------------------------------------------------------------------------------------- | ----------------------------- |
| Plugin roles owner/admin/member; invitations 7 days; extra member fields                            | ✅                            |
| Schema in new `organization.ts`; `session.active_organization_id`; generated migration              | ✅                            |
| Integration tests: owner on create, invite→accept with `invitedBy`, active org, non-member rejected | ✅ 63 auth tests pass locally |
| Isolation allow-list + FORCE rule with self-tests                                                   | ✅ 22 tests pass locally      |
| UPSTREAM_PATCHES rows for all six upstream files                                                    | ✅                            |

## Accepted deviations

- `invitedBy` FK kept in DB, not declared as a plugin `references` (Better Auth join ambiguity).
- `authOrganizationRelations` wired into the db client (required by `joins: true`).
- Invitation email template with `/auth/accept-invitation/{id}` (path to be built in P1-T03).
- Accepting an invitation requires a verified email (plugin default; fine for B2B).
- `tenantTables` excludes allow-listed tables.

## Findings

None blocking. Note for P1-T03: the accept-invitation page must exist before invitations are user-visible.
