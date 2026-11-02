import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readConnection, releaseStrayOrigins } from "./storage";

const stored = (overrides: Record<string, unknown> = {}) => ({
	origin: "https://careers.example.org",
	orgName: "Acme Careers",
	logoUrl: "https://careers.example.org/logo.png",
	primaryColor: "#c8283c",
	...overrides,
});

describe("readConnection", () => {
	it("reads a stored connection", () => {
		expect(readConnection(stored(), [])).toEqual(stored());
	});

	it("treats nothing, or the wrong type, as not connected", () => {
		expect(readConnection(undefined, [])).toBeNull();
		expect(readConnection("https://careers.example.org", [])).toBeNull();
		expect(readConnection(stored({ orgName: "" }), [])).toBeNull();
		expect(readConnection(stored({ origin: 5 }), [])).toBeNull();
	});

	it("treats an origin that is not in normal form as not connected", () => {
		expect(readConnection(stored({ origin: "https://careers.example.org/path" }), [])).toBeNull();
		expect(readConnection(stored({ origin: "http://careers.example.org" }), [])).toBeNull();
		expect(readConnection(stored({ origin: "https://CAREERS.example.org" }), [])).toBeNull();
	});

	it("drops a logo from another origin and a colour that is not #rrggbb", () => {
		const result = readConnection(stored({ logoUrl: "https://evil.test/logo.png", primaryColor: "red" }), []);
		expect(result).toEqual(stored({ logoUrl: null, primaryColor: null }));
	});
});

describe("releaseStrayOrigins", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("gives back every host permission that is held", async () => {
		const remove = vi.fn().mockResolvedValue(true);
		vi.stubGlobal("chrome", {
			permissions: { getAll: vi.fn().mockResolvedValue({ origins: ["https://careers.example.org/*"] }), remove },
		});
		await releaseStrayOrigins();
		expect(remove).toHaveBeenCalledExactlyOnceWith({ origins: ["https://careers.example.org/*"] });
	});

	it("does nothing when no host permission is held", async () => {
		const remove = vi.fn();
		vi.stubGlobal("chrome", { permissions: { getAll: vi.fn().mockResolvedValue({}), remove } });
		await releaseStrayOrigins();
		expect(remove).not.toHaveBeenCalled();
	});

	it("does not throw when the browser refuses", async () => {
		vi.stubGlobal("chrome", { permissions: { getAll: vi.fn().mockRejectedValue(new Error("no")), remove: vi.fn() } });
		await expect(releaseStrayOrigins()).resolves.toBeUndefined();
	});
});
