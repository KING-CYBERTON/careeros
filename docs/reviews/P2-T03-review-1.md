# P2-T03 review 1

**Reviewer:** Opus, 2026-11-01. **PR:** [#48](https://github.com/KING-CYBERTON/careeros/pull/48). **Verdict:** Approved. Merge after it is synced with develop (T08) and CI is fully green.

## Checked

- **Org host rules.** On an org host the org is always the host's.
  - **Session:** needs a `member` row. The active org is ignored.
  - **API key:** a key bound to another org is refused (`key_org_mismatch`). An org-less key or bearer token acts in the host org only if its owner is a member.
  - **Unknown org-shaped hosts:** fail closed (`unknown_org_host`). They never fall back to the platform rules.
- **Platform host.** Phase 1 behaviour, unchanged. With `ORG_HOST_PATTERN` unset, there is no database access and every host is the platform.
- **Host input.** `Host` only. `X-Forwarded-Host` is used only behind `TRUST_FORWARDED_HOST`, which defaults off. Normalization covers case, port, trailing dot and IDN.
- **Upstream resume domains.** The per-user resume custom domains (`custom_domain`) are never treated as org hosts.
- **Better Auth 1.7.12.**
  - `trustedOrigins(request)` adds only the request's own origin, and only when it resolves to an org.
  - Cookies are host-only, asserted in a test.
- **Sign-up.** Closed hosts refuse new accounts unless the person has a valid pending invitation. Open hosts join the org with no personal org.
- **Join endpoint.** Browser session only, open signup only, and race-safe on the unique member index.
- **Integration tests on isolated databases, as `careeros_app`.** Session refused on the wrong host, key mismatch, platform unchanged, and the sign-up paths.

## Answers

- **Q86:** accepted.
- **Q87:** keep fail-fast. Revisit with §15.1.
- **Q88:** accepted. P2-Q01's e2e covers the real handler's origin check.
- **Q89:** accepted.
- **Q90:** accepted.
- **Q91:** accepted. Mobile join comes in T07.
- **Q92:** T02 adds the view.
- **Q93:** accepted with the 60 s TTL.

## Findings

- **L1 (Low):** `hasOpenSignup` opens an org context for a non-member to read one boolean. It is server-chosen and narrow. Follow-up in T06: a definer function `careeros_org_open_signup` (recorded as Q94).

## CI round (2026-11-01)

- The first CI run failed in unit (api) and unit (rest). The shared `vitest.org.setup.ts` mocks of `@careeros/tenancy` predated `hostTrustedOrigins`, and the database integration suites skip locally without a database, so they did not catch it.
- Fix f141481f5: both setups now spread `importOriginal()`, so exports added later cannot go missing. No test was weakened. Sonnet re-ran with a database configured, and nothing was skipped.
- Opus merged develop to resolve a `docs/questions.md` conflict (af8203778).
- Result: CI is fully green, e2e included. **Approved and merged.**
