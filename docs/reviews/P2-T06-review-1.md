# P2-T06 review 1

**PR:** #53 · **Reviewer:** Opus · **Date:** 2026-11-01 · **Focus:** domain takeover, cross-org claims, SSRF, secrets.

## Round 1 findings, both fixed in 066c1d1b2

- **M1 (Medium): squatting through unverified claims.** An unverified personal or org claim blocked every other owner, so anyone could block an org's domain without controlling it.
  - **Fix:** uniqueness now applies only to proven rows: org domains in `verified`, `active` or `removing`, and personal domains with `verified_at`. The first to verify wins under the per-hostname advisory lock, and a late claimant goes to `failed` with `hostname_taken`.
- **M2 (Medium): direct INSERT bypass.** `careeros_app` keeps INSERT on `organization_domain`, so a raw insert skipped the cross-table check in the claim function.
  - **Fix:** a BEFORE INSERT OR UPDATE trigger, `careeros_organization_domain_guard`, enforces the same rule under the same lock. A partial unique index on proven statuses is the last backstop.

## Checked

- **Resolution:** only `active` domains resolve, and held non-active hosts fail closed with 404.
- **Takeover guard:** 3 consecutive missing TXT results take a domain out of `active`. DNS errors count as unknown, not missing.
- **SSRF:** DNS uses `node:dns/promises` only. The Cloudflare client uses `redirect: "error"`, a 10 s timeout and retries GETs only.
- **Secrets:** errors carry only the status and numeric codes. A captured-console test with a token-echoing fake found no leaks. Env vars are placeholders only.
- **Q94:** `careeros_org_open_signup` replaces the org-context read.
- **Tests:** 68 org-domain tests, including real concurrent transactions and a raw insert as `careeros_app`. Run with a database, 0 skipped.
- Opus merged develop (P2-T04), resolving docs-only conflicts. `tsc` is clean for tenancy, auth, api and server.

## Answers

Q120 to Q124 are recorded in docs/questions.md.

## Verdict

Approved, to merge on fully green CI, e2e and the extended fuzz included.
