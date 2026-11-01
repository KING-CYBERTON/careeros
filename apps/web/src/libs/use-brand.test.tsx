// @vitest-environment happy-dom

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { PLATFORM_DEFAULT_APP_NAME } from "@reactive-resume/utils/brand";
import { useBrand } from "./use-brand";

const brandGlobal = globalThis as { __BRAND__?: unknown };

afterEach(() => {
	delete brandGlobal.__BRAND__;
});

// CAREEROS (P2-T02): the server puts the organization's brand on window.__BRAND__ before the app boots.
describe("useBrand", () => {
	it("reads the values the server injected", () => {
		brandGlobal.__BRAND__ = {
			appName: "Acme Careers",
			logoUrl: "/api/branding-assets/org_acme/logo.png",
			primaryColor: "#1a56db",
			font: "Inter",
		};
		const { result } = renderHook(() => useBrand());
		expect(result.current).toEqual({
			appName: "Acme Careers",
			logoUrl: "/api/branding-assets/org_acme/logo.png",
			primaryColor: "#1a56db",
			font: "Inter",
		});
	});

	it("falls back to the platform default without an injected brand", () => {
		const { result } = renderHook(() => useBrand());
		expect(result.current).toEqual({ appName: PLATFORM_DEFAULT_APP_NAME });
	});
});
