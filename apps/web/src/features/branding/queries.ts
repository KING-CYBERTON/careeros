import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMembers } from "@/features/organization/queries";
import { orpc } from "@/libs/orpc/client";

// CAREEROS (P2-T07): data hooks for Settings → Branding and Domains. Every call is made for the session's own
// organization; no hook passes an organization id.

/** Whether the signed-in user may open the branding screens. Used only to show, hide and guard UI: the API decides. */
export function useBrandingAccess(): { status: "loading" | "allowed" | "denied" } {
	const { data, isLoading, error } = useMembers();
	if (isLoading) return { status: "loading" };
	const role = data?.me?.role;
	if (error || !role) return { status: "denied" };
	// Better Auth keeps several roles as a comma separated list.
	const roles = role.split(",").map((value) => value.trim());
	return { status: roles.includes("owner") || roles.includes("admin") ? "allowed" : "denied" };
}

export function useBranding() {
	return useQuery(orpc.branding.get.queryOptions());
}

export function useDomainInfo() {
	return useQuery(orpc.organizationDomain.info.queryOptions());
}

export function useDomains() {
	return useQuery({
		...orpc.organizationDomain.list.queryOptions(),
		// A domain waiting on DNS or a certificate changes without anyone touching the page.
		refetchInterval: (query) =>
			query.state.data?.some((d) => d.status === "pending" || d.status === "verified") ? 30_000 : false,
	});
}

export function useBrandingMutations() {
	const queryClient = useQueryClient();
	const key = orpc.branding.get.queryKey();
	const refresh = () => queryClient.invalidateQueries({ queryKey: key });
	type Stored = NonNullable<ReturnType<typeof useBranding>["data"]>;

	const update = useMutation(
		orpc.branding.update.mutationOptions({
			// Optimistic: the form shows the saved values at once; a failure puts the stored ones back.
			onMutate: async (patch) => {
				await queryClient.cancelQueries({ queryKey: key });
				const previous = queryClient.getQueryData<Stored>(key);
				if (previous)
					queryClient.setQueryData<Stored>(key, {
						...previous,
						...(Object.fromEntries(
							Object.entries(patch).filter(([, value]) => value !== undefined),
						) as Partial<Stored>),
					});
				return { previous };
			},
			onError: (_error, _patch, context) => {
				if (context?.previous) queryClient.setQueryData(key, context.previous);
			},
			onSuccess: (data) => queryClient.setQueryData(key, data),
			onSettled: refresh,
		}),
	);
	const uploadLogo = useMutation(orpc.branding.uploadLogo.mutationOptions({ onSettled: refresh }));
	const uploadFavicon = useMutation(orpc.branding.uploadFavicon.mutationOptions({ onSettled: refresh }));
	const deleteLogo = useMutation(orpc.branding.deleteLogo.mutationOptions({ onSettled: refresh }));
	const deleteFavicon = useMutation(orpc.branding.deleteFavicon.mutationOptions({ onSettled: refresh }));
	return { update, uploadLogo, uploadFavicon, deleteLogo, deleteFavicon };
}

export function useDomainMutations() {
	const queryClient = useQueryClient();
	const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.organizationDomain.list.queryKey() });
	return {
		add: useMutation(orpc.organizationDomain.add.mutationOptions({ onSettled: refresh })),
		recheck: useMutation(orpc.organizationDomain.recheck.mutationOptions({ onSettled: refresh })),
		remove: useMutation(orpc.organizationDomain.remove.mutationOptions({ onSettled: refresh })),
	};
}
