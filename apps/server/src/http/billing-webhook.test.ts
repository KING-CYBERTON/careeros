import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { handleBillingWebhook } from "./billing-webhook";

// P3-T04: the webhook adapter's gates, with the billing feature replaced: host, rate limit, size cap and the mapping of
// outcomes to status codes. The real signature check and database work are in billing-webhook.integration.test.ts.

const limit = vi.hoisted(() => vi.fn<(kind: string, client: string) => Promise<boolean>>());
const process_ = vi.hoisted(() => vi.fn());
vi.mock("@reactive-resume/api/features/billing", () => ({
	consumeBillingLimit: limit,
	processBillingWebhook: process_,
}));

const platform = { kind: "platform" } as const;
const request = (body: BodyInit | null = "{}", headers: Record<string, string> = {}) =>
	new Request("https://app.example.test/api/billing/webhook/fake", { method: "POST", body, headers });

beforeEach(() => {
	limit.mockReset().mockResolvedValue(true);
	process_.mockReset().mockResolvedValue({ kind: "ok", outcome: "applied", reason: null, eventId: "evt_1" });
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("billing webhook adapter", () => {
	it("refuses every host but the platform, before the rate limit and before reading the body", async () => {
		for (const host of [
			{
				kind: "org",
				organizationId: "o",
				slug: "s",
				via: "subdomain",
				hostname: "s.example.test",
				origin: "https://s.example.test",
			},
			{
				kind: "org",
				organizationId: "o",
				slug: "s",
				via: "custom",
				hostname: "jobs.example.test",
				origin: "https://jobs.example.test",
			},
			{ kind: "unknown", matchesOrgPattern: false },
		] as const) {
			const response = await handleBillingWebhook(request(), host, "fake", "203.0.113.9");
			expect(response.status).toBe(404);
		}
		expect(limit).not.toHaveBeenCalled();
		expect(process_).not.toHaveBeenCalled();
	});

	it("answers 429 with Retry-After when the budget is spent, and does not process", async () => {
		limit.mockResolvedValue(false);
		const response = await handleBillingWebhook(request(), platform, "fake", "203.0.113.9");
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("60");
		expect(limit).toHaveBeenCalledWith("webhook", "203.0.113.9");
		expect(process_).not.toHaveBeenCalled();
	});

	it("answers 413 above 256 KB, by the declared length and by the bytes actually sent", async () => {
		const declared = await handleBillingWebhook(
			request("{}", { "content-length": String(256 * 1024 + 1) }),
			platform,
			"fake",
			"c",
		);
		expect(declared.status).toBe(413);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(200 * 1024));
				controller.enqueue(new Uint8Array(100 * 1024));
				controller.close();
			},
		});
		const undeclared = new Request("https://app.example.test/api/billing/webhook/fake", {
			method: "POST",
			body: stream,
			duplex: "half",
		} as RequestInit);
		expect((await handleBillingWebhook(undeclared, platform, "fake", "c")).status).toBe(413);
		expect(process_).not.toHaveBeenCalled();
	});

	it.each([
		[{ kind: "bad_signature" }, 400, { code: "BAD_SIGNATURE" }],
		[{ kind: "bad_payload" }, 400, { code: "BAD_PAYLOAD" }],
		[{ kind: "ignored" }, 200, { received: true, outcome: "ignored" }],
		[{ kind: "not_found" }, 404, { defined: false, code: "NOT_FOUND", status: 404, message: "Not found" }],
		[{ kind: "ok", outcome: "duplicate", reason: null, eventId: "e" }, 200, { received: true, outcome: "duplicate" }],
		[{ kind: "ok", outcome: "applied", reason: null, eventId: "e" }, 200, { received: true, outcome: "applied" }],
	])("maps %j to %i", async (result, status, body) => {
		process_.mockResolvedValue(result);
		const response = await handleBillingWebhook(request(), platform, "fake", "c");
		expect(response.status).toBe(status);
		expect(await response.json()).toEqual(body);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("answers 500 for a processing error without leaking its message", async () => {
		process_.mockRejectedValue(new Error("secret internal detail with card 4242"));
		const response = await handleBillingWebhook(request(), platform, "fake", "c");
		expect(response.status).toBe(500);
		expect(JSON.stringify(await response.json())).not.toContain("secret internal");
	});

	it("hands the provider the raw bytes and the headers exactly as received", async () => {
		const bytes = new TextEncoder().encode('{"a": 1,  "b":2}');
		await handleBillingWebhook(request(bytes, { "x-fake-signature": "t=1,v1=abc" }), platform, "fake", "c");
		const [provider, body, headers] = process_.mock.calls[0] as [string, Uint8Array, Headers];
		expect(provider).toBe("fake");
		expect(Buffer.from(body).toString()).toBe('{"a": 1,  "b":2}');
		expect(headers.get("x-fake-signature")).toBe("t=1,v1=abc");
	});
});
