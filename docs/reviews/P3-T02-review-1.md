# P3-T02 review 1

**Reviewer:** Opus, 2026-11-03 to 2026-11-08. **PR:** [#76](https://github.com/KING-CYBERTON/careeros/pull/76), follow-up [#88](https://github.com/KING-CYBERTON/careeros/pull/88). **Verdict:** Approved after one round of changes. Merged on fully green CI, e2e included.

## Checked

- Seat limits are checked in the Better Auth organization hooks (invite, accept, add member, role change), the organization-host join, open sign-up on an org host and the personal organization. A pending invitation holds a seat and an accepted one is a swap.
- **Changes requested (blocker, fixed):** the first version checked the limit and then inserted with nothing in between, so simultaneous joins could go over the limit. Now a BEFORE INSERT trigger on `member` and pending `invitation` rows takes a per-organization advisory lock, mirrors `effectiveSeatLimit`, and raises SQLSTATE `CS001`, which every surface maps to `SEAT_LIMIT_REACHED`. Concurrency tests show exactly one of eight succeeds.
- `protectedProcedure` refuses writes of a suspended organization with `ORG_SUSPENDED` outside `SUSPENDED_ORG_ALLOWED_WRITES`, for sessions, API keys and MCP. The procedure inventory test fails on any new non-GET procedure that is neither guarded nor listed.
- `requireFeature(key)` replaces the P4-T01 discovery gate and guards custom domains.
- #88 fixed a flaky race test: the test helper shared one credential variable across concurrent requests. The service was correct; 30 of 30 looped runs passed after the fix.

## Answers

- **Q210:** accepted. A team needs a paid plan to invite; the personal plan stays at one seat.
- **Q211:** accepted. P3-T04 and P5-T02 added their entries (billing, clipper revoke).
- **Q212, Q213, Q214:** accepted.
- **Q215:** accepted.
- **Q216:** accepted. Production runs the app as `careeros_app`, so the trigger always applies there.
- **Q217:** accepted. Both gaps leave the member count within the limit.
