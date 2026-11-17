import { createDefaultApplicationLanes } from "@reactive-resume/schema/applications/lanes";
export { MAX_APPLICATION_LANES } from "@reactive-resume/schema/applications/lanes";

/** Shared by application writes and guest linking; matches the additive migration's deterministic IDs. */
export function createDefaultOwnedApplicationLanes(userId: string, organizationId: string) {
	return createDefaultApplicationLanes().map((lane) => ({
		...lane,
		id: `application-lane:${userId}:${lane.category}`,
		// CAREEROS (P1-T06): the default lanes of every organization the user belongs to
		organizationId,
		userId,
	}));
}
