import { useQuery } from "@tanstack/react-query";
import { useMembers } from "@/features/organization/queries";
import { orpc } from "@/libs/orpc/client";

// CAREEROS (P3-T08): data hooks for the Org Admin area. Every call is made for the session's own organization; no hook
// passes an organization id. The access hook below only shows, hides and guards UI: the API decides.

export type OrgAdminAccess = "loading" | "allowed" | "denied";

/** Owners and admins of an organization that is not a personal workspace. */
export function useOrgAdminAccess(): OrgAdminAccess {
	const members = useMembers();
	const entitlements = useQuery(orpc.organization.entitlements.queryOptions());
	if (members.isLoading || entitlements.isLoading) return "loading";
	const roles = members.data?.me?.role.split(",").map((value) => value.trim()) ?? [];
	const isAdmin = roles.includes("owner") || roles.includes("admin");
	return isAdmin && entitlements.data !== undefined && entitlements.data.planId !== "personal" ? "allowed" : "denied";
}

export function useCohorts(includeArchived = false) {
	return useQuery(orpc.orgAdmin.cohorts.list.queryOptions({ input: { includeArchived } }));
}

export type CohortOption = { id: string; name: string };

/** Every member of the organization with their cohort, 50 per page (the server's page size). */
export function useAdminMembers(page: number, cohortId?: string) {
	return useQuery(orpc.orgAdmin.members.list.queryOptions({ input: { page, ...(cohortId ? { cohortId } : {}) } }));
}
