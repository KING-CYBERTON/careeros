/**
 * CAREEROS: whether a request without an organization is refused. `true` since P1-T04: the resume tables have
 * row-level security, so a request without an organization could neither read nor write them, and every user now has
 * an organization (signup hook, D6; backfill migration, D7). A code constant, not an environment variable.
 */
export const ORG_CONTEXT_REQUIRED = true;
export { captureOrgScope, currentOrgId, requireOrgId, withOrgContext } from "./context";
export { TenancyError, type TenancyErrorCode } from "./errors";
export {
	resolveOrgForAuthentication,
	resolveOrgForRequest,
	type ApiKeyOrgSource,
	type AuthenticationOrgSource,
	type ResolveOrgInput,
	type SessionOrgSource,
} from "./resolve";
export {
	bustHostCache,
	createHostResolver,
	currentHost,
	hostTrustedOrigins,
	INACTIVE_ORG_HOST,
	lookupOrgByCustomHost,
	lookupOrgBySlug,
	matchOrgHost,
	normalizeHostname,
	orgCustomDomainsEnabled,
	parseHost,
	parseOrgHostPattern,
	platformHostsFromEnv,
	resolveHost,
	runWithHost,
	setHostResolverForTesting,
	type HostContext,
	type HostOrg,
	type HostResolver,
	type HostResolverConfig,
	type OrgHostPattern,
} from "./host";
