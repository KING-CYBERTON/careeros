import { getQuotaState } from "@careeros/ai-metering";
import { currentOrgId } from "@careeros/tenancy";
import { platformAiAvailable } from "../features/ai/platform";

// CAREEROS (P3-T03, phase plan D5): the 80% warning. After an AI request, when the organization's pooled credits are at
// 80% or more, the response carries this header. The web and mobile clients read it and show the message once per
// session. It never blocks anything and never fails the request.

export const AI_QUOTA_WARNING_HEADER = "x-ai-quota-warning";

export async function addAiQuotaWarning(context: { resHeaders?: Headers | undefined }): Promise<void> {
	try {
		const organizationId = currentOrgId();
		if (!organizationId || !context.resHeaders) return;
		// Organizations without platform AI have no pool to warn about.
		if (!(await platformAiAvailable(organizationId))) return;
		if ((await getQuotaState(organizationId)).warning) context.resHeaders.set(AI_QUOTA_WARNING_HEADER, "true");
	} catch (error) {
		console.error("ai quota warning failed:", error instanceof Error ? error.message : "unknown");
	}
}
