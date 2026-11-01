# P1-Q10 review 1

**Reviewer:** Opus, 2026-11-01. **PR:** [#42](https://github.com/KING-CYBERTON/careeros/pull/42). **Verdict:** Approved and merged after CI was fully green (e2e 64 passed).

## Results in CI

- **Organization endpoints.** The running instance publishes 22 organization endpoints.
  - 19 are attacked with 39 requests.
  - 3 are skipped with the valid reason: create, list and get-active-member. The two GETs are still swept for leaks.
  - `add-member` is server-only and is probed anyway.
  - No leaks were found, and Org A is unchanged in both the API and table snapshots.
- **Control reads.** The same reads made as A succeed, and the scanner flags A's values in them. So the refusals the fuzz sees are real refusals, not malformed requests.
- **Active org.** A refused read clears B's active organization, which is Better Auth's behaviour. It is never set to A. After B selects its own org again, a resume B creates lands in Org B. **Accepted:** clearing the active org fails closed.
- **API keys.** Both creation paths answered 200: 2 new keys, 0 bound to A, 1 bound to B and 1 unbound. The requested `organizationId` for an org B is not in is never honoured.
- **MCP control call (Q03 F2).** Called as A with A's own key and ids, it returns data the scanner flags. The first run tripped the "Org A unchanged" check, because using A's key updates the `apikey` usage columns. Fixed by running the control call before the baseline snapshot. No column was dropped from the snapshot.

## Notes

- `check-slug` reveals whether a slug is taken. That is by design, because slug uniqueness needs it. Low; no action.
- This closes M1 of the Phase 1 exit security review, which completes the sign-off.
