import { describe, expect, it, vi } from "vite-plus/test";
import { authorizedRequest, callApi, readFlow, readSession, type Session } from "./session";

const session: Session = { origin: "https://careers.example.org", token: "cos_clip_secret", userName: "Ada" };
const connected = "https://careers.example.org";

describe("readSession", () => {
	it("reads a stored sign-in", () => {
		expect(readSession(session, [])).toEqual(session);
	});
	it("treats anything malformed, or an origin not in normal form, as signed out", () => {
		expect(readSession(undefined, [])).toBeNull();
		expect(readSession({ ...session, token: "" }, [])).toBeNull();
		expect(readSession({ ...session, origin: "https://careers.example.org/x" }, [])).toBeNull();
		expect(readSession({ ...session, origin: "http://careers.example.org" }, [])).toBeNull();
	});
});

describe("readFlow", () => {
	const flow = { origin: connected, deviceCode: "d", userCode: "ABCD2345", interval: 5, expiresAt: 10 };
	it("reads a stored flow and rejects a bad one", () => {
		expect(readFlow(flow, [])).toEqual(flow);
		expect(readFlow({ ...flow, interval: "5" }, [])).toBeNull();
		expect(readFlow({ ...flow, origin: "https://evil.test/path" }, [])).toBeNull();
	});
});

describe("authorizedRequest: the token goes only to the origin it belongs to", () => {
	it("attaches the token to a request for the stored origin", () => {
		const request = authorizedRequest(session, connected, `${connected}/api/openapi/clipper/whoami`);
		expect(request).not.toBeNull();
		expect(new Headers(request?.init.headers).get("authorization")).toBe("Bearer cos_clip_secret");
		expect(request?.init).toMatchObject({ credentials: "omit", redirect: "error" });
	});

	it.each([
		["another host", "https://evil.test/api/openapi/clipper/whoami"],
		["a lookalike host", "https://careers.example.org.evil.test/api"],
		["a different scheme", "http://careers.example.org/api"],
		["a different port", "https://careers.example.org:8443/api"],
		["a user-info trick", "https://careers.example.org@evil.test/api"],
		["not a URL", "/relative/path"],
	])("refuses %s", (_name, url) => {
		expect(authorizedRequest(session, connected, url)).toBeNull();
	});

	it("refuses when the extension is connected to a different organization than the token's", () => {
		expect(authorizedRequest(session, "https://other.example.org", `${connected}/api`)).toBeNull();
	});
});

describe("callApi", () => {
	it("never calls fetch when the request must not carry the token", async () => {
		const fetcher = vi.fn();
		const result = await callApi(session, "https://other.example.org", "/api/x", {}, fetcher as never);
		expect(result).toEqual({ ok: false, reason: "refused" });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("reports a 401 so the caller clears the token", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
		expect(await callApi(session, connected, "/api/x", {}, fetcher as never)).toEqual({
			ok: false,
			reason: "unauthorized",
		});
	});

	it("returns the data of a success and reports an unreachable server", async () => {
		const ok = vi.fn().mockResolvedValue(new Response(JSON.stringify({ name: "Ada" }), { status: 200 }));
		expect(await callApi(session, connected, "/api/x", {}, ok as never)).toEqual({ ok: true, data: { name: "Ada" } });
		const down = vi.fn().mockRejectedValue(new TypeError("offline"));
		expect(await callApi(session, connected, "/api/x", {}, down as never)).toEqual({
			ok: false,
			reason: "unreachable",
		});
	});
});
