// CAREEROS (P2-T07, Q95): the branding of the server address before anyone has signed in. The sign-in screen asks the
// server (`GET /branding/host`, public) and keeps the answer on the device, so the very first sign-in is already branded.
// The organization is the server's own resolution of the host; the phone never names one.
import type { BrandInfo } from "@reactive-resume/utils/brand";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { DEFAULT_BRAND } from "@reactive-resume/utils/brand";
import { brandFromPublic, type PublicBrandingData } from "./brand";
import { storeBrand } from "./store";

const TIMEOUT_MS = 8000;

/** The public branding of `origin`'s own address, or `null` when the server doesn't answer or isn't one of ours. */
export async function fetchHostBranding(origin: string): Promise<PublicBrandingData | null> {
	try {
		const response = await fetch(`${origin}/api/openapi/branding/host`, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!response.ok) return null;
		const body: unknown = await response.json();
		return body && typeof body === "object" ? (body as PublicBrandingData) : null;
	} catch {
		return null;
	}
}

/** An organization's brand from the host lookup; the platform default (all fields null) is the default brand. */
export function brandFromHostBranding(data: PublicBrandingData, server: string): BrandInfo {
	return typeof data.appName === "string" ? brandFromPublic(data, server) : DEFAULT_BRAND;
}

/** Asks the server for its address's branding and stores it, so `useStoredBrand(server)` shows it. */
export function useHostBranding(server: string): void {
	const query = useQuery({
		queryKey: ["branding", "host", server],
		queryFn: () => fetchHostBranding(server),
		staleTime: 5 * 60_000,
		retry: false,
	});
	useEffect(() => {
		// A failed lookup keeps whatever was stored; only an answer replaces it.
		if (query.data) storeBrand(server, brandFromHostBranding(query.data, server));
	}, [query.data, server]);
}
