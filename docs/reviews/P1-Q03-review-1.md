# P1-Q03 review 1 (Opus, 2026-11-01)

Branch: test/P1-Q03-cross-org-id-fuzz
Verdict: approve, subject to fully green CI including e2e.

## Checked

- The inventory comes from the generated OpenAPI spec, and a vitest check walks the router object to confirm every procedure maps to an operation. Nothing is hand-maintained, so new procedures cannot slip through.
- Coverage:
  - 157 id-taking operations are fuzzed, giving 332 requests across cookie and API-key auth.
  - 64 operations are skipped, each because it takes no tenant id. No-id list routes are still swept for Org A data.
  - 106 MCP tools that take an id are also fuzzed.
- Assertions are strict:
  - 404, or an empty 200 for list and bulk calls. The only 400 allowed is lane reorder, per the T06 review.
  - The two slug-check exceptions answer identically for an unknown id, so they reveal nothing.
  - A body scan for Org A's markers.
  - A before/after snapshot of Org A, plus per-table row digests across every `organization_id` table.
- Controls prove the scanner sees Org A's data when called as A. The mutation check (swapping in A's cookie) fails the spec as it should.
- No leaks were found in the local run.

## Follow-ups (not blocking)

- F1: custom-domain routes cannot be reached in the e2e environment (feature disabled). The T09 integration tests cover them. When the staging e2e profile enables custom domains, add them to the fuzz.
- F2: add an MCP control call made as A, to prove the MCP scanner as well.
