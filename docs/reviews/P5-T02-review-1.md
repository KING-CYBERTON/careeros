# P5-T02 review 1

**Reviewer:** Opus, 2026-11-03 to 2026-11-08. **PR:** [#78](https://github.com/KING-CYBERTON/careeros/pull/78). **Verdict:** Approved. Merge on fully green CI, e2e included.

## Checked

- Device authorization only on an organization host, with the fixed client id `careeros-job-clipper`. `/device/token` (a full session) is replaced by a clipper token endpoint.
- Clipper tokens are stored as SHA-256 hashes, bound to the organization of the host they were issued on, and refused (401) on the platform host and on any host of another organization, including custom domains. `resolveOrgForAuthentication` fails closed for clipper tokens.
- The allow-list (`clipper.whoami`, `branding.publicForHost`, `applications.create`) is enforced once in `publicProcedure`; every other procedure answers 403, and MCP, uploads and PDF routes never resolve a clipper token.
- Revocation on web and mobile; member removal, ban and password reset revoke tokens.
- CORS for extension origins only on the four sign-in and whoami routes, echoing the origin, never credentials. This fixed the first e2e run.

## Answers

- **Q261 (renumbered from Q280, which P6-T01 owns):** accepted.
- **Q270 to Q279:** accepted as built. Q274: keep the password-reset revocation.
- **Q293:** accepted. Extension sign-in must not depend on an optional host permission.
- **Merge note:** `clipper.revokeToken` is on the suspended-organization allow-list (account-level).
