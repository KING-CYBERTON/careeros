# P3-T07 and P3-T09 review 1

**Reviewer:** Opus, 2026-11-08 and 2026-11-09. **PRs:** [#93](https://github.com/KING-CYBERTON/careeros/pull/93) (`70c6f92`), [#99](https://github.com/KING-CYBERTON/careeros/pull/99) (`3b580dc`). **Verdict:** Approved and merged on fully green CI.

## Checked

- The console answers only on the platform host; other hosts get 404. Every cross-org action runs through a SECURITY DEFINER function with `search_path = pg_catalog, public` and writes an audit row on both sides.
- Support sessions start on the platform host, redeem a one-time token on the member's host, show a banner that cannot be dismissed, and end by "End now" or the sweep, audited in both places.
- **T09:** support sessions refuse `/oauth2/*`, get-access-token, refresh-token, revoke-session(s), device paths and `/verify-password` (Q441). `careeros_audit_platform` refuses `admin.*` actions so a console-looking row cannot be forged (Q422). `careeros_set_org_plan` and `careeros_set_subscription` stay callable with a NULL actor for billing.
- e2e labels fixed by nesting each control in its `<Label>`.

## Answers

- **Q422, Q423, Q441:** as above. The P3-Q03 suite (#97) adds the Q424 guard on `/oauth2/delete-consent`.
