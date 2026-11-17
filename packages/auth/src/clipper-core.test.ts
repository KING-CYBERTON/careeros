import { describe, expect, it } from "vite-plus/test";
import {
	CLIPPER_TOKEN_PREFIX,
	TOKEN_LIFETIME_MS,
	TOKEN_SLIDE_WINDOW_MS,
	deviceLabel,
	generateClipperToken,
	hashClipperToken,
	hostMatchesOrganization,
	isClipperTokenFormat,
	nextClipperExpiry,
	normalizeUserCode,
} from "./clipper-core";

const DAY = 24 * 60 * 60 * 1000;

describe("clipper token", () => {
	it("is prefixed, 256 bits, unique and recognized by its shape", () => {
		const a = generateClipperToken();
		const b = generateClipperToken();
		expect(a.startsWith(CLIPPER_TOKEN_PREFIX)).toBe(true);
		expect(a).not.toBe(b);
		expect(isClipperTokenFormat(a)).toBe(true);
		expect(isClipperTokenFormat("cos_clip_short")).toBe(false);
		expect(isClipperTokenFormat("eyJhbGciOi.jwt.value")).toBe(false);
		expect(isClipperTokenFormat(`${a}x`)).toBe(false);
	});

	it("hashes to a stable hex digest that does not contain the token", () => {
		const token = generateClipperToken();
		const hash = hashClipperToken(token);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(hash).toBe(hashClipperToken(token));
		expect(hash).not.toContain(token.slice(CLIPPER_TOKEN_PREFIX.length));
	});
});

describe("sliding expiry", () => {
	const now = Date.UTC(2026, 10, 2);
	it("keeps the expiry while more than 30 days remain", () => {
		const expiresAt = now + 60 * DAY;
		expect(nextClipperExpiry(now, expiresAt)).toBe(expiresAt);
	});
	it("gives 90 days again once 30 days or fewer remain", () => {
		expect(nextClipperExpiry(now, now + TOKEN_SLIDE_WINDOW_MS)).toBe(now + TOKEN_LIFETIME_MS);
		expect(nextClipperExpiry(now, now + DAY)).toBe(now + TOKEN_LIFETIME_MS);
	});
	it("refuses an expired token", () => {
		expect(nextClipperExpiry(now, now)).toBeNull();
		expect(nextClipperExpiry(now, now - DAY)).toBeNull();
	});
	it("lives 90 days", () => {
		expect(TOKEN_LIFETIME_MS).toBe(90 * DAY);
	});
});

describe("host binding", () => {
	it("accepts any host of the token's organization", () => {
		expect(hostMatchesOrganization({ kind: "org", organizationId: "org-a" }, "org-a")).toBe(true);
	});
	it("refuses the platform host, another organization, an unknown host and no host", () => {
		expect(hostMatchesOrganization({ kind: "platform" }, "org-a")).toBe(false);
		expect(hostMatchesOrganization({ kind: "org", organizationId: "org-b" }, "org-a")).toBe(false);
		expect(hostMatchesOrganization({ kind: "unknown" }, "org-a")).toBe(false);
		expect(hostMatchesOrganization(undefined, "org-a")).toBe(false);
		expect(hostMatchesOrganization({ kind: "org", organizationId: "" }, "")).toBe(false);
	});
});

describe("device label", () => {
	it("names the browser and system", () => {
		expect(
			deviceLabel(
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
			),
		).toBe("Chrome on Windows");
		expect(
			deviceLabel(
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
			),
		).toBe("Edge on macOS");
	});
	it("falls back for an unknown or missing user agent", () => {
		expect(deviceLabel(undefined)).toBe("Browser extension");
		expect(deviceLabel("curl/8")).toBe("Browser extension");
	});
});

describe("user code", () => {
	it("is normalized the way the plugin stores it", () => {
		expect(normalizeUserCode("abcd-2345")).toBe("ABCD2345");
	});
});
