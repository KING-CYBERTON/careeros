import { describe, expect, it } from "vite-plus/test";
import {
	brandPreviewVars,
	contrastRatio,
	ensureContrast,
	isHexColor,
	isHttpsUrl,
	isSingleEmailAddress,
	mixHex,
	readableForeground,
	relativeLuminance,
} from "./brand";

describe("isHexColor", () => {
	it("accepts only #rrggbb", () => {
		expect(isHexColor("#1a2b3c")).toBe(true);
		expect(isHexColor("#ABCDEF")).toBe(true);
		for (const value of ["#abc", "1a2b3c", "red", "#1a2b3cff", "#1a2b3c;}", "", null, 5])
			expect(isHexColor(value)).toBe(false);
	});
});

describe("contrast", () => {
	it("matches the WCAG reference values", () => {
		expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
		expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
		expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
		expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
		expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
	});
});

describe("readableForeground", () => {
	it("picks white on dark and black on light backgrounds", () => {
		expect(readableForeground("#000000")).toBe("#ffffff");
		expect(readableForeground("#1a2b3c")).toBe("#ffffff");
		expect(readableForeground("#337344")).toBe("#ffffff");
		expect(readableForeground("#ffffff")).toBe("#000000");
		expect(readableForeground("#ffd400")).toBe("#000000");
		expect(readableForeground("#f8f7f3")).toBe("#000000");
	});

	it("never falls below 4.5:1 for any colour on a coarse grid", () => {
		for (let r = 0; r <= 255; r += 15)
			for (let g = 0; g <= 255; g += 15)
				for (let b = 0; b <= 255; b += 15) {
					const hex = `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
					expect(contrastRatio(hex, readableForeground(hex))).toBeGreaterThanOrEqual(4.5);
				}
	});

	it("is case-insensitive and rejects anything but #rrggbb", () => {
		expect(readableForeground("#FFD400")).toBe("#000000");
		expect(() => readableForeground("red")).toThrow(RangeError);
		expect(() => readableForeground("#fff")).toThrow(RangeError);
	});
});

describe("mixHex", () => {
	it("blends in sRGB and clamps the weight", () => {
		expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
		expect(mixHex("#102030", "#ffffff", 0)).toBe("#102030");
		expect(mixHex("#102030", "#ffffff", 2)).toBe("#ffffff");
	});
});

describe("ensureContrast", () => {
	it("leaves a colour that already passes alone", () => {
		expect(ensureContrast("#000000", "#ffffff", 4.5)).toBe("#000000");
	});

	it("darkens on a light background and lightens on a dark one until the minimum is met", () => {
		const onLight = ensureContrast("#7fd0a0", "#f0f8f2", 4.5);
		expect(contrastRatio(onLight, "#f0f8f2")).toBeGreaterThanOrEqual(4.5);
		const onDark = ensureContrast("#1a3520", "#100f0c", 3);
		expect(contrastRatio(onDark, "#100f0c")).toBeGreaterThanOrEqual(3);
	});
});

describe("accentTokens", () => {
	it("keeps the primary on the light desk and reaches the contrast targets in both themes", async () => {
		const { accentTokens } = await import("./brand");
		for (const primary of ["#1a56db", "#ffd400", "#0b0b0b", "#f8f7f3", "#337344"]) {
			const { light, dark } = accentTokens(primary);
			expect(light.accent).toBe(primary);
			expect(contrastRatio(light.accent, light.onAccent)).toBeGreaterThanOrEqual(4.5);
			expect(contrastRatio(light.accentText, light.accentSoft)).toBeGreaterThanOrEqual(4.5);
			expect(contrastRatio(dark.accent, "#100f0c")).toBeGreaterThanOrEqual(3);
			expect(contrastRatio(dark.accent, dark.onAccent)).toBeGreaterThanOrEqual(4.5);
			expect(contrastRatio(dark.accentText, dark.accentSoft)).toBeGreaterThanOrEqual(4.5);
		}
	});
});

describe("isSingleEmailAddress", () => {
	it("accepts one bare address", () => {
		expect(isSingleEmailAddress("help@example.com")).toBe(true);
		expect(isSingleEmailAddress("first.last+tag@sub.example.co")).toBe(true);
	});

	it("rejects names, lists, headers and anything but exactly one at-sign", () => {
		for (const bad of [
			"",
			"a",
			"@b.c",
			"a@",
			"a@b@c.d",
			"A <a@b.c>",
			"<a@b.c>",
			"a@b.c, d@e.f",
			"a@b.c; d@e.f",
			"a b@c.d",
			"a@b.c\r\nBcc: x@y.z",
			"a@b.c\nBcc: x@y.z",
			"a\t@b.c",
			`${"a".repeat(251)}@b.c`,
		])
			expect(isSingleEmailAddress(bad)).toBe(false);
		expect(isSingleEmailAddress(undefined)).toBe(false);
	});
});

// CAREEROS (P2-T07)
describe("branding settings helpers", () => {
	it("checks https links the way the API does", () => {
		expect(isHttpsUrl("https://acme.example/help")).toBe(true);
		for (const bad of [
			"http://acme.example",
			"https://user:pw@acme.example",
			"javascript:alert(1)",
			"https://",
			"",
			null,
		])
			expect(isHttpsUrl(bad)).toBe(false);
	});

	it("builds the preview variables from valid colours only", () => {
		const vars = brandPreviewVars("#1A56DB", "#ffcc00");
		expect(vars["--accent"]).toBe("#1a56db");
		expect(vars["--on-accent"]).toBe("#ffffff");
		expect(vars["--brand-secondary"]).toBe("#ffcc00");
		expect(vars["--brand-on-secondary"]).toBe("#000000");
		expect(brandPreviewVars("red", null)).toEqual({});
	});
});
