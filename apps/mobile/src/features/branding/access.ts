// CAREEROS (P2-T07): whether the signed-in user manages the organization, for showing the Branding and Domains rows.
// The phone has no role list, so it asks an owner-or-admin-only call (`settings.get`): the server answers FORBIDDEN to a
// member. This only decides what the UI offers; every branding and domain call is checked by the API again.
import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/api/client";
import { useSession } from "@/auth/session";

export type AdminStatus = "loading" | "allowed" | "denied";

export const adminStatus = (query: { isPending: boolean; isSuccess: boolean }): AdminStatus =>
	query.isPending ? "loading" : query.isSuccess ? "allowed" : "denied";

export function useOrganizationAdmin(): AdminStatus {
	const { server, status } = useSession();
	const query = useQuery({
		...orpc.settings.get.queryOptions(),
		queryKey: [...orpc.settings.get.key(), server],
		enabled: status === "signed-in",
		retry: false,
		staleTime: 5 * 60_000,
	});
	return status === "signed-in" ? adminStatus(query) : "loading";
}
