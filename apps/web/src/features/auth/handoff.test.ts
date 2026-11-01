// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://localhost:3000"}

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	beginOrganizationHandoff,
	captureRedeemFragment,
	isOrganizationHost,
	parseRedeemFragment,
	redeemOrganizationHandoff,
	resetCapturedFragment,
} from "./handoff";

// P2-T05: the browser side of the sign-in handoff.

afterEach(() => {
	vi.unstubAllGlobals();
	resetCapturedFragment();
	window.history.replaceState(null, "", "/");
});

describe("isOrganizationHost", () => {
	const flags = { appUrl: "https://app.example.test", aliasUrl: "https://alias.example.test" };

	it("is false on the platform address and its alias", () => {
		expect(isOrganizationHost(flags, "https://app.example.test")).toBe(false);
		expect(isOrganizationHost(flags, "https://alias.example.test")).toBe(false);
	});

	it("is true on any other address", () => {
		expect(isOrganizationHost(flags, "https://acme.example.test")).toBe(true);
		expect(isOrganizationHost({ appUrl: flags.appUrl }, "https://alias.example.test")).toBe(true);
	});

	it("is false when the platform address is unknown", () => {
		expect(isOrganizationHost(undefined, "https://acme.example.test")).toBe(false);
		expect(isOrganizationHost({ appUrl: "not a url" }, "https://acme.example.test")).toBe(false);
	});
});

describe("parseRedeemFragment", () => {
	it("reads the token and the request id", () => {
		expect(parseRedeemFragment("#token=abc_DEF-1&request=req-1")).toEqual({ token: "abc_DEF-1", request: "req-1" });
		expect(parseRedeemFragment("token=a&request=b")).toEqual({ token: "a", request: "b" });
	});

	it.each(["", "#", "#token=a", "#request=b", "#token=&request=b", "#other=1"])("refuses %j", (hash) => {
		expect(parseRedeemFragment(hash)).toBeNull();
	});
});

describe("captureRedeemFragment", () => {
	it("removes the fragment from the address bar and keeps it for a second read", () => {
		window.history.replaceState(null, "", "/auth/handoff/redeem?x=1#token=secret-token&request=req-1");
		expect(captureRedeemFragment()).toEqual({ token: "secret-token", request: "req-1" });
		expect(window.location.hash).toBe("");
		expect(window.location.pathname + window.location.search).toBe("/auth/handoff/redeem?x=1");
		// A second pass (React runs effects twice in development) finds the same value.
		expect(captureRedeemFragment()).toEqual({ token: "secret-token", request: "req-1" });
	});

	it("returns null, and still clears the address, when there is no token", () => {
		window.history.replaceState(null, "", "/auth/handoff/redeem#nothing");
		expect(captureRedeemFragment()).toBeNull();
		expect(window.location.hash).toBe("");
	});
});

describe("calls", () => {
	const respond = (status: number, body: unknown) =>
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(body, { status })),
		);

	it("begin returns the platform URL, and 'unavailable' on a 404 so the caller signs in directly", async () => {
		respond(200, { url: "https://app.example.test/auth/handoff?request=r" });
		expect(await beginOrganizationHandoff("google", "/resumes")).toEqual({
			kind: "started",
			url: "https://app.example.test/auth/handoff?request=r",
		});
		respond(404, { code: "handoff_unavailable" });
		expect(await beginOrganizationHandoff("google", undefined)).toEqual({ kind: "unavailable" });
		respond(403, { code: "forbidden_origin" });
		expect(await beginOrganizationHandoff("google", undefined)).toEqual({ kind: "error" });
		respond(200, { nope: true });
		expect(await beginOrganizationHandoff("google", undefined)).toEqual({ kind: "error" });
	});

	it("begin sends only the provider and the return path, to this host", async () => {
		const fetchMock = vi.fn(async () => Response.json({ url: "https://app.example.test/auth/handoff?request=r" }));
		vi.stubGlobal("fetch", fetchMock);
		await beginOrganizationHandoff("github", "/resumes?x=1");
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("/api/careeros/handoff/begin");
		expect(init.credentials).toBe("same-origin");
		expect(JSON.parse(String(init.body))).toEqual({ provider: "github", returnTo: "/resumes?x=1" });
	});

	it("redeem returns the return path, and null for every failure", async () => {
		respond(200, { returnTo: "/resumes" });
		expect(await redeemOrganizationHandoff({ token: "t", request: "r" })).toBe("/resumes");
		respond(400, { code: "handoff_invalid" });
		expect(await redeemOrganizationHandoff({ token: "t", request: "r" })).toBeNull();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		expect(await redeemOrganizationHandoff({ token: "t", request: "r" })).toBeNull();
	});
});
