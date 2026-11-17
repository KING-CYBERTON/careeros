import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { authClient } from "@/libs/auth/client";

/** Reads a Better Auth client result, throwing its error so TanStack Query reports it. */
export function unwrap<T>(result: { data: T | null; error: unknown }): T {
	if (result.error || result.data === null) throw result.error ?? new Error("Empty response");
	return result.data;
}

/** The organization the session acts in. The server resolves and checks it on every request. */
export function useActiveOrganizationId(): string | null {
	const { session } = useRouteContext({ from: "/dashboard" });
	return session.session.activeOrganizationId ?? null;
}

export const organizationKeys = {
	list: (userId: string) => ["organization", userId, "list"] as const,
	members: (organizationId: string | null) => ["organization", organizationId, "members"] as const,
	invitations: (organizationId: string | null) => ["organization", organizationId, "invitations"] as const,
};

/** Every organization the signed-in user belongs to. */
export function useOrganizations() {
	const { session } = useRouteContext({ from: "/dashboard" });
	return useQuery({
		queryKey: organizationKeys.list(session.user.id),
		queryFn: async () => unwrap(await authClient.organization.list()),
	});
}

/** The members of the active organization, with the signed-in user's own row. */
export function useMembers() {
	const { session } = useRouteContext({ from: "/dashboard" });
	const organizationId = useActiveOrganizationId();
	return useQuery({
		queryKey: organizationKeys.members(organizationId),
		enabled: organizationId !== null,
		queryFn: async () => {
			const { members } = unwrap(await authClient.organization.listMembers({ query: { limit: 100 } }));
			return { members, me: members.find((member) => member.userId === session.user.id) };
		},
	});
}

/** Whether the signed-in user is an owner or admin of the active organization. Used only to show or hide UI. */
export function useCanManageMembers(): boolean {
	const { data } = useMembers();
	const role = data?.me?.role;
	return role === "owner" || role === "admin";
}
