// CAREEROS (P3-T02, phase plan D3 and D4): what the organization's plan and status allow, as the phone shows it. The
// server is the guard on every call; this only explains why a call was refused and what is available. It matches the
// web app: the suspended banner, the "available on Pro" note for custom domains and the readable refusal messages.
import { t } from "@lingui/core/macro";
import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/api/client";
import { useSession } from "@/auth/session";
import { Banner } from "@/ui";

/** The organization's entitlements, keyed by server so one server's answer never carries over to another. */
export function useEntitlements() {
	const { server, status } = useSession();
	return useQuery({
		...orpc.organization.entitlements.queryOptions(),
		queryKey: [...orpc.organization.entitlements.key(), server],
		enabled: status === "signed-in",
		retry: false,
		staleTime: 30_000,
	});
}

/** The same text as the web banner, on the home screen, while the organization is suspended. */
export function SuspendedBanner() {
	const { data } = useEntitlements();
	if (!data?.readOnly) return null;
	return (
		<Banner
			tone="warn"
			icon="warning-circle"
			message={t`This organization is suspended. You can view and export your data. Contact your administrator.`}
		/>
	);
}
