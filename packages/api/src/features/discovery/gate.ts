import { getEntitlements } from "@careeros/billing";
import { requireOrgId } from "@careeros/tenancy";
import { ORPCError } from "@orpc/server";

/**
 * Every discovery procedure requires the plan feature `job_discovery` (P4-T01 requirement 8). The answer comes from
 * `getEntitlements` for the current organization, resolved in the D4 order (organization flag, plan, global flag,
 * default off), so an organization without the feature is refused with FORBIDDEN and `data.code` `FEATURE_NOT_IN_PLAN`
 * (the code P3-T02 defines for `requireFeature`). Q221.
 *
 * TODO(P3-T02): replace this body with `requireFeature("job_discovery")`. Keep the call in `router.ts` so the swap is
 * one line.
 */
export async function requireJobDiscoveryFeature(): Promise<void> {
	const entitlements = await getEntitlements(requireOrgId());
	if (entitlements.features.job_discovery !== true) {
		throw new ORPCError("FORBIDDEN", {
			message: "Job discovery is not included in your organization's plan.",
			data: { code: "FEATURE_NOT_IN_PLAN", feature: "job_discovery" },
		});
	}
}
