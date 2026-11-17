# P3-T04 review 1

**Reviewer:** Opus, 2026-11-03 to 2026-11-08. **PR:** [#77](https://github.com/KING-CYBERTON/careeros/pull/77). **Verdict:** Approved after one round of changes. Merged on fully green CI, e2e included.

## Checked

- Provider interface with the fake and manual providers, one subscription state machine, idempotent event intake (`billing_event`, unique per provider event, no app-role access), trials and grace, and the 15-minute job under a per-organization advisory lock.
- The webhook route is platform-host only, rate limited, capped at 256 KB, and verifies the signature before touching the database. Logs never hold a payload, header or signature.
- Billing write procedures are owner only and are on the suspended-organization allow-list, so an owner can pay to lift a suspension.

## Changes requested (fixed)

1. **Security:** `careeros_record_manual_payment` was callable by the app role with no caller check. It now raises unless the actor is a non-banned user with role `admin`; tests show nothing is written otherwise. P3-T07 adds the 2FA and host checks.
2. Question Q250 collided with P3-T03 and was renumbered Q260.

## Answers

- **Q240:** no opt-in flag for the fake provider in production builds. The server integration flow test stands in for the e2e smoke; P3-T05 adds e2e against the real provider's sandbox.
- **Q241:** accepted as built. A personal-workspace marker is a P3-T01 follow-up (backlog).
- **Q242:** resolved; the billing paths are in `SUSPENDED_ORG_ALLOWED_WRITES`.
- **Q243 to Q249, Q260:** accepted.
