# P1-T09 review 1 (Opus, 2026-11-01)

Branch: feature/P1-T09-remaining-rls (through fbd2e6d17)
Verdict: changes requested (one item), then approve, subject to fully green CI.

## Checked

- Migration 20261101083301_remaining_rls:
  - The keys follow D11. The verified-hostname index stays global.
  - `storage_cleanup_job` has no FK on purpose, and the `careeros_orphan` sentinel is documented.
  - FORCE RLS, with `tenant_isolation` and `owner_access`.
  - `down.sql` refuses to run across orgs.
- Definer functions: pinned search_path, EXECUTE revoked from PUBLIC and granted to `careeros_app` only. The public functions return only what the public path needs.
- Workers: the D9 list runs, then each job runs inside `withOrgContext`. Storage and DNS work happen outside the DB scope. Failures stay isolated.
- The coverage check (`runUnclassifiedTablesCheck`) is a good addition.

## Required

- **H1 (careeros_release_domain_claims).** The function only checks that `keep_org` is the current org. It does not check that the keeper actually holds a verified claim on that hostname. A server bug or a mistaken call could un-verify other orgs' domains with no DNS proof, and that is a cross-org write.
  - Fix: before the UPDATE, require `EXISTS (SELECT 1 FROM custom_domain WHERE organization_id = keep_org AND user_id = keep_user AND hostname = for_hostname AND verified_at IS NOT NULL)`, and raise otherwise. The caller must verify its own row first, in the same transaction, and only then release the others.
  - Add a test: calling it without a verified own row raises, and leaves the other claimants verified.

## Decisions on open questions

- **Q60:** the optional filters are accepted.
- **Q61:** the definer trigger is accepted. Filing under the session's org, or `careeros_orphan`, is fine because the account-level job covers every org's uploads for that user.
- **Q62:** the extra functions are accepted, with H1 applied. The Traefik router rename is accepted. Confirm the staging Traefik config does not pin the old router names.
- **Q63:** accepted. Guest domains and web connections are not moved, as before.
- **Q64:** T07's scheduler runs each job inside `withOrgContext`, so `webAccessService.resolve` will see the key once both are merged. Verify this with a test after merging T07.
- **Q65:** accepted. The pending list is updated as T07 and T08 land.

## Merge order

T07 (#33) merges first. Then T09 merges develop:

- re-chain `snapshot.json` after T07's;
- remove the career tables from `pendingTenantTables`;
- add the Q64 test;
- re-run the suites.

## Re-review (Opus, 2026-11-01)

- H1 is accepted with a deviation. A partial unique index cannot be deferred, so the function now swaps atomically: it requires the current org and a claim row for (org, user, hostname), un-verifies the other claimants, verifies the keeper, and raises unless the keeper ends up verified. A call with no claim raises and changes nothing, and a test covers that. DNS proof is still enforced in `customDomainService.verify`, which is the only caller. A server bug could misuse the function before or after this change, so the deviation adds no new exposure, and it narrows the call to the caller's own org and claim.
- Develop (T07) is merged in, the snapshot is re-chained, the career tables are removed from the pending list, and the Q64 test has been added.
- Traefik: no infra file pins `custom-domain-<userId>` router names. The routers are generated dynamically from the provider endpoint.
- Verdict: approve, subject to fully green CI.
