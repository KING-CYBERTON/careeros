import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EMAIL_WEBHOOK_MAX_BYTES, handleEmailWebhook, suppressionFromPayload } from "./email-webhook";

// P6-T02: the Plunk webhook adapter's gates and payload reading, with the suppression list and the rate limiter replaced.
// The real database writes are in email-webhook.integration.test.ts.

const SECRET = "s".repeat(40);
const envMock = vi.hoisted(() => ({ PLUNK_WEBHOOK_SECRET: undefined as string | undefined }));
const limit = vi.hoisted(() => vi.fn<(client: string) => Promise<boolean>>());
const suppress = vi.hoisted(() => vi.fn());
vi.mock("@reactive-resume/env/server", () => ({ env: envMock }));
vi.mock("@reactive-resume/api/features/email", () => ({ consumeEmailWebhookLimit: limit }));
vi.mock("@reactive-resume/email/suppression", () => ({ suppressEmail: suppress }));

const platform = { kind: "platform" } as const;
const permanentBounce = {
	event: "email.bounce",
	bounceType: "Permanent",
	contact: { email: "Gone@Example.com" },
	email: { id: "email_1" },
};
const request = (body: BodyInit | null = JSON.stringify(permanentBounce), headers: Record<string, string> = {}) =>
	new Request("https://app.example.test/api/email/webhook/plunk", {
		method: "POST",
		body,
		headers: { "x-careeros-webhook-secret": SECRET, ...headers },
	});

beforeEach(() => {
	envMock.PLUNK_WEBHOOK_SECRET = SECRET;
	limit.mockReset().mockResolvedValue(true);
	suppress.mockReset().mockResolvedValue(undefined);
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("email webhook gates", () => {
	it("refuses every host but the platform before the rate limit", async () => {
		for (const host of [
			{
				kind: "org",
				organizationId: "o",
				slug: "s",
				via: "subdomain",
				hostname: "s.example.test",
				origin: "https://s.example.test",
			},
			{ kind: "unknown", matchesOrgPattern: false },
		] as const)
			expect((await handleEmailWebhook(request(), host, "203.0.113.9")).status).toBe(404);
		expect(limit).not.toHaveBeenCalled();
		expect(suppress).not.toHaveBeenCalled();
	});

	it("answers 429 with Retry-After when the budget is spent", async () => {
		limit.mockResolvedValue(false);
		const response = await handleEmailWebhook(request(), platform, "203.0.113.9");
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("60");
		expect(limit).toHaveBeenCalledWith("203.0.113.9");
	});

	it("answers 401 for a missing or wrong secret and does not read the body", async () => {
		const body = new ReadableStream<Uint8Array>({
			pull() {
				throw new Error("the body must not be read");
			},
		});
		const missing = new Request("https://app.example.test/api/email/webhook/plunk", {
			method: "POST",
			body,
			duplex: "half",
		} as RequestInit);
		expect((await handleEmailWebhook(missing, platform, "c")).status).toBe(401);
		for (const wrong of ["", "x", SECRET.slice(0, -1), `${SECRET}x`, SECRET.toUpperCase()])
			expect(
				(await handleEmailWebhook(request(undefined, { "x-careeros-webhook-secret": wrong }), platform, "c")).status,
			).toBe(401);
		expect(suppress).not.toHaveBeenCalled();
	});

	it("answers 404 when no secret is configured, even if the header is empty", async () => {
		envMock.PLUNK_WEBHOOK_SECRET = undefined;
		expect((await handleEmailWebhook(request(), platform, "c")).status).toBe(404);
		expect(suppress).not.toHaveBeenCalled();
	});

	it("answers 413 above 64 KB, by the declared length and by the bytes sent", async () => {
		const declared = await handleEmailWebhook(
			request("{}", { "content-length": String(EMAIL_WEBHOOK_MAX_BYTES + 1) }),
			platform,
			"c",
		);
		expect(declared.status).toBe(413);
		const big = await handleEmailWebhook(request("x".repeat(EMAIL_WEBHOOK_MAX_BYTES + 1)), platform, "c");
		expect(big.status).toBe(413);
		expect(suppress).not.toHaveBeenCalled();
	});

	it("answers 400 for a body that is not JSON", async () => {
		expect((await handleEmailWebhook(request("not json"), platform, "c")).status).toBe(400);
	});

	it("suppresses a permanent bounce with the address, reason and email id, and logs no address", async () => {
		const response = await handleEmailWebhook(request(), platform, "c");
		expect(response.status).toBe(200);
		expect(suppress).toHaveBeenCalledWith("Gone@Example.com", "bounce", "email_1");
		expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain("example.com");
	});

	it("answers 200 and does nothing for a transient bounce, a delivery and an unknown event", async () => {
		for (const payload of [
			{ ...permanentBounce, bounceType: "Transient" },
			{ ...permanentBounce, bounceType: undefined },
			{ event: "email.delivery", contact: { email: "a@b.com" } },
			{ event: "email.open", contact: { email: "a@b.com" } },
			[1, 2],
			"string",
		]) {
			const response = await handleEmailWebhook(request(JSON.stringify(payload)), platform, "c");
			expect(response.status).toBe(200);
		}
		expect(suppress).not.toHaveBeenCalled();
	});

	it("answers 500 when the list cannot be written, without the address in the log", async () => {
		suppress.mockRejectedValue(new Error("down for Gone@Example.com"));
		expect((await handleEmailWebhook(request(), platform, "c")).status).toBe(500);
		expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("Gone@Example.com");
	});
});

describe("suppressionFromPayload", () => {
	it("reads a complaint", () => {
		expect(suppressionFromPayload({ event: "email.complaint", contact: { email: "a@b.com" } })).toEqual({
			reason: "complaint",
			address: "a@b.com",
			providerEmailId: undefined,
		});
	});

	it("reads fields that sit under data and is case-insensitive about the bounce type", () => {
		expect(
			suppressionFromPayload({
				type: "email.bounce",
				data: { bounceType: "permanent", contact: { email: " a@b.com " }, emailId: "e_2" },
			}),
		).toEqual({ reason: "bounce", address: "a@b.com", providerEmailId: "e_2" });
	});

	it("needs an address and drops an email id outside the safe alphabet", () => {
		expect(suppressionFromPayload({ event: "email.complaint", contact: {} })).toBeNull();
		expect(suppressionFromPayload({ event: "email.complaint", contact: { email: "no-at-sign" } })).toBeNull();
		expect(
			suppressionFromPayload({ event: "email.complaint", contact: { email: "a@b.com" }, email: { id: "bad id!" } })
				?.providerEmailId,
		).toBeUndefined();
	});
});
