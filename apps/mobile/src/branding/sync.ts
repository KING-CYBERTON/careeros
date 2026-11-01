// CAREEROS (P2-T02, D10): after sign-in, finds the organization behind the server address and applies its branding.
// The organization comes from the server (`organizationHost.status` answers with the slug of the host's organization);
// the phone never picks one. On the platform server that call answers NOT_FOUND and the platform brand stays.
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { DEFAULT_BRAND } from "@reactive-resume/utils/brand";
import { brandFromPublic } from "./brand";
import { applyStoredBrand, resetBrand, setBrand, storeBrand } from "./store";
import { orpc } from "@/api/client";
import { useSession } from "@/auth/session";

type ErrorWithCode = { code?: unknown } | null;
const isNotFound = (error: ErrorWithCode) => error?.code === "NOT_FOUND";

/** Mounted once in the root layout, inside the query client. */
export function useBrandingSync() {
	const { status, server } = useSession();
	const signedIn = status === "signed-in";

	const host = useQuery({
		...orpc.organizationHost.status.queryOptions({ retry: false }),
		queryKey: [...orpc.organizationHost.status.key(), server],
		enabled: signedIn,
		retry: false,
		staleTime: 5 * 60_000,
	});
	const slug = host.data?.slug ?? "";
	const branding = useQuery({
		...orpc.branding.publicBySlug.queryOptions({ input: { slug }, retry: false }),
		queryKey: [...orpc.branding.publicBySlug.key({ input: { slug } }), server],
		enabled: signedIn && slug !== "",
		retry: false,
		staleTime: 5 * 60_000,
	});

	// The last brand seen on this server shows at once, before the answer arrives, and stays on the sign-in screen after
	// a sign-out (it is public data). A fresh answer replaces it.
	useEffect(() => {
		applyStoredBrand(server);
	}, [server]);

	useEffect(() => {
		if (!signedIn) return;
		if (branding.data) {
			const brand = brandFromPublic(branding.data, server);
			setBrand(brand);
			storeBrand(server, brand);
		} else if (host.isError && isNotFound(host.error as ErrorWithCode)) {
			// The platform server (or an address that stopped belonging to an organization).
			resetBrand();
			storeBrand(server, DEFAULT_BRAND);
		}
	}, [signedIn, server, branding.data, host.isError, host.error]);
}
