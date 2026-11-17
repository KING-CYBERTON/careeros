import { useQuery } from "@tanstack/react-query";
import { useMembers } from "@/features/organization/queries";
import { orpc } from "@/libs/orpc/client";

// CAREEROS (P3-T06): data hooks for billing. Every call is for the session's own organization; none passes an id.

/** `billing.get`: owners and admins only (the server answers FORBIDDEN to a member). */
export function useBilling(options: { enabled?: boolean; refetchInterval?: number | false } = {}) {
	return useQuery({
		...orpc.billing.get.queryOptions({ input: undefined }),
		retry: false,
		enabled: options.enabled ?? true,
		refetchInterval: options.refetchInterval ?? false,
	});
}

export function useInvoices(enabled = true) {
	return useQuery({ ...orpc.billing.invoices.queryOptions({ input: undefined }), retry: false, enabled });
}

/** The pooled AI credits of the period, for owners and admins. */
export function useAiCredits(enabled = true) {
	return useQuery({ ...orpc.aiUsage.summary.queryOptions({ input: undefined }), retry: false, enabled });
}

export type OrganizationRole = "owner" | "admin" | "member" | "unknown";

/** The signed-in user's role in the active organization. Shows and hides UI only; the API checks again. */
export function useOrganizationRole(): OrganizationRole {
	const { data } = useMembers();
	const roles = data?.me?.role.split(",").map((value) => value.trim()) ?? [];
	if (roles.includes("owner")) return "owner";
	if (roles.includes("admin")) return "admin";
	return roles.length > 0 ? "member" : "unknown";
}
