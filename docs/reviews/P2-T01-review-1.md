# P2-T01 review 1

**Reviewer:** Opus, 2026-11-01. **PR:** [#46](https://github.com/KING-CYBERTON/careeros/pull/46). **Verdict:** Approved. Merge when CI is fully green.

## Checked

- **RLS.** Both tables have ENABLE and FORCE, `tenant_isolation`, `owner_access`, a backfill and `down.sql`, following the T09 pattern exactly.
- **Create-time trigger.** It is a definer function with a pinned search_path and EXECUTE revoked from PUBLIC. Triggers do not need the inserting role to hold EXECUTE, and the PR tests inserts as `careeros_app`.
- **Public lookups.** They return only the public fields. `email_from_name`, `updated_by` and the settings are never exposed. They are granted only to `careeros_app`.
- **Role check.** It reads `member.role` server-side and splits Better Auth's comma-separated roles. It runs before an upload body is decoded.
- **Asset route** (`GET /api/branding-assets/:org/:file`):
  - strict regexes on both path parts;
  - serves only the key the branding row currently points at, so no traversal or enumeration of old keys;
  - `nosniff`, plus a sandboxing CSP for SVG.
- **SVG.** Sanitized with an allowlist. Scripts, foreignObject, event handlers, entities and external, `javascript:` or `data:` references are refused. Combined with the CSP and sandbox, this is acceptable.
- **Replacing an upload** enqueues cleanup of the old key, owned by the org, in the same transaction.

## Answers

- **Q76:** accepted. The asset route belongs in T01 because T01 owns the assets. T02 and T03 consume it.
- **Q77:** add `DELETE /branding/logo` and `DELETE /branding/favicon` in **T07**, together with the UI that needs them.
- **Q78:** accepted. `rowPerOrganization` is the right model for one-row-per-org tables, and the check still proves Org B sees no other org's row.
- **Q79:** the Phase 3 super-admin "suspend organization" spec adds `organization.status` and the filter in both lookups. Noted for the Phase 3 plan.

## Follow-ups

None blocking.
