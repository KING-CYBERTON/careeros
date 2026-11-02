/**
 * Every discovery procedure requires the plan feature `job_discovery` (P4-T01 requirement 8).
 *
 * TODO(P3-T01, P3-T02): replace this body with `requireFeature("job_discovery")` from the entitlements work. Neither
 * `getEntitlements` nor `requireFeature` exists on `develop` yet, so there is nothing to check against; until it lands
 * the gate lets everything through. Logged as Q221. Keep the call in `router.ts` so the swap is one line.
 */
export function requireJobDiscoveryFeature(): void {
	// Intentionally empty until P3 merges.
}
