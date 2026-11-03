import type { FeatureFlags } from "@reactive-resume/api/features/flags";
import type { AuthSession } from "@reactive-resume/auth/types";
import type { QueryClient } from "@tanstack/react-query";
import { getSession } from "./auth/session";
import { getLocale, loadLocale } from "./locale";
import { client } from "./orpc/client";
import { getTheme } from "./theme";

export const sessionQueryKey = ["auth", "session"] as const;
const flagsQueryKey = ["flags"] as const;

// CAREEROS (P3-T02, phase plan D4): the organization's resolved features and status, next to the server flags. The key
// carries the active organization, so switching organization asks the server again; the short stale time lets a plan
// or status change show up within seconds. The server is the guard either way: this only decides what the UI shows.
export const entitlementsQueryKey = (organizationId: string) =>
	["organization", "entitlements", organizationId] as const;

export type OrganizationFlags = {
	planId: string;
	status: "trial" | "active" | "past_due" | "suspended";
	/** True while the organization is suspended: members can view and export, not write. */
	readOnly: boolean;
	seatLimit: number | null;
	seatsUsed: number;
};

/** The router context `flags`: the server's flags plus the organization's resolved feature map. */
export type RootFlags = FeatureFlags & {
	/** Every feature key resolved for the active organization (empty when there is none or it could not be read). */
	features: Record<string, boolean>;
	organization: OrganizationFlags | null;
};

async function loadOrganizationFlags(
	queryClient: QueryClient,
	session: AuthSession | null,
): Promise<Pick<RootFlags, "features" | "organization">> {
	const organizationId = session?.session.activeOrganizationId;
	if (!organizationId) return { features: {}, organization: null };
	try {
		const entitlements = await queryClient.query({
			queryKey: entitlementsQueryKey(organizationId),
			queryFn: () => client.organization.entitlements(),
			staleTime: 30_000,
		});
		return {
			features: entitlements.features,
			organization: {
				planId: entitlements.planId,
				status: entitlements.status,
				readOnly: entitlements.readOnly,
				seatLimit: entitlements.seatLimit,
				seatsUsed: entitlements.seatsUsed,
			},
		};
	} catch {
		// A failed read hides nothing the server would allow and grants nothing: features are off until it succeeds.
		return { features: {}, organization: null };
	}
}

// Root beforeLoad runs on every navigation and every hover preload, so the network reads come from the query cache.
// A signed-in session is reused for a minute; a signed-out one is always re-checked, so signing in elsewhere shows up
// on the next navigation. Anything that signs in, signs out or edits the profile invalidates `sessionQueryKey` before
// calling `router.invalidate()`. Flags come from server env and only change on a restart.
export async function loadRootContext(queryClient: QueryClient) {
	const theme = getTheme();
	const locale = getLocale();

	const sessionPromise = queryClient
		.query({
			queryKey: sessionQueryKey,
			queryFn: getSession,
			staleTime: (query) => (query.state.data ? 60_000 : 0),
		})
		.catch((error: unknown) => {
			const cached = queryClient.getQueryData<AuthSession | null>(sessionQueryKey);
			if (cached) {
				console.warn("[session] Failed to refresh session, retaining cached session:", error);
				return cached;
			}
			throw error;
		});

	const [session, serverFlags] = await Promise.all([
		sessionPromise,
		queryClient.query({ queryKey: flagsQueryKey, queryFn: () => client.flags.get(), staleTime: 5 * 60_000 }),
		loadLocale(locale),
	]);

	// CAREEROS (P3-T02): needs the session's active organization, so it follows the session read.
	const flags: RootFlags = { ...serverFlags, ...(await loadOrganizationFlags(queryClient, session)) };
	return { theme, locale, session, flags };
}
