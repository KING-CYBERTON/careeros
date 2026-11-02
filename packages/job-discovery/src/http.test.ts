import { describe, expect, it, vi } from "vite-plus/test";
import { ALLOWED_HOSTS, BOARD_HOSTS, fetchBoardJson, MAX_RESPONSE_BYTES, type FetchLike } from "./http";
import { greenhouse } from "./sources";
import { BoardFetchError } from "./types";

const URL_OK = greenhouse.buildUrl("acme");
const json = (body: unknown, init: ResponseInit = {}) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json; charset=utf-8" },
		...init,
	});
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });

/** A scripted transport: answers in order and records every URL asked for. */
function script(...answers: Array<Response | (() => Response | Promise<Response>)>) {
	const asked: string[] = [];
	const fetchImpl: FetchLike = async (input) => {
		asked.push(input);
		const next = answers.shift();
		if (!next) throw new Error("unexpected request");
		return typeof next === "function" ? next() : next;
	};
	return { fetchImpl, asked };
}

const failure = async (promise: Promise<unknown>) => {
	try {
		await promise;
	} catch (error) {
		return error as BoardFetchError;
	}
	throw new Error("expected a failure");
};

describe("the allow-list", () => {
	it("is exactly the four board API hosts", () => {
		expect([...ALLOWED_HOSTS].sort()).toEqual(
			["api.ashbyhq.com", "api.eu.lever.co", "api.lever.co", "boards-api.greenhouse.io"].sort(),
		);
		expect(Object.values(BOARD_HOSTS)).toHaveLength(4);
	});
});

describe("fetchBoardJson", () => {
	it("returns the parsed JSON and asks with redirect manual", async () => {
		const seen: Array<Parameters<FetchLike>[1]> = [];
		const fetchImpl: FetchLike = (_input, init) => {
			seen.push(init);
			return Promise.resolve(json({ jobs: [] }));
		};
		await expect(fetchBoardJson(URL_OK, { fetchImpl })).resolves.toEqual({ jobs: [] });
		expect(seen[0]?.redirect).toBe("manual");
	});

	it("follows a redirect to an allow-listed host, at most twice", async () => {
		const { fetchImpl, asked } = script(
			redirect("https://api.lever.co/v0/postings/a?mode=json"),
			redirect("https://api.eu.lever.co/v0/postings/a?mode=json"),
			json([{ ok: true }]),
		);
		await expect(fetchBoardJson(URL_OK, { fetchImpl })).resolves.toEqual([{ ok: true }]);
		expect(asked).toHaveLength(3);
	});

	it("refuses a third redirect", async () => {
		const hop = () => redirect("https://api.lever.co/v0/postings/a?mode=json");
		const { fetchImpl, asked } = script(hop, hop, hop, json({}));
		const error = await failure(fetchBoardJson(URL_OK, { fetchImpl }));
		expect(error.code).toBe("redirect_refused");
		expect(asked).toHaveLength(3);
	});

	it("follows a relative redirect on the same host", async () => {
		const { fetchImpl, asked } = script(redirect("/v1/boards/other/jobs?content=true"), json({ jobs: [] }));
		await fetchBoardJson(URL_OK, { fetchImpl });
		expect(asked[1]).toBe("https://boards-api.greenhouse.io/v1/boards/other/jobs?content=true");
	});

	it.each([
		["a host outside the allow-list", "https://evil.test/jobs"],
		["a private address", "https://10.0.0.5/jobs"],
		["the cloud metadata address", "https://169.254.169.254/latest/meta-data"],
		["loopback", "https://127.0.0.1/jobs"],
		["localhost", "https://localhost/jobs"],
		["an IPv6 loopback", "https://[::1]/jobs"],
		["plain http on an allowed host", "http://api.lever.co/v0/postings/a"],
		["credentials in the URL", "https://user:pass@api.lever.co/v0/postings/a"],
		["a custom port", "https://api.lever.co:8443/v0/postings/a"],
		["a look-alike host", "https://api.lever.co.evil.test/v0/postings/a"],
		["a host that only ends the same way", "https://evilapi.lever.co/v0/postings/a"],
		["a non-http scheme", "file:///etc/passwd"],
	])("refuses a redirect to %s and never asks for it", async (_name, target) => {
		const { fetchImpl, asked } = script(redirect(target), json({ leaked: true }));
		const error = await failure(fetchBoardJson(URL_OK, { fetchImpl }));
		expect(error).toBeInstanceOf(BoardFetchError);
		expect(error.code).toBe("redirect_refused");
		expect(asked).toEqual([URL_OK]);
	});

	it("refuses a redirect with no target", async () => {
		const { fetchImpl } = script(new Response(null, { status: 302 }));
		expect((await failure(fetchBoardJson(URL_OK, { fetchImpl }))).code).toBe("redirect_refused");
	});

	it("refuses to start from a host outside the allow-list", async () => {
		const { fetchImpl, asked } = script(json({}));
		const error = await failure(fetchBoardJson("https://evil.test/x", { fetchImpl }));
		expect(error.code).toBe("redirect_refused");
		expect(asked).toEqual([]);
	});

	it("records the status and a short reason for an error answer, never its body", async () => {
		const { fetchImpl } = script(
			new Response("SECRET INTERNAL TRACE", { status: 503, headers: { "content-type": "text/plain" } }),
		);
		const error = await failure(fetchBoardJson(URL_OK, { fetchImpl }));
		expect(error).toMatchObject({ code: "http_status", status: 503 });
		expect(error.message).not.toContain("SECRET");
	});

	it("refuses an answer that is not JSON", async () => {
		const { fetchImpl } = script(new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
		expect((await failure(fetchBoardJson(URL_OK, { fetchImpl }))).code).toBe("bad_content_type");
	});

	it("refuses JSON that does not parse, without quoting it", async () => {
		const { fetchImpl } = script(
			new Response("{ SECRET", { status: 200, headers: { "content-type": "application/json" } }),
		);
		const error = await failure(fetchBoardJson(URL_OK, { fetchImpl }));
		expect(error.code).toBe("invalid_json");
		expect(error.message).not.toContain("SECRET");
	});

	it("refuses a body past the cap, by declared length", async () => {
		const { fetchImpl } = script(
			new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json", "content-length": String(MAX_RESPONSE_BYTES + 1) },
			}),
		);
		expect((await failure(fetchBoardJson(URL_OK, { fetchImpl }))).code).toBe("too_large");
	});

	it("refuses a body past the cap even when it does not declare a length", async () => {
		const chunk = new Uint8Array(1024 * 1024).fill(32);
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				sent++;
				if (sent > 20) controller.close();
				else controller.enqueue(chunk);
			},
		});
		const { fetchImpl } = script(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
		const error = await failure(fetchBoardJson(URL_OK, { fetchImpl }));
		expect(error.code).toBe("too_large");
		// It stopped reading soon after the cap instead of draining the stream.
		expect(sent).toBeLessThan(10);
	});

	it("times out a board that never answers", async () => {
		const fetchImpl: FetchLike = (_input, init) =>
			new Promise<Response>((_resolve, reject) =>
				init.signal.addEventListener("abort", () => reject(init.signal.reason)),
			);
		const started = Date.now();
		const error = await failure(fetchBoardJson(URL_OK, { fetchImpl, timeoutMs: 50 }));
		expect(error.code).toBe("timeout");
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("times out a body that stalls after the headers", async () => {
		const body = new ReadableStream<Uint8Array>({ start() {} });
		const { fetchImpl } = script(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
		const error = await failure(fetchBoardJson(URL_OK, { fetchImpl, timeoutMs: 50 }));
		expect(error.code).toBe("timeout");
	});

	it("reports a transport failure with a fixed reason that does not repeat the transport's message", async () => {
		const fetchImpl: FetchLike = () => Promise.reject(new Error("connect ECONNREFUSED 10.1.2.3:443"));
		const error = await failure(fetchBoardJson(URL_OK, { fetchImpl }));
		expect(error.code).toBe("network");
		expect(error.message).not.toContain("10.1.2.3");
	});
});

describe("the default transport (fetchPublic)", () => {
	// These use the real fetchPublic. The target is on a test-only allow-list, so only fetchPublic's own check can
	// refuse it, and it refuses before any socket opens.
	it.each([
		"https://127.0.0.1/x",
		"https://localhost/x",
		"https://10.1.2.3/x",
		"https://[::1]/x",
		"https://169.254.169.254/x",
	])("refuses a private address: %s", async (target) => {
		const host = new URL(target).hostname;
		const error = await failure(fetchBoardJson(target, { allowedHosts: new Set([host]), timeoutMs: 2000 }));
		expect(error).toBeInstanceOf(BoardFetchError);
		expect(error.code).toBe("network");
	});
});

describe("the transport is fetchPublic unless a test passes its own", () => {
	it("calls fetchPublic with the board URL", async () => {
		vi.resetModules();
		const fetchPublic = vi.fn(() => Promise.resolve(json({ jobs: [] })));
		vi.doMock("@reactive-resume/utils/url-security.node", () => ({ fetchPublic }));
		const { fetchBoardJson: fresh } = await import("./http");
		await fresh(URL_OK);
		expect(fetchPublic).toHaveBeenCalledTimes(1);
		expect((fetchPublic.mock.calls[0] as unknown[])[0]).toBe(URL_OK);
		vi.doUnmock("@reactive-resume/utils/url-security.node");
		vi.resetModules();
	});
});
