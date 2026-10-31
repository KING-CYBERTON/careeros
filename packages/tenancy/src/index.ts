/**
 * CAREEROS: whether a request without an organization is refused. `false` while no table has row-level security (P1-T02):
 * a request with an organization runs in `withOrgContext`, one without runs unscoped. P1-T04 sets this to `true` in the
 * same PR that adds the first RLS policy and the D7 backfill. A code constant, not an environment variable.
 */
export const ORG_CONTEXT_REQUIRED = false;
export { captureOrgScope, currentOrgId, withOrgContext } from "./context";
export { TenancyError, type TenancyErrorCode } from "./errors";
export {
	resolveOrgForAuthentication,
	resolveOrgForRequest,
	type ApiKeyOrgSource,
	type AuthenticationOrgSource,
	type ResolveOrgInput,
	type SessionOrgSource,
} from "./resolve";
