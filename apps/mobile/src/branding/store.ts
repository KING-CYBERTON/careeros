// CAREEROS (P2-T02, D10): the brand in force on the phone. `getBrand()` (packages/utils) reads `globalThis.__BRAND__`, so
// every screen that already calls it picks the organization's name and links up as soon as this store sets it; screens
// that must redraw on a change use `useBrand()`. The last brand per server is kept on the device (it is public data), so
// the sign-in screen after a sign-out still shows the organization's name, logo and colour.
import type { BrandInfo } from "@reactive-resume/utils/brand";
import Storage from "expo-sqlite/kv-store";
import { useSyncExternalStore } from "react";
import { DEFAULT_BRAND } from "@reactive-resume/utils/brand";
import { brandFromPublic, type PublicBrandingData } from "./brand";

const listeners = new Set<() => void>();
const storageKey = (server: string) => `brand:${server}`;

const brandGlobal = globalThis as { __BRAND__?: BrandInfo };
let current: BrandInfo = DEFAULT_BRAND;

function publish(next: BrandInfo) {
	if (JSON.stringify(next) === JSON.stringify(current)) return;
	current = next;
	if (next === DEFAULT_BRAND) delete brandGlobal.__BRAND__;
	else brandGlobal.__BRAND__ = next;
	for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

/** Makes `brand` the brand of the app. */
export function setBrand(brand: BrandInfo): void {
	publish(brand);
}

/** Makes the brand last seen on `server` the brand of the app, until a fresh answer arrives. */
export function applyStoredBrand(server: string): void {
	publish(readStoredBrand(server));
}

/** Back to the platform default (platform server, or no organization). */
export function resetBrand(): void {
	publish(DEFAULT_BRAND);
}

/** The brand in force; redraws the caller when it changes. */
export function useBrand(): BrandInfo {
	return useSyncExternalStore(subscribe, () => current);
}

const parsed = new Map<string, { raw: string | null; brand: BrandInfo }>();

/** The brand last seen on `server`, or the default. Same object while the stored text is unchanged. */
function readStoredBrand(server: string): BrandInfo {
	let raw: string | null = null;
	try {
		raw = Storage.getItemSync(storageKey(server));
	} catch {
		// Unreadable storage reads as no stored brand.
	}
	const hit = parsed.get(server);
	if (hit && hit.raw === raw) return hit.brand;
	let brand: BrandInfo = DEFAULT_BRAND;
	if (raw) {
		try {
			// Stored from `brandFromPublic`; checked again on the way out, since storage is outside the app's control.
			const value = JSON.parse(raw) as PublicBrandingData;
			if (typeof value.appName === "string") brand = brandFromPublic(value, server);
		} catch {
			// A damaged entry reads as none.
		}
	}
	parsed.set(server, { raw, brand });
	return brand;
}

export function storeBrand(server: string, brand: BrandInfo): void {
	try {
		if (brand === DEFAULT_BRAND || JSON.stringify(brand) === JSON.stringify(DEFAULT_BRAND))
			Storage.removeItemSync(storageKey(server));
		else Storage.setItemSync(storageKey(server), JSON.stringify(brand));
	} catch {
		// The brand is a convenience; without storage it is fetched again after the next sign-in.
	}
	for (const listener of listeners) listener();
}

/** The brand last seen on `server`, for screens shown before a session exists (sign-in). */
export function useStoredBrand(server: string): BrandInfo {
	return useSyncExternalStore(
		subscribe,
		() => readStoredBrand(server),
		() => DEFAULT_BRAND,
	);
}
