import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { buildPlunkRequest, idempotencyHeader, PlunkError, sendWithPlunk } from "./plunk";

// P6-T02: the Plunk client against a mocked fetch. No real network.

const config = {
	apiUrl: "https://plunk.example.test",
	secretKey: "sk_unit_test_key",
	fromAddress: "no-reply@example.test",
};
const message = { to: "reader@example.test", subject: "Hello", html: "<p>Hi</p>" };

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const ok = (emailId = "email_abc123") =>
	Response.json({ success: true, data: { emails: [{ contact: "c_1", email: emailId, status: "queued" }] } });
const failure = (status: number, code = "SOME_CODE", requestId = "req_42") =>
	Response.json(
		{ success: false, error: { code, message: "do not log me", statusCode: status, requestId } },
		{ status },
	);

const sent = () => {
	const [url, init] = fetchMock.mock.calls[0] ?? [];
	return {
		url: String(url),
		init: init as RequestInit,
		headers: new Headers((init as RequestInit).headers),
		body: JSON.parse((init as RequestInit).body as string) as Record<string, unknown>,
	};
};

describe("request shape", () => {
	it("posts to /v1/send with a bearer key and the documented JSON body", async () => {
		fetchMock.mockResolvedValue(ok());
		const result = await sendWithPlunk(config, { ...message, fromName: "Acme Careers", replyTo: "help@acme.example" });
		expect(result).toEqual({ emailId: "email_abc123", duplicate: false });
		const call = sent();
		expect(call.url).toBe("https://plunk.example.test/v1/send");
		expect(call.init.method).toBe("POST");
		expect(call.headers.get("authorization")).toBe("Bearer sk_unit_test_key");
		expect(call.headers.get("content-type")).toBe("application/json");
		expect(call.body).toEqual({
			to: "reader@example.test",
			subject: "Hello",
			body: "<p>Hi</p>",
			from: { name: "Acme Careers", email: "no-reply@example.test" },
			reply: "help@acme.example",
			subscribed: false,
		});
	});

	it("uses the field name reply, never replyTo, and leaves it out when unset or unsafe", () => {
		expect(buildPlunkRequest(config, message)).not.toHaveProperty("reply");
		expect(buildPlunkRequest(config, message)).not.toHaveProperty("replyTo");
		expect(buildPlunkRequest(config, { ...message, replyTo: "a@b.c\r\nBcc: x@y.z" })).not.toHaveProperty("reply");
		expect(buildPlunkRequest(config, { ...message, replyTo: "A <a@b.c>" })).not.toHaveProperty("reply");
	});

	it("builds the sender from the cleaned display name and falls back to the platform name", () => {
		expect(buildPlunkRequest(config, { ...message, fromName: '"x\r\nBcc: a@b.c<>' }).from).toEqual({
			name: "xBcc: a@b.c",
			email: "no-reply@example.test",
		});
		expect(buildPlunkRequest(config, { ...message, fromName: '"<>' }).from.name).toBe("CareerOS");
		expect(buildPlunkRequest(config, message).from.name).toBe("CareerOS");
	});

	it("never subscribes the recipient", () => {
		expect(buildPlunkRequest(config, message).subscribed).toBe(false);
	});

	it("gives the request a 10 second timeout signal", async () => {
		fetchMock.mockResolvedValue(ok());
		const timeout = vi.spyOn(AbortSignal, "timeout");
		await sendWithPlunk(config, message);
		expect(timeout).toHaveBeenCalledWith(10_000);
		expect(sent().init.signal).toBeInstanceOf(AbortSignal);
	});
});

describe("idempotency key", () => {
	it("is the sha256 of a stable key, so the same key is the same header", async () => {
		fetchMock.mockResolvedValue(ok());
		await sendWithPlunk(config, { ...message, idempotencyKey: "career-key-1" });
		await sendWithPlunk(config, { ...message, idempotencyKey: "career-key-1" });
		const first = new Headers(((fetchMock.mock.calls[0]?.[1] ?? {}) as RequestInit).headers).get("idempotency-key");
		const second = new Headers(((fetchMock.mock.calls[1]?.[1] ?? {}) as RequestInit).headers).get("idempotency-key");
		expect(first).toBe(createHash("sha256").update("career-key-1").digest("hex"));
		expect(second).toBe(first);
	});

	it("is random for a message without a stable key", () => {
		const a = idempotencyHeader();
		const b = idempotencyHeader();
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(a).not.toBe(b);
	});

	it("treats a 409 (key already used) as already sent", async () => {
		fetchMock.mockResolvedValue(new Response("{}", { status: 409 }));
		await expect(sendWithPlunk(config, { ...message, idempotencyKey: "k" })).resolves.toEqual({
			emailId: undefined,
			duplicate: true,
		});
	});
});

describe("error mapping", () => {
	it.each([
		[402, "plan_limit"],
		[429, "rate_limited"],
		[500, "server_error"],
		[503, "server_error"],
		[400, "rejected"],
		[401, "rejected"],
		[422, "rejected"],
	])("maps HTTP %i to %s and keeps only status, code and request id", async (status, kind) => {
		fetchMock.mockResolvedValue(failure(status));
		const error = await sendWithPlunk(config, message).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(PlunkError);
		expect(error).toMatchObject({ kind, status, code: "SOME_CODE", requestId: "req_42" });
	});

	it("does not leak the key, the body, the address or Plunk's message in the error", async () => {
		fetchMock.mockResolvedValue(failure(401));
		const error = (await sendWithPlunk(config, message).catch((caught: unknown) => caught)) as PlunkError;
		const text = `${error.message} ${error.stack ?? ""} ${JSON.stringify(error)}`;
		expect(text).not.toContain("sk_unit_test_key");
		expect(text).not.toContain("reader@example.test");
		expect(text).not.toContain("<p>Hi</p>");
		expect(text).not.toContain("do not log me");
	});

	it("drops a code or request id outside the safe alphabet", async () => {
		fetchMock.mockResolvedValue(failure(400, "bad code with spaces & <html>", "x".repeat(200)));
		const error = (await sendWithPlunk(config, message).catch((caught: unknown) => caught)) as PlunkError;
		expect(error.code).toBeUndefined();
		expect(error.requestId).toBeUndefined();
	});

	it("survives an error body that is not JSON", async () => {
		fetchMock.mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 }));
		await expect(sendWithPlunk(config, message)).rejects.toMatchObject({ kind: "server_error", status: 502 });
	});

	it("maps a timeout and a connection failure without keeping their text", async () => {
		fetchMock.mockRejectedValueOnce(
			new DOMException("The operation timed out for reader@example.test", "TimeoutError"),
		);
		await expect(sendWithPlunk(config, message)).rejects.toMatchObject({ kind: "timeout", status: 0 });
		fetchMock.mockRejectedValueOnce(new TypeError("fetch failed: connect ECONNREFUSED sk_unit_test_key"));
		const error = (await sendWithPlunk(config, message).catch((caught: unknown) => caught)) as PlunkError;
		expect(error).toMatchObject({ kind: "network", status: 0 });
		expect(error.message).not.toContain("sk_unit_test_key");
	});

	it("does not retry", async () => {
		fetchMock.mockResolvedValue(failure(500));
		await expect(sendWithPlunk(config, message)).rejects.toBeInstanceOf(PlunkError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("still succeeds when Plunk's 2xx body cannot be read", async () => {
		fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
		await expect(sendWithPlunk(config, message)).resolves.toEqual({ emailId: undefined, duplicate: false });
	});
});
