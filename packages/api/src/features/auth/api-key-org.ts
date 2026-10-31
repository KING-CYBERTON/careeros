import { resolveOrgForAuthentication, type AuthenticationOrgSource } from "@careeros/tenancy";
import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import { apikey } from "@reactive-resume/db/schema";

// CareerOS (P1-T03, Q9): API keys carry the organization they were created in.

/**
 * The organization a new API key belongs to: the caller's active organization after a membership check, or `null`
 * when the session has none (such keys are refused once `ORG_CONTEXT_REQUIRED` is true). An active organization the
 * user no longer belongs to is refused rather than stored.
 */
export async function organizationForNewApiKey(authentication: AuthenticationOrgSource): Promise<string | null> {
	if (!authentication.activeOrganizationId) return null;
	const organizationId = await resolveOrgForAuthentication(authentication);
	if (!organizationId)
		throw new ORPCError("FORBIDDEN", {
			message: "You are no longer a member of your active organization. Switch organization and try again.",
		});
	return organizationId;
}

/** Stores `organization_id` on a key just created for `userId`. */
export async function setApiKeyOrganization(keyId: string, userId: string, organizationId: string): Promise<void> {
	await db
		.update(apikey)
		.set({ organizationId })
		.where(and(eq(apikey.id, keyId), eq(apikey.referenceId, userId)));
}
