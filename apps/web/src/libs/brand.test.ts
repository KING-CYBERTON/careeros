import { afterEach, describe, expect, it } from "vite-plus/test";
import { PLATFORM_DEFAULT_APP_NAME } from "@reactive-resume/utils/brand";
import { getBrand } from "./brand";

const brandGlobal = globalThis as { __BRAND__?: unknown };

afterEach(() => {
	delete brandGlobal.__BRAND__;
});

describe("getBrand", () => {
	it("falls back to the platform default when nothing is injected", () => {
		expect(getBrand()).toEqual({ appName: PLATFORM_DEFAULT_APP_NAME });
	});

	it("uses window.__BRAND__ when present", () => {
		brandGlobal.__BRAND__ = { appName: "Acme Careers", logoUrl: "https://acme.test/logo.svg" };
		expect(getBrand()).toEqual({ appName: "Acme Careers", logoUrl: "https://acme.test/logo.svg" });
	});

	it("ignores an injected brand without a usable app name", () => {
		brandGlobal.__BRAND__ = { appName: "  " };
		expect(getBrand().appName).toBe(PLATFORM_DEFAULT_APP_NAME);
	});
});
