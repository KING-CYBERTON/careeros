# @careeros/tenancy

Organization scoping for CareerOS: `withOrgContext`, `currentOrgId` and the request-to-organization resolvers.

## P1-Q01 results

`src/tenancy.rls.integration.test.ts` runs as `careeros_app` (asserted: not superuser, no BYPASSRLS) against a
temporary probe table with the D4 policy and FORCE RLS, and drives `withOrgContext` with a pool `max` of 5.

- Peak `waitingCount`: 299 (all 300 calls are issued at once; the pool never exceeded `totalCount` 5).
- Wall time of the 300-call run: about 0.6 s (614 ms on the reference run); the 10% error run took about 0.64 s.
- Error run: 39 of 300 calls threw at random points; all survivors saw only their own org, and a further 50 calls succeeded.
- Pass streak: 5 consecutive runs of `pnpm --filter @careeros/tenancy test`, all green.
